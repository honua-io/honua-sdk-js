import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HARNESS_CI_BUDGET,
  type SCENARIO_NAMES,
  createRunRegistry,
  createSseSubscriber,
  startSampleFixtureHarness,
} from "../samples/scenarios/index.mjs";

const harnesses: Array<{ close(): Promise<void> }> = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function start(options: Parameters<typeof startSampleFixtureHarness>[0]) {
  const harness = await startSampleFixtureHarness(options);
  harnesses.push(harness);
  return harness;
}

async function createRun(
  origin: string,
  id: string,
  scenario: (typeof SCENARIO_NAMES)[number] = "happy",
  authScope = "public",
) {
  return fetch(`${origin}/__fixture__/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, scenario, authScope }),
  });
}

function runHeaders(id: string, authScope = "public", extra: Record<string, string> = {}) {
  return { "x-honua-fixture-run": id, "x-honua-fixture-auth-scope": authScope, ...extra };
}

async function rawRequest(origin: string, requestPath: string, headers: Record<string, string> = {}) {
  const url = new URL(origin);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: requestPath,
        headers: { host: url.host, ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function openSse(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  let buffered = "";
  return {
    response,
    async next() {
      if (!reader) throw new Error("SSE response has no body.");
      while (!buffered.includes("\n\n")) {
        const result = await reader.read();
        if (result.done) throw new Error("SSE stream closed before the next event.");
        buffered += new TextDecoder().decode(result.value, { stream: true });
      }
      const boundary = buffered.indexOf("\n\n");
      const record = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = record
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return JSON.parse(data);
    },
    async close() {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
    },
  };
}

describe("shared deterministic sample harness security and lifecycle", () => {
  it("binds an ephemeral loopback port and exposes readiness/CSP within the CI budget", async () => {
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-fixture-static-"));
    temporaryRoots.push(staticRoot);
    fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><title>fixture</title>");
    fs.writeFileSync(path.join(staticRoot, "download.bin"), "fixture-binary");
    const harness = await start({ sampleId: "first-map", staticRoot });

    expect(harness.startupElapsedMs).toBeLessThanOrEqual(HARNESS_CI_BUDGET.startupMs);
    const readiness = await fetch(harness.readinessUrl);
    expect(readiness.status).toBe(200);
    expect(readiness.headers.get("date")).toBeNull();
    expect(await readiness.json()).toMatchObject({
      ready: true,
      network: "loopback-only",
      budgets: HARNESS_CI_BUDGET,
    });

    const page = await fetch(harness.url);
    expect(await page.text()).toContain("fixture");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(page.headers.get("x-honua-fixture-network")).toBe("loopback-only");
    const binary = await fetch(`${harness.url}/download.bin`);
    expect(binary.headers.get("content-type")).toBe("application/octet-stream");
    expect(binary.headers.get("content-disposition")).toBe("attachment");
  });

  it("blocks proxy/SSRF, foreign authority/origin, conflicting runs, and traversal", async () => {
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-fixture-static-"));
    temporaryRoots.push(staticRoot);
    fs.writeFileSync(path.join(staticRoot, "index.html"), "fixture");
    const outside = path.join(staticRoot, "..", `outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(staticRoot, "escape.txt"));
    const harness = await start({ sampleId: "first-map", staticRoot });
    const authority = new URL(harness.origin).host;

    expect((await rawRequest(harness.origin, "http://example.test/private")).status).toBe(403);
    expect((await rawRequest(harness.origin, "/", { host: "example.test" })).status).toBe(403);
    expect((await rawRequest(harness.origin, "/", { forwarded: "host=example.test" })).status).toBe(403);
    expect((await rawRequest(harness.origin, "/", { origin: `https://${authority}` })).status).toBe(403);
    expect((await rawRequest(harness.origin, "/", { origin: `http://user@${authority}` })).status).toBe(403);
    expect((await rawRequest(harness.origin, "/", { origin: `${harness.origin}/path` })).status).toBe(403);
    expect(
      (
        await rawRequest(harness.origin, "/api/v1/admin/capabilities?run=first-map", {
          "x-honua-fixture-run": "other",
        })
      ).status,
    ).toBe(400);
    for (const requestPath of ["/../outside", "/%2e%2e/outside", "/%252e%252e%252foutside", "/escape.txt"]) {
      expect((await rawRequest(harness.origin, requestPath)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await rawRequest(harness.origin, "/__fixture__/runs/%ZZ")).status).toBe(400);
    fs.rmSync(outside, { force: true });
  });

  it("normalizes client validation failures and binds existing runs to their seed", async () => {
    const harness = await start({ sampleId: "first-map" });
    const create = (body: Record<string, unknown>) =>
      fetch(`${harness.origin}/__fixture__/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await create({ id: "seeded", seed: "seed-a" })).status).toBe(201);
    expect((await create({ id: "seeded", seed: "seed-b" })).status).toBe(409);
    expect((await create({ id: "Bad-Run" })).status).toBe(400);
    expect((await create({ id: "bad-scenario", scenario: "surprise" })).status).toBe(400);
    expect((await create({ id: "bad-auth", authScope: "bad scope" })).status).toBe(400);
    expect((await create({ id: "bad-seed", seed: "bad\nseed" })).status).toBe(400);

    const query = `${harness.origin}/rest/services/natural-earth/FeatureServer/0/query`;
    expect((await fetch(query, { headers: { "x-honua-fixture-run": "Bad-Run" } })).status).toBe(400);
    expect((await fetch(query, { headers: runHeaders("seeded", "bad scope") })).status).toBe(400);
    expect((await rawRequest(harness.origin, "/__fixture__/runs/default%2Freset")).status).toBe(400);

    for (const advanceMs of [-1, 1.5, 86_400_001, "1000"]) {
      const response = await fetch(`${harness.origin}/__fixture__/runs/default/clock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ advanceMs }),
      });
      expect(response.status, String(advanceMs)).toBe(400);
    }
    const invalidReset = await fetch(`${harness.origin}/__fixture__/runs/default/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(invalidReset.status).toBe(400);
  });

  it("keeps bounded per-run authorization/state and logs only closed redacted route metadata", async () => {
    const harness = await start({ sampleId: "first-map", maximumRuns: 3 });
    expect((await createRun(harness.origin, "alpha", "auth-scope", "team-a")).status).toBe(201);
    expect((await createRun(harness.origin, "beta", "happy", "team-b")).status).toBe(201);
    expect((await createRun(harness.origin, "overflow")).status).toBe(429);

    const protectedUrl = `${harness.origin}/rest/services/natural-earth/FeatureServer/0/query`;
    expect((await fetch(protectedUrl, { headers: runHeaders("alpha", "team-b") })).status).toBe(403);
    expect((await fetch(protectedUrl, { headers: runHeaders("alpha", "team-a") })).status).toBe(200);
    await fetch(`${harness.origin}/secret-token-in-path?access_token=do-not-log`, {
      headers: runHeaders("alpha", "team-a", { authorization: "Bearer do-not-log", cookie: "session=do-not-log" }),
    });
    const logs = await fetch(`${harness.origin}/__fixture__/runs/alpha/requests`, {
      headers: { "x-honua-fixture-auth-scope": "team-a" },
    });
    const serialized = JSON.stringify(await logs.json());
    expect(serialized).not.toContain("secret-token-in-path");
    expect(serialized).not.toContain("do-not-log");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("cookie");
    expect(serialized).toContain("sample-app-route");
  });

  it("expires non-default runs and makes concurrent reset idempotent with frozen clock/ids", async () => {
    let registryTime = 10_000;
    const harness = await start({
      sampleId: "first-map",
      maximumRuns: 3,
      runTtlMs: 1_000,
      registryNow: () => registryTime,
    });
    await createRun(harness.origin, "resettable");
    const editsUrl = `${harness.origin}/rest/services/natural-earth/FeatureServer/0/applyEdits`;
    const edit = await fetch(editsUrl, {
      method: "POST",
      headers: { ...runHeaders("resettable"), "content-type": "application/json" },
      body: JSON.stringify({
        objectId: 3,
        expectedRevision: 1,
        idempotencyKey: "reset-edit",
        attributes: { STATUS: "Ready" },
      }),
    });
    const firstEditId = (await edit.json()).editId;
    await fetch(`${harness.origin}/__fixture__/runs/resettable/clock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ advanceMs: 5_000 }),
    });
    const resetUrl = `${harness.origin}/__fixture__/runs/resettable/reset`;
    const resets = await Promise.all([
      fetch(resetUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(resetUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    ]);
    expect(await resets[0].text()).toBe(await resets[1].text());
    const repeatedEdit = await fetch(editsUrl, {
      method: "POST",
      headers: { ...runHeaders("resettable"), "content-type": "application/json" },
      body: JSON.stringify({
        objectId: 3,
        expectedRevision: 1,
        idempotencyKey: "reset-edit",
        attributes: { STATUS: "Ready" },
      }),
    });
    expect((await repeatedEdit.json()).editId).toBe(firstEditId);

    registryTime += 1_001;
    await fetch(`${harness.origin}/api/v1/admin/capabilities`);
    expect((await fetch(`${harness.origin}/__fixture__/runs/resettable`)).status).toBe(404);
  });

  it("closes concurrently and disposes open SSE connections without hanging", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    const stream = await openSse(`${harness.origin}/api/v1/streaming/features`);
    expect(stream.response.status).toBe(200);
    await stream.next();
    const close = Promise.all([harness.close(), harness.close()]);
    await expect(
      Promise.race([close, new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 1_500))]),
    ).resolves.toBeDefined();
    await stream.close();
  });
});

describe("First Map modular protocol scenarios", () => {
  const queryPath = "/rest/services/natural-earth/FeatureServer/0/query";

  it("serves happy, empty, unsupported, schema drift, abort, stale cursor, range, and cache outcomes", async () => {
    const harness = await start({ sampleId: "first-map" });
    const expected: Array<[string, number]> = [
      ["empty", 200],
      ["unsupported", 501],
      ["schema-drift", 200],
      ["abort", 499],
      ["stale-cursor", 410],
      ["range", 206],
      ["cache-hit", 200],
      ["cache-stale", 200],
      ["cache-revalidate", 200],
    ];
    for (const [scenario, status] of expected) {
      await createRun(harness.origin, `run-${scenario}`, scenario as any);
      const response = await fetch(`${harness.origin}${queryPath}`, {
        headers: runHeaders(`run-${scenario}`, "public", scenario === "range" ? { range: "bytes=0-31" } : {}),
      });
      expect(response.status, scenario).toBe(status);
      if (scenario === "empty") expect((await response.json()).features).toEqual([]);
      if (scenario === "schema-drift") expect((await response.json()).schemaRevision).toBe("drift-v2");
      if (scenario === "range") expect(response.headers.get("content-range")).toMatch(/^bytes 0-31\//);
      await fetch(`${harness.origin}/__fixture__/runs/run-${scenario}`, { method: "DELETE" });
    }
  });

  it("paginates with run-bound cursors, throttles once, validates numbers, and isolates edits", async () => {
    const harness = await start({ sampleId: "first-map" });
    await createRun(harness.origin, "page-a", "paginated");
    await createRun(harness.origin, "page-b", "paginated");
    const first = await fetch(`${harness.origin}${queryPath}?resultRecordCount=1`, { headers: runHeaders("page-a") });
    const firstPage = await first.json();
    expect(firstPage.features).toHaveLength(1);
    expect(firstPage.nextCursor).toContain("page-a:");
    const second = await fetch(`${harness.origin}${queryPath}?cursor=${encodeURIComponent(firstPage.nextCursor)}`, {
      headers: runHeaders("page-a"),
    });
    expect((await second.json()).features[0].attributes.OBJECTID).toBe(2);
    expect(
      (
        await fetch(`${harness.origin}${queryPath}?cursor=${encodeURIComponent(firstPage.nextCursor)}`, {
          headers: runHeaders("page-b"),
        })
      ).status,
    ).toBe(410);
    const forgedCursor = firstPage.nextCursor.replace(":1:", ":999:");
    expect(
      (
        await fetch(`${harness.origin}${queryPath}?cursor=${encodeURIComponent(forgedCursor)}`, {
          headers: runHeaders("page-a"),
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await fetch(`${harness.origin}${queryPath}?cursor=${encodeURIComponent(firstPage.nextCursor)}&resultOffset=1`, {
          headers: runHeaders("page-a"),
        })
      ).status,
    ).toBe(400);
    for (const invalid of ["-1", "1junk", "9007199254740992"]) {
      expect(
        (await fetch(`${harness.origin}${queryPath}?resultOffset=${invalid}`, { headers: runHeaders("page-a") }))
          .status,
      ).toBe(400);
    }

    await createRun(harness.origin, "throttle", "throttled");
    expect((await fetch(`${harness.origin}${queryPath}`, { headers: runHeaders("throttle") })).status).toBe(429);
    expect((await fetch(`${harness.origin}${queryPath}`, { headers: runHeaders("throttle") })).status).toBe(200);
    await createRun(harness.origin, "no-pages", "empty");
    expect(
      (await fetch(`${harness.origin}${queryPath}?cursor=forged`, { headers: runHeaders("no-pages") })).status,
    ).toBe(400);

    await createRun(harness.origin, "edits-a");
    await createRun(harness.origin, "edits-b");
    const editRequest = (run: string) => ({
      objectId: 3,
      expectedRevision: 1,
      idempotencyKey: `${run}-edit`,
      attributes: { STATUS: "Ready" },
    });
    const editIds = await Promise.all(
      ["edits-a", "edits-b"].map(async (run) => {
        const response = await fetch(`${harness.origin}/rest/services/natural-earth/FeatureServer/0/applyEdits`, {
          method: "POST",
          headers: { ...runHeaders(run), "content-type": "application/json" },
          body: JSON.stringify(editRequest(run)),
        });
        return (await response.json()).editId;
      }),
    );
    expect(editIds[0]).not.toBe(editIds[1]);

    const exactReplay = await fetch(`${harness.origin}/rest/services/natural-earth/FeatureServer/0/applyEdits`, {
      method: "POST",
      headers: { ...runHeaders("edits-a"), "content-type": "application/json" },
      body: JSON.stringify(editRequest("edits-a")),
    });
    expect(exactReplay.status).toBe(200);
    expect((await exactReplay.json()).outcome).toBe("duplicate");
    const conflictingReplay = await fetch(`${harness.origin}/rest/services/natural-earth/FeatureServer/0/applyEdits`, {
      method: "POST",
      headers: { ...runHeaders("edits-a"), "content-type": "application/json" },
      body: JSON.stringify({
        ...editRequest("edits-a"),
        attributes: { STATUS: "Changed request" },
      }),
    });
    expect(conflictingReplay.status).toBe(409);
    expect((await conflictingReplay.json()).error.code).toBe("FIXTURE_IDEMPOTENCY_CONFLICT");

    const hostileEdit = await fetch(`${harness.origin}/rest/services/natural-earth/FeatureServer/0/applyEdits`, {
      method: "POST",
      headers: { ...runHeaders("edits-a"), "content-type": "application/json" },
      body: JSON.stringify({
        objectId: 3,
        expectedRevision: 2,
        idempotencyKey: "hostile-attributes",
        attributes: { OBJECTID: 999, geometry: { x: 0, y: 0 } },
      }),
    });
    expect(hostileEdit.status).toBe(400);
  });
});

describe("Incident Operations realtime scenarios", () => {
  it("keeps realtime resume and page cursors distinct and rejects stale/foreign bindings", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    await createRun(harness.origin, "incident-page", "paginated");
    await createRun(harness.origin, "incident-other", "paginated");
    const first = await openSse(`${harness.origin}/api/v1/streaming/features`, runHeaders("incident-page"));
    const snapshot = await first.next();
    expect(snapshot.features).toHaveLength(2);
    expect(snapshot.pageCursor).toContain("page:incident-page:");
    expect(snapshot.cursor).toContain("rt:incident-page:");
    await first.close();

    const page = await openSse(
      `${harness.origin}/api/v1/streaming/features?pageCursor=${encodeURIComponent(snapshot.pageCursor)}`,
      runHeaders("incident-page"),
    );
    expect((await page.next()).features).toHaveLength(2);
    await page.close();
    const resume = await openSse(
      `${harness.origin}/api/v1/streaming/features?cursor=${encodeURIComponent(snapshot.cursor)}`,
      runHeaders("incident-page"),
    );
    expect(resume.response.status).toBe(200);
    await resume.close();
    const forgedRealtimeCursor = snapshot.cursor.replace(":1:", ":0:");
    expect(
      (
        await fetch(`${harness.origin}/api/v1/streaming/features?cursor=${encodeURIComponent(forgedRealtimeCursor)}`, {
          headers: runHeaders("incident-page"),
        })
      ).status,
    ).toBe(410);
    const forgedPageCursor = snapshot.pageCursor.replace(":2:", ":999:");
    expect(
      (
        await fetch(`${harness.origin}/api/v1/streaming/features?pageCursor=${encodeURIComponent(forgedPageCursor)}`, {
          headers: runHeaders("incident-page"),
        })
      ).status,
    ).toBe(410);
    const foreign = await fetch(
      `${harness.origin}/api/v1/streaming/features?cursor=${encodeURIComponent(snapshot.cursor)}`,
      { headers: runHeaders("incident-other") },
    );
    expect(foreign.status).toBe(410);
    const other = await openSse(`${harness.origin}/api/v1/streaming/features`, runHeaders("incident-other"));
    const otherSnapshot = await other.next();
    await other.close();
    const mixed = await fetch(
      `${harness.origin}/api/v1/streaming/features?pageCursor=${encodeURIComponent(snapshot.pageCursor)}&cursor=${encodeURIComponent(otherSnapshot.cursor)}`,
      { headers: runHeaders("incident-page") },
    );
    expect(mixed.status).toBe(400);
    const mixedRealtime = await fetch(
      `${harness.origin}/api/v1/streaming/features?cursor=${encodeURIComponent(snapshot.cursor)}`,
      { headers: runHeaders("incident-page", "public", { "last-event-id": snapshot.eventId }) },
    );
    expect(mixedRealtime.status).toBe(400);
    const foreignLastEvent = await fetch(`${harness.origin}/api/v1/streaming/features`, {
      headers: runHeaders("incident-other", "public", { "last-event-id": snapshot.eventId }),
    });
    expect(foreignLastEvent.status).toBe(410);
    const staleEventId = await fetch(`${harness.origin}/api/v1/streaming/features`, {
      headers: runHeaders("incident-page", "public", { "last-event-id": "foreign-event" }),
    });
    expect(staleEventId.status).toBe(410);
    const nonPaginatedCursor = await fetch(`${harness.origin}/api/v1/streaming/features?pageCursor=forged`);
    expect(nonPaginatedCursor.status).toBe(400);
    await fetch(`${harness.origin}/__fixture__/runs/incident-page/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const staleGeneration = await fetch(
      `${harness.origin}/api/v1/streaming/features?cursor=${encodeURIComponent(snapshot.cursor)}`,
      { headers: runHeaders("incident-page") },
    );
    expect(staleGeneration.status).toBe(410);
  });

  it("emits duplicate/stale/reconnect/step events and keeps event vs observation time distinct", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    const stream = await openSse(`${harness.origin}/api/v1/streaming/features`);
    const initial = await stream.next();
    await stream.next();
    const action = async (name: string, body: Record<string, unknown> = {}) => {
      const response = await fetch(`${harness.origin}/__fixture__/runs/default/actions/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    await action("duplicate-event");
    expect((await stream.next()).eventId).toBe(initial.eventId);
    await action("stale-cursor");
    expect((await stream.next()).sequence).toBe(0);
    await action("reconnect");
    expect((await stream.next()).status).toBe("reconnecting");
    await action("resume");
    expect((await stream.next()).status).toBe("live");
    await stream.next();
    await action("step");
    const step = await stream.next();
    expect(step.timestamp).toBe("2026-05-05T18:02:20.000Z");
    expect(step.receivedAt).toBe(Date.parse("2026-05-05T18:10:00.000Z"));
    await stream.close();
  });

  it("serializes concurrent edits, validates hostile bodies, and enforces idempotent reset", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    const actionUrl = `${harness.origin}/__fixture__/runs/default/actions`;
    const edit = (idempotencyKey: string) =>
      fetch(`${actionUrl}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          incidentId: "DEMO-EDIT-0001",
          expectedRevision: 1,
          idempotencyKey,
          patch: { status: "monitoring", assignedTo: "Exercise Lead" },
        }),
      });
    const concurrent = await Promise.all([edit("parallel-a"), edit("parallel-b")]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);

    const boundEdit = await fetch(`${actionUrl}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentId: "DEMO-EDIT-0001",
        expectedRevision: 2,
        idempotencyKey: "bound-request",
        patch: { status: "assigned", assignedTo: "Bound Request" },
      }),
    });
    expect(boundEdit.status).toBe(200);
    const conflictingReplay = await fetch(`${actionUrl}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentId: "DEMO-EDIT-0001",
        expectedRevision: 2,
        idempotencyKey: "bound-request",
        patch: { status: "resolved", assignedTo: "Different Request" },
      }),
    });
    expect(conflictingReplay.status).toBe(409);
    expect((await conflictingReplay.json()).code).toBe("FIXTURE_IDEMPOTENCY_CONFLICT");
    const crossActionReplay = await fetch(`${actionUrl}/reset-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId: "DEMO-EDIT-0001", idempotencyKey: "bound-request" }),
    });
    expect(crossActionReplay.status).toBe(409);

    const hostile = await fetch(`${actionUrl}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentId: "DEMO-EDIT-0001",
        expectedRevision: 2,
        idempotencyKey: "hostile",
        patch: { status: "open", assignedTo: "ok", coordinate: [0, 0], safeDemoRecord: false },
      }),
    });
    expect(hostile.status).toBe(400);

    const resetBody = { incidentId: "DEMO-EDIT-0001", idempotencyKey: "reset-once" };
    const reset = () =>
      fetch(`${actionUrl}/reset-edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(resetBody),
      });
    expect((await (await reset()).json()).outcome).toBe("reset");
    expect((await (await reset()).json()).outcome).toBe("duplicate");
  });

  it("bounds concurrent subscribers and releases every stream on close", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    const streams = [];
    for (let index = 0; index < 8; index += 1) {
      streams.push(await openSse(`${harness.origin}/api/v1/streaming/features`));
    }
    const overflow = await fetch(`${harness.origin}/api/v1/streaming/features`);
    expect(overflow.status).toBe(429);
    await Promise.all(streams.map((stream) => stream.close()));
  });
});

describe("bounded registry and SSE primitives", () => {
  it("caps retained idempotency receipts for both mutable sample handlers", async () => {
    const firstMap = await start({ sampleId: "first-map" });
    for (let index = 0; index < 128; index += 1) {
      const response = await fetch(`${firstMap.origin}/rest/services/natural-earth/FeatureServer/0/applyEdits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectId: 3,
          expectedRevision: index + 1,
          idempotencyKey: `first-map-${index}`,
          attributes: { STATUS: `Reviewed ${index}` },
        }),
      });
      expect(response.status, `First Map edit ${index}`).toBe(200);
    }
    const firstMapOverflow = await fetch(`${firstMap.origin}/rest/services/natural-earth/FeatureServer/0/applyEdits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: 3,
        expectedRevision: 129,
        idempotencyKey: "first-map-overflow",
        attributes: { STATUS: "Overflow" },
      }),
    });
    expect(firstMapOverflow.status).toBe(429);

    const incidents = await start({ sampleId: "incident-operations" });
    for (let index = 0; index < 128; index += 1) {
      const response = await fetch(`${incidents.origin}/__fixture__/runs/default/actions/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          incidentId: "DEMO-EDIT-0001",
          expectedRevision: index + 1,
          idempotencyKey: `incident-${index}`,
          patch: { status: "monitoring", assignedTo: `Operator ${index}` },
        }),
      });
      expect(response.status, `Incident edit ${index}`).toBe(200);
    }
    const incidentOverflow = await fetch(`${incidents.origin}/__fixture__/runs/default/actions/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentId: "DEMO-EDIT-0001",
        expectedRevision: 129,
        idempotencyKey: "incident-overflow",
        patch: { status: "monitoring", assignedTo: "Overflow" },
      }),
    });
    expect(incidentOverflow.status).toBe(429);
  });

  it("surfaces contained disposer failures only after the server is fully closed", async () => {
    const harness = await startSampleFixtureHarness({
      sampleId: "first-map",
      handlerOverride: {
        createRunState: () => ({}),
        handle: () => false,
        disposeRunState: () => {
          throw new Error("sensitive disposer detail");
        },
      },
    } as any);
    const firstClose = harness.close();
    await expect(firstClose).rejects.toThrow(/contained run-disposal failures/i);
    await expect(harness.close()).rejects.toThrow(/contained run-disposal failures/i);
    expect(harness.server.listening).toBe(false);
    expect(harness.inspect().socketCount).toBe(0);
  });

  it("contains disposer failures and rejects mutation after deletion", async () => {
    const registry = createRunRegistry({
      handler: {
        createRunState: () => ({}),
        disposeRunState: () => {
          throw new Error("hostile disposer detail");
        },
      },
      maximumRuns: 3,
    });
    const run = registry.create({ id: "other", scenario: "happy", authScope: "public", seed: "other" });
    registry.remove("other");
    expect(registry.disposalErrors()).toEqual([
      { runId: "other", reason: "deleted", message: "Fixture run disposal failed." },
    ]);
    await expect(registry.mutate(run, () => true)).rejects.toThrow(/no longer active/i);
    expect(registry.close()).toHaveLength(2);
  });

  it("fails reset without replacing run state when disposal fails", async () => {
    const registry = createRunRegistry({
      handler: {
        createRunState: () => ({ marker: "original" }),
        disposeRunState: (_run: unknown, reason: string) => {
          if (reason === "reset") throw new Error("sensitive reset failure");
        },
      },
    });
    const run = registry.get();
    const state = run.state;
    const clock = run.clock;
    await expect(registry.reset(run)).rejects.toThrow(/reset failed during state disposal/i);
    expect(run.state).toBe(state);
    expect(run.clock).toBe(clock);
    expect(registry.snapshot(run).state).toEqual({});
    registry.close();
  });

  it("fails reset without disposing or replacing state when replacement construction fails", async () => {
    let constructions = 0;
    const disposalReasons: string[] = [];
    const registry = createRunRegistry({
      handler: {
        createRunState: () => {
          constructions += 1;
          if (constructions === 2) throw new Error("sensitive construction failure");
          return { marker: `state-${constructions}` };
        },
        disposeRunState: (_run, reason) => {
          disposalReasons.push(reason);
        },
      },
    });
    const run = registry.get();
    const state = run.state;
    const clock = run.clock;
    await expect(registry.reset(run)).rejects.toThrow(/constructing replacement state/i);
    expect(run.state).toBe(state);
    expect(run.clock).toBe(clock);
    expect(disposalReasons).toEqual([]);
    registry.close();
  });

  it("bounds backpressure queues and contains cleanup failures", () => {
    const request = new EventEmitter() as any;
    const response = new EventEmitter() as any;
    response.writableEnded = false;
    response.writeHead = () => undefined;
    response.flushHeaders = () => undefined;
    response.write = () => false;
    response.end = () => {
      response.writableEnded = true;
    };
    const subscriber = createSseSubscriber(request, response, {
      maximumQueuedEvents: 2,
      onClose: () => {
        throw new Error("cleanup must be contained");
      },
    });
    expect(subscriber.send({ type: "snapshot", eventId: "one", value: 1 })).toBe(true);
    expect(subscriber.send({ type: "snapshot", eventId: "two", value: 2 })).toBe(true);
    expect(subscriber.send({ type: "snapshot", eventId: "three", value: 3 })).toBe(true);
    expect(subscriber.send({ type: "snapshot", eventId: "four", value: 4 })).toBe(false);
    expect(subscriber.isClosed()).toBe(true);
    expect(request.listenerCount("close")).toBe(0);
    expect(response.listenerCount("drain")).toBe(0);
  });

  it("rejects SSE framing injection independently from a valid write failure", () => {
    const framingRequest = new EventEmitter() as any;
    const framingResponse = new EventEmitter() as any;
    framingResponse.writableEnded = false;
    framingResponse.writeHead = () => undefined;
    framingResponse.flushHeaders = () => undefined;
    framingResponse.write = () => true;
    framingResponse.end = () => undefined;
    const framing = createSseSubscriber(framingRequest, framingResponse, {});
    expect(framing.send({ type: "snapshot\ninjected", eventId: "bad\nid" })).toBe(false);
    expect(framing.isClosed()).toBe(true);

    const writeRequest = new EventEmitter() as any;
    const writeResponse = new EventEmitter() as any;
    writeResponse.writableEnded = false;
    writeResponse.writeHead = () => undefined;
    writeResponse.flushHeaders = () => undefined;
    writeResponse.write = () => {
      throw new Error("write failed");
    };
    writeResponse.end = () => undefined;
    const writeFailure = createSseSubscriber(writeRequest, writeResponse, {});
    expect(writeFailure.send({ type: "snapshot", eventId: "valid-id", value: 1 })).toBe(false);
    expect(writeFailure.isClosed()).toBe(true);
  });

  it("omits the SSE id field for status events that do not own a resumable identity", () => {
    const request = new EventEmitter() as any;
    const response = new EventEmitter() as any;
    const writes: string[] = [];
    response.writableEnded = false;
    response.writeHead = () => undefined;
    response.flushHeaders = () => undefined;
    response.write = (value: string) => {
      writes.push(value);
      return true;
    };
    response.end = () => undefined;
    const subscriber = createSseSubscriber(request, response, {});
    expect(subscriber.send({ type: "status", status: "reconnecting" })).toBe(true);
    expect(writes.join("")).toContain("event: status\n");
    expect(writes.join("")).not.toContain("\nid: ");
    subscriber.close();
  });
});
