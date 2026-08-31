/**
 * Publication-proposal status client: canonical wire states plus the six-state
 * compatibility normalization, the
 * bounded/cancellable poll, the five joined identifiers, and the
 * separate-approver security rule.
 *
 * Uses the same `fetchImpl` capture harness as `lifecycle-client.test.ts`,
 * extended with a response *sequence* so a poll can be walked state by state.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HonuaClient, HonuaTimeoutError } from "../../src/index.js";
import * as studio from "../../src/studio/index.js";
import {
  HONUA_STUDIO_PUBLICATION_POLL_INTERVAL_MS,
  HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS,
  type HonuaStudioError,
  HonuaStudioLifecycleClient,
  HonuaStudioPublicationRequestsClient,
  STUDIO_PUBLICATION_LIFECYCLE_STATES,
  type StudioPublicationLifecycleState,
  type StudioPublicationRequest,
  createHonuaStudioLifecycleClient,
  isHonuaStudioError,
  isStudioPublicationActive,
  isStudioPublicationTerminal,
  normalizeStudioPublicationStatus,
  studioPublicationUrl,
} from "../../src/studio/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/studio-lifecycle");

interface LifecycleFixture {
  readonly request: { readonly method: string; readonly path: string; readonly body?: unknown };
  readonly response: { readonly status: number; readonly body?: unknown };
}

function fixture(name: string): LifecycleFixture {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8")) as LifecycleFixture;
}

function proposalOf(contract: LifecycleFixture): StudioPublicationRequest {
  return (contract.response.body as { data: StudioPublicationRequest }).data;
}

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
}

/**
 * Serves `contracts` one per fetch, holding on the last one once exhausted —
 * the shape a real poll sees as a proposal advances through its states.
 */
function clientForSequence(contracts: readonly LifecycleFixture[]): {
  client: HonuaStudioLifecycleClient;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const client = createHonuaStudioLifecycleClient({
    client: new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
        requests.push({ method: init?.method ?? "GET", url, body });
        const contract = contracts[Math.min(requests.length - 1, contracts.length - 1)] as LifecycleFixture;
        return new Response(contract.response.body === undefined ? null : JSON.stringify(contract.response.body), {
          status: contract.response.status,
        });
      },
    }),
  });
  return { client, requests };
}

/**
 * Serves `contracts` until request number `hangAtRequest`, which is then held
 * open until its `AbortSignal` fires — the shape of a `GET` honua-server
 * accepts and never answers. Only usable where the poll supplies a signal
 * (a caller `signal`, a `timeoutMs`, or both); otherwise it would hang the run.
 */
function clientForHangingSequence(
  contracts: readonly LifecycleFixture[],
  hangAtRequest: number,
): { client: HonuaStudioLifecycleClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const client = createHonuaStudioLifecycleClient({
    client: new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ method: init?.method ?? "GET", url, body: undefined });
        if (requests.length >= hangAtRequest) {
          return new Promise<Response>((_resolve, reject) => {
            const abort = (): void => {
              const error = new Error("The operation was aborted.");
              error.name = "AbortError";
              reject(error);
            };
            if (init?.signal?.aborted) {
              abort();
              return;
            }
            init?.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        const contract = contracts[Math.min(requests.length - 1, contracts.length - 1)] as LifecycleFixture;
        return new Response(contract.response.body === undefined ? null : JSON.stringify(contract.response.body), {
          status: contract.response.status,
        });
      },
    }),
  });
  return { client, requests };
}

function clientFor(contract: LifecycleFixture): { client: HonuaStudioLifecycleClient; requests: CapturedRequest[] } {
  return clientForSequence([contract]);
}

const ITEM = "item-parcels-1";
const VERSION = "version-parcels-1";
const REQUEST_ID = "publish-1";
const PROPOSAL_PATH = `/api/v1/studio/content-items/${ITEM}/versions/${VERSION}/publish-requests/${REQUEST_ID}`;

const STATE_FIXTURES: ReadonlyArray<[StudioPublicationLifecycleState, string]> = [
  ["AwaitingApproval", "publish-request-awaiting-approval.v1.json"],
  ["Approved", "publish-request-approved.v1.json"],
  ["Executing", "publish-request-executing.v1.json"],
  ["Active", "publish-request-active.v1.json"],
  ["Rejected", "publish-request-rejected.v1.json"],
  ["Failed", "publish-request-failed.v1.json"],
];

describe("publication-proposal state machine", () => {
  it("enumerates the six compatibility states in lifecycle order", () => {
    expect(STUDIO_PUBLICATION_LIFECYCLE_STATES).toEqual([
      "AwaitingApproval",
      "Approved",
      "Executing",
      "Active",
      "Rejected",
      "Failed",
    ]);
  });

  it.each(STUDIO_PUBLICATION_LIFECYCLE_STATES)("normalizes %s and its casing/separator variants", (state) => {
    const camel = `${state.charAt(0).toLowerCase()}${state.slice(1)}`;
    const kebab = state.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    for (const wire of [state, camel, kebab, kebab.replace(/-/g, "_"), state.toUpperCase()]) {
      expect(normalizeStudioPublicationStatus(wire), wire).toBe(state);
    }
  });

  it("maps the legacy synchronous statuses onto the canonical walk", () => {
    expect(normalizeStudioPublicationStatus("accepted")).toBe("Active");
    expect(normalizeStudioPublicationStatus("rejected")).toBe("Rejected");
    expect(normalizeStudioPublicationStatus("pending")).toBe("Executing");
  });

  it("returns undefined for a status this release does not recognize", () => {
    expect(normalizeStudioPublicationStatus("QuarantinedPendingSecurityReview")).toBeUndefined();
    expect(normalizeStudioPublicationStatus("")).toBeUndefined();
    expect(normalizeStudioPublicationStatus(undefined)).toBeUndefined();
  });

  it("treats only Active, Rejected and Failed as terminal, and only Active as successful", () => {
    for (const state of STUDIO_PUBLICATION_LIFECYCLE_STATES) {
      const terminal = state === "Active" || state === "Rejected" || state === "Failed";
      expect(isStudioPublicationTerminal(state), state).toBe(terminal);
      expect(isStudioPublicationActive(state), state).toBe(state === "Active");
    }
  });

  it("never treats an unknown status as terminal or as success", () => {
    expect(isStudioPublicationTerminal("QuarantinedPendingSecurityReview")).toBe(false);
    expect(isStudioPublicationActive("QuarantinedPendingSecurityReview")).toBe(false);
    expect(isStudioPublicationTerminal(undefined)).toBe(false);
    expect(isStudioPublicationActive(undefined)).toBe(false);
  });

  it("surfaces a final publication URL only from Active", () => {
    expect(studioPublicationUrl(proposalOf(fixture("publish-request-active.v1.json")))).toBe(
      "https://example.test/studio/parcels",
    );
    // Both of these fixtures carry a publicationUrl they have no right to.
    expect(studioPublicationUrl(proposalOf(fixture("publish-request-failed.v1.json")))).toBeUndefined();
    expect(studioPublicationUrl(proposalOf(fixture("publish-request-unknown-status.v1.json")))).toBeUndefined();
    expect(studioPublicationUrl(proposalOf(fixture("publish-request-rejected.v1.json")))).toBeUndefined();
    expect(studioPublicationUrl(undefined)).toBeUndefined();
  });
});

describe("publicationRequests.get", () => {
  it.each(STATE_FIXTURES)("retrieves a proposal in the %s state", async (state, file) => {
    const contract = fixture(file);
    const { client, requests } = clientForSequence([contract]);

    const proposal = await client.publicationRequests.get(ITEM, VERSION, REQUEST_ID);

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(requests[0]?.url.pathname).toBe(PROPOSAL_PATH);
    expect(normalizeStudioPublicationStatus(proposal.status)).toBe(state);
    expect(proposal.requestId).toBe(REQUEST_ID);
  });

  it("preserves all five joined identifiers end to end", async () => {
    const { client } = clientFor(fixture("publish-request-awaiting-approval.v1.json"));

    const proposal = await client.publicationRequests.get(ITEM, VERSION, REQUEST_ID);

    expect(proposal.operationInstanceId).toBe("opinst-3f2a9c14");
    expect(proposal.proposalId).toBe("proposal-7c41e0b8");
    expect(proposal.proposalUri).toBe(`https://example.test${PROPOSAL_PATH}`);
    expect(proposal.auditId).toBe("audit-91d5f6a2");
    expect(proposal.correlationId).toBe("corr-5b8e2d07");
    // proposalUri addresses the proposal, never the published artifact.
    expect(proposal.proposalUri).not.toBe(proposal.publicationUrl);
    expect(proposal.contentHash).toMatch(/^sha256:/);
  });

  it("throws not-found for a missing proposal", async () => {
    const contract = fixture("publish-request-get-not-found.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.publicationRequests.get(ITEM, VERSION, "publish-missing").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    expect((failure as HonuaStudioError).code).toBe("not-found");
    expect((failure as HonuaStudioError).statusCode).toBe(404);
  });

  it("throws forbidden when the proposal is outside the caller's owner/tenant scope", async () => {
    const contract = fixture("publish-request-forbidden.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.publicationRequests.get(ITEM, VERSION, REQUEST_ID).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    const error = failure as HonuaStudioError;
    expect(error.code).toBe("forbidden");
    expect(error.statusCode).toBe(403);
    expect(error.problem?.type).toBe("https://honua.io/problems/studio");
    expect(error.message).toContain("is not the owner");
  });
});

describe("publicationRequests.poll", () => {
  it("walks AwaitingApproval → Approved → Executing → Active and returns the final URL", async () => {
    const { client, requests } = clientForSequence([
      fixture("publish-request-awaiting-approval.v1.json"),
      fixture("publish-request-approved.v1.json"),
      fixture("publish-request-executing.v1.json"),
      fixture("publish-request-active.v1.json"),
    ]);
    const seen: Array<StudioPublicationLifecycleState | undefined> = [];

    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, {
      intervalMs: 0,
      onStatus: (_request, state) => seen.push(state),
    });

    expect(seen).toEqual(["AwaitingApproval", "Approved", "Executing", "Active"]);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.method === "GET" && request.url.pathname === PROPOSAL_PATH)).toBe(true);
    expect(outcome.state).toBe("Active");
    expect(outcome.terminal).toBe(true);
    expect(outcome.active).toBe(true);
    expect(outcome.attempts).toBe(4);
    expect(outcome.exhausted).toBeUndefined();
    expect(outcome.publicationUrl).toBe("https://example.test/studio/parcels");
    expect(outcome.request.proposalId).toBe("proposal-7c41e0b8");
  });

  it("stops at Rejected — terminal, unsuccessful, and with no publication URL", async () => {
    const { client, requests } = clientForSequence([
      fixture("publish-request-awaiting-approval.v1.json"),
      fixture("publish-request-rejected.v1.json"),
    ]);

    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: 0 });

    expect(outcome.state).toBe("Rejected");
    expect(outcome.terminal).toBe(true);
    expect(outcome.active).toBe(false);
    expect(outcome.publicationUrl).toBeUndefined();
    expect(outcome.attempts).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("stops at Failed with no publication URL, even though the server sent one", async () => {
    const failed = fixture("publish-request-failed.v1.json");
    expect(proposalOf(failed).publicationUrl).toBe("https://example.test/studio/parcels");
    const { client } = clientForSequence([fixture("publish-request-executing.v1.json"), failed]);

    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: 0 });

    expect(outcome.state).toBe("Failed");
    expect(outcome.terminal).toBe(true);
    expect(outcome.active).toBe(false);
    expect(outcome.publicationUrl).toBeUndefined();
    // The raw proposal is still preserved verbatim for diagnostics.
    expect(outcome.request.publicationUrl).toBe("https://example.test/studio/parcels");
    expect(outcome.request.reason).toContain("already bound");
  });

  it("never treats an unknown status as final, and still terminates at the bound", async () => {
    const { client, requests } = clientForSequence([fixture("publish-request-unknown-status.v1.json")]);

    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, {
      intervalMs: 0,
      maxAttempts: 4,
    });

    expect(requests).toHaveLength(4);
    expect(outcome.attempts).toBe(4);
    expect(outcome.state).toBeUndefined();
    expect(outcome.terminal).toBe(false);
    expect(outcome.active).toBe(false);
    expect(outcome.publicationUrl).toBeUndefined();
    expect(outcome.exhausted).toBe("max-attempts");
  });

  it("is bounded: a proposal that never settles stops after maxAttempts GETs", async () => {
    const { client, requests } = clientForSequence([fixture("publish-request-executing.v1.json")]);

    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, {
      intervalMs: 0,
      maxAttempts: 7,
    });

    expect(requests).toHaveLength(7);
    expect(outcome.attempts).toBe(7);
    expect(outcome.terminal).toBe(false);
    expect(outcome.exhausted).toBe("max-attempts");
  });

  it("stops on the wall-clock bound as well", async () => {
    const { client, requests } = clientForSequence([fixture("publish-request-executing.v1.json")]);

    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, {
      intervalMs: 1,
      maxAttempts: 500,
      timeoutMs: 0,
    });

    expect(outcome.exhausted).toBe("timeout");
    expect(outcome.terminal).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("enforces timeoutMs against a GET that is accepted and never answered", async () => {
    // No `timeoutMs` on the HonuaClient itself: the poll's own deadline is the
    // only thing that can end this, which is exactly the reported hole.
    const { client, requests } = clientForHangingSequence([fixture("publish-request-executing.v1.json")], 2);

    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, {
      intervalMs: 0,
      maxAttempts: 50,
      timeoutMs: 1_000,
    });

    expect(outcome.exhausted).toBe("timeout");
    expect(outcome.terminal).toBe(false);
    expect(outcome.state).toBe("Executing");
    // The first GET was observed; the second was aborted by the deadline.
    expect(outcome.attempts).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it("throws HonuaTimeoutError when the deadline expires before the first response", async () => {
    const { client, requests } = clientForHangingSequence([], 1);

    await expect(
      client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: 0, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(HonuaTimeoutError);
    expect(requests).toHaveLength(1);
  });

  it("never sleeps past the deadline when intervalMs overshoots it", async () => {
    const { client, requests } = clientForSequence([fixture("publish-request-executing.v1.json")]);

    const startedAt = Date.now();
    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, {
      intervalMs: 30_000,
      maxAttempts: 50,
      timeoutMs: 800,
    });

    expect(outcome.exhausted).toBe("timeout");
    // Without the clamp this would still be inside a 30s `delay()`.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(requests).toHaveLength(1);
  });

  it("stops on the clamped wait itself rather than re-reading the clock", async () => {
    // Waking from a wait that covers the whole remaining time *is* the deadline
    // being reached. Deriving that from `expiresAt - Date.now()` afterwards was
    // a race: a timer can fire a tick before `Date.now()` passes its target, so
    // the remainder read back as 1 rather than 0 and the loop issued one more
    // GET past the documented bound. Repeated because a single pass can get
    // lucky on an idle machine -- this is exactly how it slipped through.
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const { client, requests } = clientForSequence([fixture("publish-request-executing.v1.json")]);
      const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, {
        intervalMs: 25,
        maxAttempts: 50,
        timeoutMs: 25,
      });
      expect(outcome.exhausted).toBe("timeout");
      expect(requests).toHaveLength(1);
    }
  });

  it("rejects with the caller's abort reason when the abort lands mid-request", async () => {
    const { client, requests } = clientForHangingSequence([], 1);
    const reason = new Error("caller went away mid-flight");
    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), 10);

    await expect(
      client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: 0, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
  });

  it("rejects an unbounded or nonsensical bound instead of looping forever", async () => {
    const { client } = clientForSequence([fixture("publish-request-executing.v1.json")]);

    for (const maxAttempts of [0, -1, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(
        client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: 0, maxAttempts }),
      ).rejects.toThrow(TypeError);
    }
    await expect(client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: -1 })).rejects.toThrow(
      TypeError,
    );
  });

  it("publishes sane defaults for its bound", () => {
    expect(HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS).toBe(30);
    expect(HONUA_STUDIO_PUBLICATION_POLL_INTERVAL_MS).toBe(1_000);
  });

  it("cancels mid-walk when the AbortSignal fires", async () => {
    const { client, requests } = clientForSequence([fixture("publish-request-executing.v1.json")]);
    const controller = new AbortController();

    const failure = await client.publicationRequests
      .poll(ITEM, VERSION, REQUEST_ID, {
        intervalMs: 50,
        maxAttempts: 100,
        signal: controller.signal,
        onStatus: () => controller.abort(),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("AbortError");
    // Aborted during the wait after the first observation, so no second GET.
    expect(requests).toHaveLength(1);
  });

  it("rejects with the caller's abort reason and issues no request when already aborted", async () => {
    const { client, requests } = clientForSequence([fixture("publish-request-executing.v1.json")]);
    const reason = new Error("caller went away");
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: 0, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(requests).toHaveLength(0);
  });

  it("surfaces a problem-details failure mid-poll as a typed HonuaStudioError", async () => {
    const { client } = clientForSequence([
      fixture("publish-request-executing.v1.json"),
      fixture("publish-request-forbidden.v1.json"),
    ]);

    const failure = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: 0 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    expect((failure as HonuaStudioError).code).toBe("forbidden");
  });

  it("settles a legacy synchronous proposal at Active without inventing a URL", async () => {
    const legacy = fixture("publish-request-legacy-accepted.v1.json");
    const { client } = clientForSequence([legacy]);

    const outcome = await client.publicationRequests.poll(ITEM, VERSION, REQUEST_ID, { intervalMs: 0 });

    expect(outcome.state).toBe("Active");
    expect(outcome.terminal).toBe(true);
    expect(outcome.active).toBe(true);
    expect(outcome.publicationUrl).toBeUndefined();
  });
});

describe("publicationRequests.create — submission identity", () => {
  it("submits the saved version identity, content hash and idempotency key", async () => {
    const contract = fixture("publish-request-idempotent-replay.v1.json");
    const { client, requests } = clientFor(contract);

    const proposal = await client.publicationRequests.create(ITEM, VERSION, contract.request.body as never);

    expect(requests[0]).toMatchObject({ method: "POST", body: contract.request.body });
    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(proposal.proposalId).toBe("proposal-7c41e0b8");
  });

  it("resolves a replayed submission to the same proposal identifiers", async () => {
    const contract = fixture("publish-request-idempotent-replay.v1.json");
    const { client } = clientForSequence([contract, contract]);

    const first = await client.publicationRequests.create(ITEM, VERSION, contract.request.body as never);
    const replay = await client.publicationRequests.create(ITEM, VERSION, contract.request.body as never);

    expect(replay.requestId).toBe(first.requestId);
    expect(replay.proposalId).toBe(first.proposalId);
    expect(replay.proposalUri).toBe(first.proposalUri);
    expect(replay.operationInstanceId).toBe(first.operationInstanceId);
    expect(replay.auditId).toBe(first.auditId);
    expect(replay.correlationId).toBe(first.correlationId);
    expect(replay.replayed).toBe(true);
  });
});

describe("the proposer cannot approve their own publication", () => {
  it("exposes no approve/authorize/override capability anywhere on the Studio surface", () => {
    const forbidden =
      /^(approve|authorize|authorise|grant|selfapprove|autoapprove|skipapproval|bypass|override|forcepublish|elevate|impersonate)/;
    const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "");

    const clientGroups = [
      HonuaStudioLifecycleClient,
      HonuaStudioPublicationRequestsClient,
      studio.HonuaStudioDraftsClient,
      studio.HonuaStudioContentVersionsClient,
      studio.HonuaStudioPackageFamiliesClient,
      studio.HonuaStudioRollbackRequestsClient,
    ];
    const names = [
      ...Object.keys(studio),
      ...clientGroups.flatMap((group) => Object.getOwnPropertyNames(group.prototype)),
    ];

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(forbidden.test(normalize(name)), `${name} must not expose an approval capability`).toBe(false);
    }

    // The publication surface is exactly submit / read / poll.
    expect(
      Object.getOwnPropertyNames(HonuaStudioPublicationRequestsClient.prototype).filter(
        (name) => name !== "constructor",
      ),
    ).toEqual(["create", "get", "poll"]);
  });

  it("refuses client-side to serialize a submission that asserts its own decision", async () => {
    const { client, requests } = clientFor(fixture("publish-request-awaiting-approval.v1.json"));

    for (const smuggled of [
      { status: "Approved" },
      { approvedBy: "actor-proposer-1" },
      { autoApprove: true },
      { bypassPolicy: true },
      { policyOverride: "publication" },
      { force: true },
    ]) {
      const failure = await client.publicationRequests.create(ITEM, VERSION, smuggled as never).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isHonuaStudioError(failure), JSON.stringify(smuggled)).toBe(true);
      expect((failure as HonuaStudioError).code).toBe("validation");
      expect((failure as HonuaStudioError).message).toContain("separate principal");
    }

    // Nothing was ever put on the wire.
    expect(requests).toHaveLength(0);
  });

  it("still accepts a legitimate submission body that merely mentions policy", async () => {
    const { client, requests } = clientFor(fixture("publish-request-awaiting-approval.v1.json"));

    await client.publicationRequests.create(ITEM, VERSION, {
      intent: { route: "/studio/parcels", visibility: "organization" },
      approvalPolicyId: "policy-parcels",
      warningAcknowledgement: "Reviewed with the parcels data steward.",
    } as never);

    expect(requests).toHaveLength(1);
    expect((requests[0]?.body as { approvalPolicyId: string }).approvalPolicyId).toBe("policy-parcels");
  });

  it("is refused by the server too when a proposer reaches an approval route through raw()", async () => {
    const contract = fixture("publish-request-self-approval-forbidden.v1.json");
    const { client } = clientFor(contract);

    const failure = await client
      .raw({
        method: "POST",
        path: `/content-items/${ITEM}/versions/${VERSION}/publish-requests/${REQUEST_ID}/approvals`,
        body: contract.request.body,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(isHonuaStudioError(failure)).toBe(true);
    const error = failure as HonuaStudioError;
    expect(error.code).toBe("forbidden");
    expect(error.statusCode).toBe(403);
    expect(error.problem?.code).toBe("studio.publish-request.self-approval-forbidden");
    expect(error.message).toContain("may not approve it");
  });
});
