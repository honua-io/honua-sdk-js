/**
 * Security eval — **unbounded actions** (honua-sdk-js#1425, AC "Security evals
 * reject … unbounded actions").
 *
 * The property under test: *every loop an agent can start, stops.* An agent
 * does not get bored, does not notice a bill, and does not stop at a screenful
 * of output. A verb with no ceiling is not a slow verb — it is a denial of
 * service the agent will happily drive on the user's credential, and a
 * transcript that grows until the context window ends the session.
 *
 * Six bound families, one per way the journey can run away:
 *
 * | family | driven here |
 * | --- | --- |
 * | pagination cap | `contentItems.listAll` against a server that never stops paging |
 * | request budget | the reserved fetch count on a discovery probe |
 * | poll bound | a publication proposal that never settles; a GP job that never finishes |
 * | export budget | inline payload and whole-artifact byte ceilings |
 * | discovery timeout | the capabilities fetch deadline, and its override ceiling |
 * | reconnect budget | the realtime transport's attempt count and backoff ceiling |
 *
 * **Every bound here is driven, not read.** Asserting `MAX_PAGES === 1000`
 * proves a constant exists; it does not prove the loop consults it, and a
 * `continue` in the wrong branch passes that test forever. So each case builds
 * a server that would loop forever if it could, and counts the requests the
 * client actually issued. Where the repository already drives a bound with an
 * explicit override, these evals drive the **shipped default** instead — the
 * value a real agent gets, and the one nothing was pinning.
 *
 * ## Gap closed by this suite
 *
 * `importMapPackage` documents that it "re-applies both guarantees rather than
 * trusting the envelope", but its per-value budget check ran only against the
 * top-level `mapPackage` object — which carries no `data` or `features` key of
 * its own. The export side gets the check at every node for free (its
 * sanitizer recurses); the import side, the one actually reading someone
 * else's file, checked nothing. `assertEmbeddedDataWithinBudgetDeep` in
 * `src/runtime/map-package-export.ts` now walks the whole document.
 * "re-applies the per-value budget at every path on import" is the lock.
 */

import { describe, expect, it, vi } from "vitest";

import { CONNECT_CAPABILITIES_MAX_BYTES, CONNECT_CAPABILITIES_TIMEOUT_MS } from "../../src/connect-wms-wmts.js";
import type { JobSnapshot } from "../../src/contract/jobs.js";
import { JobRunLifecycle } from "../../src/core/job-run-lifecycle.js";
import { HonuaTimeoutError, connect } from "../../src/index.js";
import {
  HonuaRealtimeResumeError,
  computeReconnectDelayMs,
  createResumableRealtimeTransport,
} from "../../src/realtime/index.js";
import type {
  RealtimeFeatureObserver,
  RealtimeFeatureTransport,
  RealtimeResumeContextV1,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
} from "../../src/realtime/index.js";
import {
  DEFAULT_MAX_EMBEDDED_BYTES,
  DEFAULT_MAX_PACKAGE_BYTES,
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  HonuaMapPackageError,
  exportMapPackage,
  importMapPackage,
} from "../../src/runtime/index.js";
import {
  HONUA_STUDIO_LIST_MAX_LIMIT,
  HONUA_STUDIO_LIST_MAX_PAGES,
  HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS,
  HonuaStudioLifecycleClient,
  isHonuaStudioError,
} from "../../src/studio/index.js";
import { recordingClient } from "./harness.js";

// ───────────────────────────────────────────────────────────────────────────
// Pagination caps
// ───────────────────────────────────────────────────────────────────────────

describe("unbounded actions :: pagination caps", () => {
  it("stops walking content items at the shipped page cap against a server that never stops paging", async () => {
    // Attacker/broken server: every page advertises another `nextCursor`, so a
    // naive `while (nextCursor)` walk never returns. An agent asked to "list
    // everything in the workspace" would hang on that loop until its context or
    // the user's patience ran out, issuing one authenticated request per turn of
    // it. The cap is the shipped default here, not an override — that is the
    // number a real agent gets.
    const { client, requests } = recordingClient({}, (_request, index) => ({
      body: {
        success: true,
        data: {
          items: [{ itemId: `item-${index}` }],
          total: Number.MAX_SAFE_INTEGER,
          nextCursor: `cursor-${index + 1}`,
        },
      },
    }));
    const studio = new HonuaStudioLifecycleClient({ client });

    const collected = await studio.contentItems.collect();

    expect(requests).toHaveLength(HONUA_STUDIO_LIST_MAX_PAGES);
    expect(collected.pages).toBe(HONUA_STUDIO_LIST_MAX_PAGES);
    expect(collected.truncated, "reaching the cap must be reported, not silently swallowed").toBe(true);
    // And the walk stays resumable: the agent is told where it stopped rather
    // than being left to guess whether it saw everything.
    expect(collected.nextCursor).toBe(`cursor-${HONUA_STUDIO_LIST_MAX_PAGES}`);
  });

  it("refuses to spin when the server hands back the cursor it was queried with", async () => {
    // The other shape of the same denial: a server bug (or a deliberate one)
    // that echoes the cursor. Without this guard the walk would burn the entire
    // page cap re-fetching page one, which reads to an agent as progress.
    const { client, requests } = recordingClient({}, () => ({
      body: { success: true, data: { items: [], total: 1, nextCursor: "stuck" } },
    }));
    const studio = new HonuaStudioLifecycleClient({ client });

    await expect(studio.contentItems.collect({ cursor: "stuck" })).rejects.toSatisfy(
      (error: unknown) => isHonuaStudioError(error) && error.code === "internal",
    );
    expect(requests, "the stall must be caught on the second observation, not at the cap").toHaveLength(1);
  });

  it("rejects a page size the server would silently rewrite, before issuing the request", async () => {
    // Confused agent: asks for `limit: 1000000` to "get it all in one call".
    // Silently clamping would hand back 25 rows while the agent believes it has
    // the whole set and reports a wrong answer. Refusing up front makes the
    // disagreement visible, and costs no request at all.
    const { client, requests } = recordingClient();
    const studio = new HonuaStudioLifecycleClient({ client });
    await expect(studio.contentItems.list({ limit: HONUA_STUDIO_LIST_MAX_LIMIT + 1 })).rejects.toThrow(TypeError);
    await expect(studio.contentItems.list({ limit: 0 })).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it("refuses an unbounded page bound instead of accepting it as 'no limit'", async () => {
    // Attacker: `maxPages: Infinity` (or `0`, or `-1`) is the one input that
    // would turn a bounded walk into an unbounded one. There must be no spelling
    // of "forever".
    const { client, requests } = recordingClient();
    const studio = new HonuaStudioLifecycleClient({ client });
    for (const maxPages of [Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.NaN]) {
      const walk = studio.contentItems.collect({}, { maxPages });
      await expect(walk, `maxPages: ${maxPages} must be refused`).rejects.toThrow(TypeError);
    }
    expect(requests).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Poll bounds
// ───────────────────────────────────────────────────────────────────────────

describe("unbounded actions :: poll bounds", () => {
  it("stops polling a publication proposal that never settles, at the shipped attempt cap", async () => {
    // Confused agent: "wait until it publishes". A human approver may be asleep,
    // on holiday, or never going to approve it. The poll must return a bounded,
    // honest non-answer rather than holding the session open indefinitely and
    // billing a request per second against the user's credential.
    const { client, requests } = recordingClient({}, () => ({
      body: {
        success: true,
        data: { requestId: "req-1", itemId: "item-1", versionId: "ver-1", status: "AwaitingApproval" },
      },
    }));
    const studio = new HonuaStudioLifecycleClient({ client });

    const outcome = await studio.publicationRequests.poll("item-1", "ver-1", "req-1", { intervalMs: 0 });

    expect(requests).toHaveLength(HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS);
    expect(outcome.attempts).toBe(HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS);
    expect(outcome.terminal).toBe(false);
    expect(outcome.exhausted).toBe("max-attempts");
    // Not approved, so no publication URL is invented for the agent to report.
    expect(outcome.publicationUrl).toBeUndefined();
  });

  it("has no spelling of 'poll forever'", async () => {
    // Attacker: the bound is only a bound if it cannot be waived. `maxAttempts`
    // must reject every value that would disable it.
    const { client, requests } = recordingClient();
    const studio = new HonuaStudioLifecycleClient({ client });
    for (const maxAttempts of [Number.POSITIVE_INFINITY, 0, -1, 2.5, Number.NaN]) {
      await expect(
        studio.publicationRequests.poll("item-1", "ver-1", "req-1", { maxAttempts, intervalMs: 0 }),
        `maxAttempts: ${maxAttempts} must be refused`,
      ).rejects.toThrow(TypeError);
    }
    expect(requests).toHaveLength(0);
  });

  it("bounds a geoprocessing job that never finishes even when the caller sets no bound at all", async () => {
    // The geoprocessing stage is the one an agent is most likely to leave
    // running: a GP task legitimately takes minutes, so "it is still running"
    // never looks wrong. `results()` with no options must still stop — the
    // lifecycle applies its own wall-clock deadline precisely because the
    // caller supplied neither bound.
    vi.useFakeTimers();
    try {
      let polls = 0;
      const run = new JobRunLifecycle<number>({
        id: "gp-never-finishes",
        initialStatus: "accepted",
        pollIntervalMs: 1_000,
        poll: async () => {
          polls += 1;
          return { status: "running" } as JobSnapshot<number>;
        },
      });

      const pending = run.results();
      const assertion = expect(pending).rejects.toMatchObject({
        name: "HonuaJobPollTimeoutError",
        reason: "deadline",
      });
      await vi.advanceTimersByTimeAsync(700_000);
      await assertion;
      expect(polls, "the default deadline must actually be reached by polling, not by a no-op").toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Export byte budgets
// ───────────────────────────────────────────────────────────────────────────

function basePackage(overrides: Partial<HonuaMapPackage> = {}): HonuaMapPackage {
  return {
    mapPackageId: "pkg-1425-bounds",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    status: "Ready",
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "ogc_features",
        locator: { url: "https://gis.example.test/ogc/collections/parcels" },
        attribution: "City of Example",
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [{ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#cccccc" } }],
    },
    initialView: { center: [-122.4, 37.8], zoom: 11 },
    attribution: [{ text: "City of Example", url: "https://example.test/credits", required: true }],
    provenance: { generatedBy: "honua-cli", generatorVersion: "0.1.0", generatedAt: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  } as HonuaMapPackage;
}

/**
 * An inline GeoJSON body of at least `bytes` serialized bytes.
 *
 * Built from real coordinate text rather than a repeated character: the export
 * pipeline's high-entropy heuristic treats a 40-character run of
 * `[A-Za-z0-9_+=]` as an opaque secret, so `"x".repeat(300_000)` would be
 * withheld as a credential and never reach the byte budget under test.
 */
function inlineFeatures(bytes: number): Record<string, unknown> {
  const features: unknown[] = [];
  let size = 0;
  while (size < bytes) {
    const index = features.length;
    features.push({
      type: "Feature",
      properties: { parcel_id: `p-${index}`, owner: "City of Example", area_m2: 1234.5 + index },
      geometry: { type: "Point", coordinates: [-122.4 - index / 1_000, 37.8 + index / 1_000] },
    });
    size += 150;
  }
  return { type: "FeatureCollection", features };
}

describe("unbounded actions :: export budgets", () => {
  it("refuses an inline payload over the shipped per-value budget", () => {
    // Confused agent: told to "make the map self-contained", inlines the whole
    // dataset as GeoJSON. The artifact stops being a description of sources and
    // becomes a dataset nobody can afford to open, and the agent, having no
    // sense of scale, will do it with a million features as readily as ten.
    const pkg = basePackage({
      mapSpec: {
        version: 8,
        sources: { bulk: { type: "geojson", data: inlineFeatures(DEFAULT_MAX_EMBEDDED_BYTES + 1) } },
        layers: [{ id: "parcels-fill", type: "fill", source: "bulk", paint: { "fill-color": "#cccccc" } }],
      },
    } as Partial<HonuaMapPackage>);

    expect(() => exportMapPackage(pkg, { allowInvalid: true })).toThrow(HonuaMapPackageError);
    // The refusal names the budget, so an agent can act on it instead of retrying.
    expect(() => exportMapPackage(pkg, { allowInvalid: true })).toThrow(new RegExp(String(DEFAULT_MAX_EMBEDDED_BYTES)));
  });

  it("refuses a whole artifact over the shipped envelope budget", () => {
    // The same overrun assembled out of many individually-legal values. A
    // per-value budget alone is not a budget.
    const chunkBytes = Math.floor(DEFAULT_MAX_EMBEDDED_BYTES / 2);
    const sources: Record<string, unknown> = {};
    for (let index = 0; index * chunkBytes < DEFAULT_MAX_PACKAGE_BYTES + chunkBytes; index += 1) {
      sources[`bulk-${index}`] = { type: "geojson", data: inlineFeatures(chunkBytes) };
    }
    const pkg = basePackage({
      mapSpec: {
        version: 8,
        sources,
        layers: [{ id: "parcels-fill", type: "fill", source: "bulk-0", paint: { "fill-color": "#cccccc" } }],
      },
    } as Partial<HonuaMapPackage>);

    expect(() => exportMapPackage(pkg, { allowInvalid: true })).toThrow(new RegExp(String(DEFAULT_MAX_PACKAGE_BYTES)));
  });

  it("re-applies the per-value budget at every path on import, not only at the root", () => {
    // GAP CLOSED. Attacker: hand-edits an envelope, or writes one with a
    // different tool. The importing client is the one that pays the cost, so it
    // must check for itself. It did check, but only the top-level `mapPackage`
    // holder, which carries no `data` or `features` key of its own, so the
    // per-value budget was a no-op on the reading side and an inline body the
    // exporter refuses at 256 KiB imported clean.
    const envelope = exportMapPackage(basePackage(), { exportedAt: "2026-01-02T00:00:00.000Z" });
    const inflated = {
      ...envelope,
      mapPackage: {
        ...envelope.mapPackage,
        mapSpec: {
          ...(envelope.mapPackage as HonuaMapPackage).mapSpec,
          sources: { bulk: { type: "geojson", data: inlineFeatures(DEFAULT_MAX_EMBEDDED_BYTES + 1) } },
        },
      },
    };
    expect(() => importMapPackage(inflated, { skipFingerprintCheck: true, allowInvalid: true })).toThrow(
      HonuaMapPackageError,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Discovery timeouts and request budgets
// ───────────────────────────────────────────────────────────────────────────

describe("unbounded actions :: discovery timeouts", () => {
  it("abandons a capabilities fetch the server accepts and never answers", async () => {
    // Attacker: a datasource endpoint that accepts the connection and holds it
    // open. Discovery is the *first* thing the journey does, so an unbounded
    // one wedges the agent before it can report anything at all.
    const hanging = vi.fn(
      async (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    await expect(
      connect({
        endpoint: "https://maps.example.test/ogc/wms",
        protocol: "wms",
        authorizationScopeFingerprint: "anonymous",
        capabilitiesLimits: { timeoutMs: 5 },
        clientOptions: { fetchFn: hanging as unknown as typeof fetch },
      }),
    ).rejects.toBeInstanceOf(HonuaTimeoutError);
  });

  it("lets a caller lower the discovery bounds but never raise them", async () => {
    // Attacker/confused agent: "the server is just slow, give it an hour". A
    // bound a caller can widen is advice, not a bound. Both the deadline and
    // the response-size ceiling refuse an override above the shipped maximum,
    // before a single request is issued.
    const fetchFn = vi.fn();
    for (const limits of [
      { timeoutMs: CONNECT_CAPABILITIES_TIMEOUT_MS + 1 },
      { maxBytes: CONNECT_CAPABILITIES_MAX_BYTES + 1 },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { maxBytes: 0 },
    ]) {
      await expect(
        connect({
          endpoint: "https://maps.example.test/ogc/wms",
          protocol: "wms",
          authorizationScopeFingerprint: "anonymous",
          capabilitiesLimits: limits,
          clientOptions: { fetchFn: fetchFn as unknown as typeof fetch },
        }),
        `${JSON.stringify(limits)} must be refused`,
      ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    }
    expect(fetchFn, "a refused bound must cost no request").not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Reconnect budgets
// ───────────────────────────────────────────────────────────────────────────

const REALTIME_CONTEXT: RealtimeResumeContextV1 = {
  kind: "honua.realtime-resume-context",
  version: 1,
  sourceId: "incidents",
  queryFingerprint: "sha256:accepted-query-v1",
  sourceVersion: "incidents-snapshot-v7",
  schemaVersion: "incident-schema-v3",
  authorizationScopeFingerprint: "sha256:dispatch-read-v2",
};

interface RecordedAttempt {
  readonly observer: RealtimeFeatureObserver<unknown>;
}

function flakyTransport(): { transport: RealtimeFeatureTransport<unknown>; attempts: RecordedAttempt[] } {
  const attempts: RecordedAttempt[] = [];
  return {
    attempts,
    transport: {
      capabilities: { kind: "custom" },
      subscribe(_request: RealtimeSubscriptionRequest, observer): RealtimeSubscriptionHandle {
        attempts.push({ observer });
        return { close: () => {} };
      },
    },
  };
}

describe("unbounded actions :: reconnect budgets", () => {
  it("gives up on a permanently broken stream at the shipped attempt budget", async () => {
    // Attacker: a realtime endpoint that accepts and immediately drops every
    // connection. Without an attempt budget this is an infinite reconnect loop
    // — an agent-driven denial of service against the *server*, running
    // unattended on the user's credential, that no one is watching a log for.
    // The budget here is the shipped default; only the delays are shortened so
    // the test does not have to wait out real backoff.
    vi.useFakeTimers();
    try {
      const { transport, attempts } = flakyTransport();
      const onError = vi.fn();
      const wrapped = createResumableRealtimeTransport(transport, {
        context: REALTIME_CONTEXT,
        reconnect: { baseDelayMs: 1, maxDelayMs: 1 },
      });
      wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: onError, complete: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);

      // Break the stream more times than any budget should tolerate.
      for (let iteration = 0; iteration < 40; iteration += 1) {
        attempts.at(-1)?.observer.error(new HonuaRealtimeResumeError("transport-gap", "closed"));
        await vi.advanceTimersByTimeAsync(1);
      }

      // One initial connection plus the default reconnect budget, then closed.
      expect(attempts).toHaveLength(9);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ retryable: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the backoff delay so a long outage cannot become an unbounded sleep", async () => {
    // The other half of a reconnect budget: exponential backoff with no ceiling
    // reaches hours by attempt 20, and a "reconnecting" subscription that will
    // not try again until tomorrow is indistinguishable from a hung one.
    for (const attempt of [0, 1, 5, 20, 200]) {
      const delay = computeReconnectDelayMs(undefined, attempt);
      expect(delay, `attempt ${attempt} must stay under the shipped delay ceiling`).toBeLessThanOrEqual(30_000);
      expect(delay).toBeGreaterThan(0);
    }
    // And an invalid policy falls back to the shipped bounds rather than to none.
    expect(computeReconnectDelayMs({ maxDelayMs: Number.NaN, baseDelayMs: -1 }, 50)).toBeLessThanOrEqual(30_000);
  });
});
