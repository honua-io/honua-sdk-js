import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  HARNESS_CI_BUDGET,
  type SCENARIO_NAMES,
  createRunRegistry,
  createSseSubscriber,
  createStaticRootBinding,
  startSampleFixtureHarness,
} from "../samples/scenarios/index.mjs";
import { connect } from "../src/connect.js";

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

async function rawRequest(origin: string, requestPath: string, headers: Record<string, string> = {}, method = "GET") {
  const url = new URL(origin);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: requestPath,
        method,
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
  it("binds each sample to a compatible fixture-pack manifest before listening", async () => {
    const createRunState = vi.fn(() => ({}));
    const handle = vi.fn(() => false);
    await expect(
      startSampleFixtureHarness({
        sampleId: "first-map",
        fixturePackId: "incident-operations",
        handlerOverride: { createRunState, handle },
      } as any),
    ).rejects.toThrow(/incompatible.*identities must match/i);
    await expect(
      startSampleFixtureHarness({ sampleId: "incident-operations", fixturePackId: "first-map" }),
    ).rejects.toThrow(/incompatible.*identities must match/i);
    expect(createRunState).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

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

  it("pins the static root identity and blocks directory rebinding before direct or SPA reads", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "honua-fixture-rebinding-"));
    temporaryRoots.push(parent);
    const staticRoot = path.join(parent, "dist");
    const originalRoot = path.join(parent, "dist.original");
    fs.mkdirSync(staticRoot);
    fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><title>pinned fixture</title>");
    const harness = await start({ sampleId: "first-map", staticRoot });

    const fallback = await fetch(`${harness.origin}/client/route`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("pinned fixture");

    fs.renameSync(staticRoot, originalRoot);
    fs.symlinkSync("/etc", staticRoot, "dir");
    for (const requestPath of ["/passwd", "/client/route"]) {
      const response = await rawRequest(harness.origin, requestPath);
      expect(response.status, requestPath).toBe(403);
      expect(response.body, requestPath).not.toContain("root:");
    }
  });

  it("rejects a static root swapped during startup canonicalization", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "honua-fixture-startup-swap-"));
    temporaryRoots.push(parent);
    const staticRoot = path.join(parent, "dist");
    const originalRoot = path.join(parent, "dist.original");
    fs.mkdirSync(staticRoot);
    fs.writeFileSync(path.join(staticRoot, "index.html"), "safe fixture");
    const realRealpathSync = fs.realpathSync.bind(fs);
    let swapped = false;
    const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation(((candidate, options) => {
      if (!swapped && path.resolve(String(candidate)) === staticRoot) {
        swapped = true;
        fs.renameSync(staticRoot, originalRoot);
        fs.symlinkSync("/etc", staticRoot, "dir");
      }
      return realRealpathSync(candidate, options as never);
    }) as typeof fs.realpathSync);
    try {
      expect(() => createStaticRootBinding(staticRoot)).toThrow(/real directory/i);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("rejects intermediate-directory swaps and same-size writes during static reads", async () => {
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-fixture-static-races-"));
    temporaryRoots.push(staticRoot);
    const nested = path.join(staticRoot, "nested");
    const originalNested = path.join(staticRoot, "nested.original");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "passwd"), "safe fixture\n");
    const mutablePath = path.join(staticRoot, "mutable.txt");
    fs.writeFileSync(mutablePath, "A".repeat(4_096));
    const mutableIdentity = fs.lstatSync(mutablePath, { bigint: true });
    const harness = await start({ sampleId: "first-map", staticRoot });

    const realLstatSync = fs.lstatSync.bind(fs);
    let parentSwapped = false;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
      if (!parentSwapped && path.resolve(String(candidate)) === path.join(nested, "passwd")) {
        parentSwapped = true;
        fs.renameSync(nested, originalNested);
        fs.symlinkSync("/etc", nested, "dir");
      }
      return realLstatSync(candidate, options as never);
    }) as typeof fs.lstatSync);
    try {
      const response = await rawRequest(harness.origin, "/nested/passwd");
      expect(response.status).toBe(403);
      expect(response.body).not.toContain("root:");
    } finally {
      lstatSpy.mockRestore();
    }

    const realReadSync = fs.readSync.bind(fs);
    let fileMutated = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((descriptor, buffer, offset, length, position) => {
      const bytesRead = realReadSync(descriptor, buffer, offset, length, position);
      const identity = fs.fstatSync(descriptor, { bigint: true });
      if (!fileMutated && identity.dev === mutableIdentity.dev && identity.ino === mutableIdentity.ino) {
        fileMutated = true;
        fs.writeFileSync(mutablePath, "B".repeat(4_096));
      }
      return bytesRead;
    }) as typeof fs.readSync);
    try {
      const response = await rawRequest(harness.origin, "/mutable.txt");
      expect(response.status).toBe(409);
      expect(response.body).not.toContain("A".repeat(32));
      expect(response.body).not.toContain("B".repeat(32));
    } finally {
      readSpy.mockRestore();
    }
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
    fs.rmSync(path.join(staticRoot, "index.html"));
    fs.symlinkSync(outside, path.join(staticRoot, "index.html"));
    expect((await rawRequest(harness.origin, "/client/route")).status).toBe(403);
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
    expect((await create({ id: "bad.run" })).status).toBe(400);
    expect((await create({ id: "bad_run" })).status).toBe(400);
    expect((await create({ id: "bad-scenario", scenario: "surprise" })).status).toBe(400);
    expect((await create({ id: "bad-auth", authScope: "bad scope" })).status).toBe(400);
    expect((await create({ id: "bad-seed", seed: "bad\nseed" })).status).toBe(400);

    const query = `${harness.origin}/rest/services/natural-earth/FeatureServer/0/query`;
    expect((await fetch(query, { headers: { "x-honua-fixture-run": "Bad-Run" } })).status).toBe(400);
    expect((await fetch(`${query}?run=default&run=default`)).status).toBe(400);
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

  it("rejects cross-site Fetch Metadata before it can perturb run logs or realtime state", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    const runUrl = `${harness.origin}/__fixture__/runs/default`;
    const before = await (await fetch(runUrl)).json();

    for (const fetchSite of ["cross-site", "same-site"]) {
      const response = await fetch(`${harness.origin}/api/v1/streaming/features`, {
        headers: { "sec-fetch-site": fetchSite },
      });
      expect(response.status, fetchSite).toBe(403);
      await response.body?.cancel();
    }

    const after = await (await fetch(runUrl)).json();
    expect(after.requestCount).toBe(before.requestCount + 1);
    expect(after.clock).toBe(before.clock);
    expect(after.state).toEqual(before.state);
    const rejectedRequestLog = await (await fetch(`${runUrl}/requests`)).json();
    expect(
      rejectedRequestLog.requests.filter((request: { routeId: string }) => request.routeId === "incident-stream"),
    ).toHaveLength(0);

    const capabilities = `${harness.origin}/api/v1/streaming/features/capabilities`;
    for (const fetchSite of ["same-origin", "none"]) {
      expect((await fetch(capabilities, { headers: { "sec-fetch-site": fetchSite } })).status, fetchSite).toBe(200);
    }
    expect((await fetch(capabilities)).status).toBe(200);
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

  it("sanitizes hostile request metadata without overriding protocol-owned status codes", async () => {
    const harness = await start({ sampleId: "first-map" });
    const queryPath = "/ogc/features/collections/operations-areas/items";
    const unicode = await rawRequest(harness.origin, `${queryPath}?${encodeURIComponent("☃")}=1`);
    expect(unicode.status).toBe(400);
    const manyNames = new URLSearchParams(Array.from({ length: 33 }, (_, index) => [`q${index}`, "value"])).toString();
    expect((await rawRequest(harness.origin, `${queryPath}?${manyNames}`)).status).toBe(400);
    expect((await rawRequest(harness.origin, "/unhandled", {}, "TRACE")).status).toBe(404);

    const requests = await (await fetch(`${harness.origin}/__fixture__/runs/default/requests`)).json();
    expect(requests.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queryNames: ["invalid"] }),
        expect.objectContaining({ method: "OTHER", routeId: "sample-app-route" }),
      ]),
    );
    expect(
      requests.requests.some((request: { queryNames: string[] }) => request.queryNames.includes("truncated")),
    ).toBe(true);
  });

  it("does not let failed authorization refresh a protected run's TTL", async () => {
    let registryTime = 10_000;
    const harness = await start({
      sampleId: "first-map",
      maximumRuns: 2,
      runTtlMs: 1_000,
      registryNow: () => registryTime,
    });
    expect((await createRun(harness.origin, "protected", "auth-scope", "team-a")).status).toBe(201);
    registryTime = 10_900;
    expect(
      (
        await fetch(`${harness.origin}/rest/services/natural-earth/FeatureServer/0/query`, {
          headers: runHeaders("protected", "wrong-team"),
        })
      ).status,
    ).toBe(403);
    registryTime = 11_500;
    expect((await createRun(harness.origin, "replacement")).status).toBe(201);
    expect((await fetch(`${harness.origin}/__fixture__/runs/protected`)).status).toBe(404);
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
    const editsUrl = `${harness.origin}/__fixture__/runs/resettable/actions/edit`;
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
  const ogcItemsPath = "/ogc/features/collections/operations-areas/items";

  it("keeps empty, schema drift, abort, stale cursor, range, and cache outcomes coherent across projections", async () => {
    const harness = await start({ sampleId: "first-map" });
    const expected: Array<[string, number]> = [
      ["empty", 200],
      ["schema-drift", 200],
      ["abort", 499],
      ["stale-cursor", 410],
      ["range", 206],
      ["cache-hit", 200],
      ["cache-stale", 200],
      ["cache-revalidate", 200],
    ];
    for (const [scenario, status] of expected) {
      await createRun(harness.origin, `geo-${scenario}`, scenario as any);
      await createRun(harness.origin, `ogc-${scenario}`, scenario as any);
      const extra: Record<string, string> = scenario === "range" ? { range: "bytes=0-31" } : {};
      const geoservices = await fetch(`${harness.origin}${queryPath}`, {
        headers: runHeaders(`geo-${scenario}`, "public", extra),
      });
      const ogc = await fetch(`${harness.origin}${ogcItemsPath}`, {
        headers: runHeaders(`ogc-${scenario}`, "public", extra),
      });
      expect(geoservices.status, `GeoServices ${scenario}`).toBe(status);
      expect(ogc.status, `OGC ${scenario}`).toBe(status);
      if (scenario === "empty") {
        expect((await geoservices.json()).features).toEqual([]);
        expect((await ogc.json()).features).toEqual([]);
      }
      if (scenario === "schema-drift") {
        const geoBody = await geoservices.json();
        const ogcBody = await ogc.json();
        expect(geoBody.schemaRevision).toBe("drift-v2");
        expect(ogcBody.schemaRevision).toBe("drift-v2");
        expect(geoBody.fields.find((field: { name: string }) => field.name === "OBJECTID").type).toBe(
          "esriFieldTypeString",
        );
        expect(ogcBody.features[0].properties.OBJECTID).toBe("1");
      }
      if (scenario === "range") {
        expect(geoservices.headers.get("content-range")).toMatch(/^bytes 0-31\//);
        expect(ogc.headers.get("content-range")).toMatch(/^bytes 0-31\//);
        expect(ogc.headers.get("content-type")).toBe("application/geo+json; charset=utf-8");
      }
      for (const response of [geoservices, ogc]) {
        if (scenario === "cache-hit") {
          expect(response.headers.get("cache-control")).toBe("private, max-age=60");
          expect(response.headers.get("age")).toBe("12");
          expect(response.headers.get("warning")).toBeNull();
        } else if (scenario === "cache-stale") {
          expect(response.headers.get("cache-control")).toBe("private, max-age=60");
          expect(response.headers.get("age")).toBe("600");
          expect(response.headers.get("warning")).toBe('110 - "Response is stale"');
        } else if (scenario === "cache-revalidate") {
          expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
          expect(response.headers.get("etag")).toBeTruthy();
          expect(response.headers.get("age")).toBeNull();
          expect(response.headers.get("warning")).toBeNull();
        }
      }
      await fetch(`${harness.origin}/__fixture__/runs/geo-${scenario}`, { method: "DELETE" });
      await fetch(`${harness.origin}/__fixture__/runs/ogc-${scenario}`, { method: "DELETE" });
    }
  });

  it("discovers every OGC route and returns the exact GeoServices feature semantics", async () => {
    const harness = await start({ sampleId: "first-map" });
    const landing = await (await fetch(`${harness.origin}/ogc/features`)).json();
    const conformanceLink = landing.links.find((link: { rel: string }) => link.rel === "conformance");
    const dataLink = landing.links.find((link: { rel: string }) => link.rel === "data");
    const serviceDescriptionLink = landing.links.find((link: { rel: string }) => link.rel === "service-desc");
    const conformance = await (await fetch(new URL(conformanceLink.href, harness.origin))).json();
    const serviceDescriptionResponse = await fetch(new URL(serviceDescriptionLink.href, harness.origin));
    const serviceDescription = await serviceDescriptionResponse.json();
    const collections = await (await fetch(new URL(dataLink.href, harness.origin))).json();
    const collectionLink = collections.collections[0].links.find((link: { rel: string }) => link.rel === "self");
    const collection = await (await fetch(new URL(collectionLink.href, harness.origin))).json();
    const itemsLink = collection.links.find((link: { rel: string }) => link.rel === "items");
    const itemsResponse = await fetch(new URL(itemsLink.href, harness.origin));
    const items = await itemsResponse.json();
    const itemResponse = await fetch(`${harness.origin}${ogcItemsPath}/1`);
    const item = await itemResponse.json();
    const layer = await (await fetch(`${harness.origin}/rest/services/natural-earth/FeatureServer/0`)).json();
    const geoservices = await (await fetch(`${harness.origin}${queryPath}`)).json();

    expect(conformance.conformsTo).toContain("http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core");
    expect(conformance.conformsTo.some((value: string) => value.includes("ogcapi-common-1"))).toBe(false);
    expect(serviceDescriptionResponse.headers.get("content-type")).toBe(
      "application/vnd.oai.openapi+json;version=3.0; charset=utf-8",
    );
    expect(Object.keys(serviceDescription.paths)).toEqual(
      expect.arrayContaining([
        "/",
        "/api",
        "/conformance",
        "/collections",
        "/collections/{collectionId}",
        "/collections/{collectionId}/items",
        "/collections/{collectionId}/items/{featureId}",
      ]),
    );
    expect(collections.collections).toHaveLength(1);
    expect(collection.extent.spatial.bbox).toEqual([
      [layer.extent.xmin, layer.extent.ymin, layer.extent.xmax, layer.extent.ymax],
    ]);
    expect(layer.capabilities).toBe("Query");
    expect(layer.advancedQueryCapabilities.supportsReturningQueryExtent).toBe(false);
    expect(itemsResponse.headers.get("content-crs")).toBe("<http://www.opengis.net/def/crs/OGC/1.3/CRS84>");
    expect(itemsResponse.headers.get("content-type")).toBe("application/geo+json; charset=utf-8");
    expect(itemResponse.headers.get("content-type")).toBe("application/geo+json; charset=utf-8");
    expect(items.numberMatched).toBe(geoservices.features.length);
    expect(items.attribution).toBe(layer.copyrightText);
    expect(items.provenance).toEqual(layer.provenance);
    expect(collection.attribution).toBe(layer.copyrightText);
    expect(collection.provenance).toEqual(layer.provenance);
    for (const [index, feature] of geoservices.features.entries()) {
      expect(items.features[index]).toMatchObject({ id: feature.attributes.OBJECTID, properties: feature.attributes });
      expect(items.features[index].geometry.coordinates).toEqual(
        feature.geometry.rings.map((ring: number[][]) => [...ring].reverse()),
      );
    }
    expect(item).toMatchObject(items.features[0]);
    expect(item.links.map((link: { rel: string }) => link.rel)).toEqual(["self", "collection"]);

    const requests = await (await fetch(`${harness.origin}/__fixture__/runs/default/requests`)).json();
    expect(requests.requests.map((request: { routeId: string }) => request.routeId)).toEqual(
      expect.arrayContaining([
        "first-map-ogc-landing",
        "first-map-ogc-api-definition",
        "first-map-ogc-conformance",
        "first-map-ogc-collections",
        "first-map-ogc-collection",
        "first-map-ogc-items",
        "first-map-ogc-item",
        "first-map-layer",
        "first-map-query",
      ]),
    );
  });

  it("implements the declared OGC Core item parameters with filtered counts and deterministic links", async () => {
    const harness = await start({ sampleId: "first-map" });
    await createRun(harness.origin, "ogc-core");
    const headers = runHeaders("ogc-core");
    const selection = new URLSearchParams({
      bbox: "-157.900,21.290,-157.875,21.306",
      datetime: "2026-05-05T00:00:00Z/..",
      limit: "1",
    });
    const firstResponse = await fetch(`${harness.origin}${ogcItemsPath}?${selection}`, { headers });
    const first = await firstResponse.json();
    expect(first.features.map((feature: { id: number }) => feature.id)).toEqual([2]);
    expect(first).toMatchObject({ numberMatched: 1, numberReturned: 1, timeStamp: "2026-05-05T18:10:00.000Z" });
    const self = new URL(first.links.find((link: { rel: string }) => link.rel === "self").href, harness.origin);
    expect(self.searchParams.get("bbox")).toBe(selection.get("bbox"));
    expect(self.searchParams.get("datetime")).toBe(selection.get("datetime"));
    expect(self.searchParams.get("limit")).toBe("1");
    expect(self.searchParams.get("offset")).toBe("0");
    expect(self.searchParams.get("run")).toBe("ogc-core");

    const broad = new URLSearchParams({
      bbox: "-158,21,-157,22",
      datetime: "2026-05-05T18:10:00Z",
      f: "geojson",
      limit: "1",
    });
    const broadFirst = await (await fetch(`${harness.origin}${ogcItemsPath}?${broad}`, { headers })).json();
    expect(broadFirst).toMatchObject({ numberMatched: 3, numberReturned: 1 });
    const next = new URL(broadFirst.links.find((link: { rel: string }) => link.rel === "next").href, harness.origin);
    expect(next.searchParams.get("bbox")).toBe(broad.get("bbox"));
    expect(next.searchParams.get("datetime")).toBe(broad.get("datetime"));
    expect(next.searchParams.get("f")).toBe("geojson");
    expect(next.searchParams.get("offset")).toBe("1");
    expect(next.searchParams.get("run")).toBe("ogc-core");
    expect((await (await fetch(next)).json()).features[0].id).toBe(2);

    const sixDimensional = await fetch(
      `${harness.origin}${ogcItemsPath}?bbox=-158,21,-10,-157,22,10&datetime=../2026-05-06T00:00:00Z`,
      { headers },
    );
    expect((await sixDimensional.json()).numberMatched).toBe(3);
    const wrapped = await (await fetch(`${harness.origin}${ogcItemsPath}?bbox=170,20,-150,22`, { headers })).json();
    expect(wrapped.numberMatched).toBe(3);
    const wrappedMiss = await (
      await fetch(`${harness.origin}${ogcItemsPath}?bbox=-150,20,-170,22`, { headers })
    ).json();
    expect(wrappedMiss).toMatchObject({ numberMatched: 0, numberReturned: 0 });
    for (const datetime of [
      "/2026-05-06T00:00:00Z",
      "2026-05-05T00:00:00Z/",
      "2016-12-31T23:59:60Z",
      "2017-01-01T05:29:60+05:30",
      "2026-05-05t18:10:00z",
      "2016-12-31T23:59:60.5Z/2017-01-01T00:00:00Z",
    ]) {
      const response = await fetch(`${harness.origin}${ogcItemsPath}?datetime=${encodeURIComponent(datetime)}`, {
        headers,
      });
      expect(response.status, datetime).toBe(200);
      expect((await response.json()).numberMatched).toBe(3);
    }
    const clamped = await fetch(`${harness.origin}${ogcItemsPath}?limit=100000000000000000000000`, { headers });
    expect(clamped.status).toBe(200);
    const clampedBody = await clamped.json();
    expect(clampedBody.features).toHaveLength(3);
    expect(
      new URL(
        clampedBody.links.find((link: { rel: string }) => link.rel === "self").href,
        harness.origin,
      ).searchParams.get("limit"),
    ).toBe("1000");

    const before = await (await fetch(`${harness.origin}${ogcItemsPath}`, { headers })).json();
    await fetch(`${harness.origin}/__fixture__/runs/ogc-core/clock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ advanceMs: 1_000 }),
    });
    const after = await (await fetch(`${harness.origin}${ogcItemsPath}`, { headers })).json();
    expect(before.timeStamp).toBe("2026-05-05T18:10:00.000Z");
    expect(after.timeStamp).toBe("2026-05-05T18:10:01.000Z");

    const invalidQueries = [
      "limit=0",
      "limit=1&limit=2",
      "offset=-1",
      "bbox=-158,21,-157",
      "bbox=-158,21,0,-157,22",
      "bbox=-181,21,-157,22",
      "bbox=-157,22,-158,21",
      "bbox=-158,NaN,-157,22",
      "bbox=-158,0x15,-157,22",
      "datetime=2026-05-05",
      "datetime=2026-02-31T00:00:00Z",
      "datetime=2026-05-05T24:00:00Z",
      "datetime=2026-05-05T23:58:60Z",
      "datetime=2026-05-05T23:59:60Z",
      "datetime=2026-05-05T23:59:61Z",
      "datetime=/",
      "datetime=2026-05-06T00:00:00Z/2026-05-05T00:00:00Z",
      `datetime=${encodeURIComponent("2017-01-01T00:00:00Z/2016-12-31T23:59:60Z")}`,
      `datetime=${encodeURIComponent("2017-01-01T00:00:00Z/2017-01-01T05:29:60.5+05:30")}`,
      "unknown=value",
      "cursor=forged",
    ];
    for (const query of invalidQueries) {
      expect((await fetch(`${harness.origin}${ogcItemsPath}?${query}`, { headers })).status, query).toBe(400);
    }

    for (const pathName of [
      "/ogc/features",
      "/ogc/features/api",
      "/ogc/features/conformance",
      "/ogc/features/collections",
      "/ogc/features/collections/operations-areas",
      `${ogcItemsPath}/1`,
    ]) {
      expect((await fetch(`${harness.origin}${pathName}?unknown=value`, { headers })).status, pathName).toBe(400);
    }
    expect((await fetch(`${harness.origin}/ogc/features?run=ogc-core&run=ogc-core`)).status).toBe(400);
    expect((await fetch(`${harness.origin}/ogc/features?f=html`, { headers })).status).toBe(400);

    await createRun(harness.origin, "ogc-cursor", "paginated");
    expect(
      (await fetch(`${harness.origin}${ogcItemsPath}?cursor=forged`, { headers: runHeaders("ogc-cursor") })).status,
    ).toBe(400);
    await createRun(harness.origin, "ogc-invalid-throttle", "throttled");
    expect(
      (
        await fetch(`${harness.origin}${ogcItemsPath}?unknown=value`, {
          headers: runHeaders("ogc-invalid-throttle"),
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${harness.origin}${ogcItemsPath}`, { headers: runHeaders("ogc-invalid-throttle") })).status,
    ).toBe(429);
    await createRun(harness.origin, "ogc-item-invalid-throttle", "throttled");
    expect(
      (
        await fetch(`${harness.origin}${ogcItemsPath}/9007199254740992`, {
          headers: runHeaders("ogc-item-invalid-throttle"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${harness.origin}${ogcItemsPath}/1`, {
          headers: runHeaders("ogc-item-invalid-throttle"),
        })
      ).status,
    ).toBe(429);
  });

  it("keeps named runs in every followed OGC link without leaking authorization scope", async () => {
    const harness = await start({ sampleId: "first-map" });
    await createRun(harness.origin, "named-unsupported", "unsupported");
    const landing = await (await fetch(`${harness.origin}/ogc/features?run=named-unsupported`)).json();
    for (const link of landing.links) {
      const target = new URL(link.href, harness.origin);
      expect(target.searchParams.get("run"), link.rel).toBe("named-unsupported");
      expect(target.username).toBe("");
      expect(target.password).toBe("");
      expect(target.searchParams.has("authScope")).toBe(false);
    }
    const conformanceLink = landing.links.find((link: { rel: string }) => link.rel === "conformance");
    const dataLink = landing.links.find((link: { rel: string }) => link.rel === "data");
    const conformance = await (await fetch(new URL(conformanceLink.href, harness.origin))).json();
    expect(conformance.conformsTo).toEqual([]);
    const collections = await (await fetch(new URL(dataLink.href, harness.origin))).json();
    const collection = collections.collections[0];
    for (const link of [...collections.links, ...collection.links]) {
      expect(new URL(link.href, harness.origin).searchParams.get("run"), link.rel).toBe("named-unsupported");
    }
    const self = collection.links.find((link: { rel: string }) => link.rel === "self");
    expect((await fetch(new URL(self.href, harness.origin))).status).toBe(200);
    expect(collection.links.some((link: { rel: string }) => link.rel === "items")).toBe(false);

    await createRun(harness.origin, "private-links", "auth-scope", "team-a");
    const privateLanding = await (
      await fetch(`${harness.origin}/ogc/features`, { headers: runHeaders("private-links", "team-a") })
    ).json();
    const privateData = new URL(
      privateLanding.links.find((link: { rel: string }) => link.rel === "data").href,
      harness.origin,
    );
    expect(privateData.searchParams.get("run")).toBe("private-links");
    expect((await fetch(privateData)).status).toBe(403);
    expect((await fetch(privateData, { headers: { "x-honua-fixture-auth-scope": "team-a" } })).status).toBe(200);
  });

  it("uses response-specific ETags so protocol representations cannot cross-revalidate", async () => {
    const harness = await start({ sampleId: "first-map" });
    await createRun(harness.origin, "etag-truth", "cache-revalidate");
    const headers = runHeaders("etag-truth");
    const geoservices = await fetch(`${harness.origin}${queryPath}`, { headers });
    const ogc = await fetch(`${harness.origin}${ogcItemsPath}`, { headers });
    const geoservicesEtag = geoservices.headers.get("etag");
    const ogcEtag = ogc.headers.get("etag");
    expect(geoservicesEtag).toBeTruthy();
    expect(ogcEtag).toBeTruthy();
    expect(geoservicesEtag).not.toBe(ogcEtag);
    expect(geoservices.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(ogc.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(
      (
        await fetch(`${harness.origin}${queryPath}`, {
          headers: runHeaders("etag-truth", "public", { "if-none-match": ogcEtag ?? "" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${harness.origin}${ogcItemsPath}`, {
          headers: runHeaders("etag-truth", "public", { "if-none-match": geoservicesEtag ?? "" }),
        })
      ).status,
    ).toBe(200);
    const geoservicesNotModified = await fetch(`${harness.origin}${queryPath}`, {
      headers: runHeaders("etag-truth", "public", { "if-none-match": geoservicesEtag ?? "" }),
    });
    const ogcNotModified = await fetch(`${harness.origin}${ogcItemsPath}`, {
      headers: runHeaders("etag-truth", "public", { "if-none-match": ogcEtag ?? "" }),
    });
    for (const [response, expectedEtag] of [
      [geoservicesNotModified, geoservicesEtag],
      [ogcNotModified, ogcEtag],
    ] as const) {
      expect(response.status).toBe(304);
      expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
      expect(response.headers.get("etag")).toBe(expectedEtag);
      expect(await response.text()).toBe("");
    }
  });

  it("fails query capability discovery closed before rejecting forced unsupported I/O", async () => {
    const harness = await start({ sampleId: "first-map" });
    await createRun(harness.origin, "unsupported-truth", "unsupported");
    const headers = runHeaders("unsupported-truth");
    const layer = await (
      await fetch(`${harness.origin}/rest/services/natural-earth/FeatureServer/0`, { headers })
    ).json();
    const conformance = await (await fetch(`${harness.origin}/ogc/features/conformance`, { headers })).json();
    const collection = await (
      await fetch(`${harness.origin}/ogc/features/collections/operations-areas`, { headers })
    ).json();
    const apiDefinition = await (await fetch(`${harness.origin}/ogc/features/api`, { headers })).json();

    expect(layer.capabilities).toBe("None");
    expect(layer).not.toHaveProperty("advancedQueryCapabilities");
    expect(conformance.conformsTo.some((value: string) => value.includes("ogcapi-features-1"))).toBe(false);
    expect(collection.links.some((link: { rel: string }) => link.rel === "items")).toBe(false);
    expect(apiDefinition.paths).not.toHaveProperty("/collections/{collectionId}/items");
    expect(apiDefinition.paths).not.toHaveProperty("/collections/{collectionId}/items/{featureId}");
    for (const [path, protocol] of [
      [queryPath, "geoservices-feature-service"],
      [ogcItemsPath, "ogc-features"],
    ]) {
      const forced = await fetch(`${harness.origin}${path}`, { headers });
      expect(forced.status).toBe(405);
      expect(await forced.json()).toMatchObject({
        error: { code: "FIXTURE_CAPABILITY_NOT_ADVERTISED", capability: "query", protocol },
      });
    }
  });

  it("negotiates Query for happy metadata and no Query for unsupported metadata without probing data routes", async () => {
    const happy = await start({ sampleId: "first-map" });
    const unsupported = await start({ sampleId: "first-map", defaultScenario: "unsupported" });
    for (const [label, harness, expected] of [
      ["happy", happy, true],
      ["unsupported", unsupported, false],
    ] as const) {
      const geoservices = await connect({
        endpoint: `${harness.origin}/rest/services/natural-earth/FeatureServer/0`,
        protocol: "auto",
        authorizationScopeFingerprint: `${label}-geo`,
      });
      const ogc = await connect({
        endpoint: `${harness.origin}/ogc/features`,
        protocol: "ogc-features",
        authorizationScopeFingerprint: `${label}-ogc`,
      });
      expect(geoservices.inspection.sources[0].descriptor.capabilities.has("query"), `${label} GeoServices`).toBe(
        expected,
      );
      expect(ogc.inspection.sources[0].descriptor.capabilities.has("query"), `${label} OGC`).toBe(expected);
      expect(geoservices.inspection.sources[0].descriptor.capabilities.has("queryExtent"), `${label} extent`).toBe(
        false,
      );
      expect(geoservices.inspection.sources[0].descriptor.capabilities.has("applyEdits"), `${label} edits`).toBe(false);
      const requests = await (await fetch(`${harness.origin}/__fixture__/runs/default/requests`)).json();
      expect(requests.requests.map((request: { routeId: string }) => request.routeId)).not.toEqual(
        expect.arrayContaining(["first-map-query", "first-map-ogc-items"]),
      );
    }
    expect(
      (
        await fetch(`${happy.origin}/rest/services/natural-earth/FeatureServer/0/applyEdits`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });

  it("bounds overflow pages and exposes a deterministic continuation in both protocols", async () => {
    const harness = await start({ sampleId: "first-map" });
    await createRun(harness.origin, "overflow-truth", "overflow");
    const headers = runHeaders("overflow-truth");
    const layer = await (
      await fetch(`${harness.origin}/rest/services/natural-earth/FeatureServer/0`, { headers })
    ).json();
    const collection = await (
      await fetch(`${harness.origin}/ogc/features/collections/operations-areas`, { headers })
    ).json();
    const geoFirst = await (await fetch(`${harness.origin}${queryPath}`, { headers })).json();
    const ogcFirst = await (await fetch(`${harness.origin}${ogcItemsPath}`, { headers })).json();

    expect(layer.maxRecordCount).toBe(2);
    expect(collection["x-honua-fixture-page-limit"]).toBe(2);
    expect(geoFirst.features).toHaveLength(2);
    expect(geoFirst.exceededTransferLimit).toBe(true);
    expect(ogcFirst.features).toHaveLength(2);
    expect(ogcFirst).toMatchObject({ numberMatched: 3, numberReturned: 2 });
    const next = ogcFirst.links.find((link: { rel: string }) => link.rel === "next");
    const ogcSecond = await (await fetch(new URL(next.href, harness.origin), { headers })).json();
    const geoSecond = await (await fetch(`${harness.origin}${queryPath}?resultOffset=2`, { headers })).json();
    expect(ogcSecond.features.map((feature: { id: number }) => feature.id)).toEqual([3]);
    expect(ogcSecond.links.some((link: { rel: string }) => link.rel === "next")).toBe(false);
    expect(
      geoSecond.features.map((feature: { attributes: { OBJECTID: number } }) => feature.attributes.OBJECTID),
    ).toEqual([3]);
    expect(geoSecond.exceededTransferLimit).toBe(false);
  });

  it("resets OGC state byte-for-byte without leaking throttle state between runs", async () => {
    const harness = await start({ sampleId: "first-map" });
    await createRun(harness.origin, "ogc-reset-a", "throttled");
    await createRun(harness.origin, "ogc-reset-b", "throttled");
    const query = (run: string) => fetch(`${harness.origin}${ogcItemsPath}`, { headers: runHeaders(run) });

    expect((await query("ogc-reset-a")).status).toBe(429);
    expect((await query("ogc-reset-b")).status).toBe(429);
    const beforeReset = await (await query("ogc-reset-a")).text();
    const reset = await fetch(`${harness.origin}/__fixture__/runs/ogc-reset-a/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(reset.status).toBe(200);
    expect((await query("ogc-reset-a")).status).toBe(429);
    expect(await (await query("ogc-reset-a")).text()).toBe(beforeReset);
    const otherRun = await (await query("ogc-reset-b")).json();
    const resetRun = JSON.parse(beforeReset);
    expect(otherRun.features).toEqual(resetRun.features);
    expect(otherRun.links.every((link: { href: string }) => link.href.includes("run=ogc-reset-b"))).toBe(true);
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

    await createRun(harness.origin, "ogc-page", "paginated");
    const ogcFirst = await (
      await fetch(`${harness.origin}${ogcItemsPath}`, { headers: runHeaders("ogc-page") })
    ).json();
    expect(ogcFirst.features.map((feature: { id: number }) => feature.id)).toEqual([1]);
    const ogcNext = ogcFirst.links.find((link: { rel: string }) => link.rel === "next");
    const ogcSecond = await (
      await fetch(new URL(ogcNext.href, harness.origin), { headers: runHeaders("ogc-page") })
    ).json();
    expect(ogcSecond.features.map((feature: { id: number }) => feature.id)).toEqual([2]);

    await createRun(harness.origin, "throttle", "throttled");
    expect((await fetch(`${harness.origin}${queryPath}`, { headers: runHeaders("throttle") })).status).toBe(429);
    expect((await fetch(`${harness.origin}${queryPath}`, { headers: runHeaders("throttle") })).status).toBe(200);
    await createRun(harness.origin, "geo-invalid-throttle", "throttled");
    expect(
      (
        await fetch(`${harness.origin}${queryPath}?resultOffset=-1`, {
          headers: runHeaders("geo-invalid-throttle"),
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${harness.origin}${queryPath}`, { headers: runHeaders("geo-invalid-throttle") })).status).toBe(
      429,
    );
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
        const response = await fetch(`${harness.origin}/__fixture__/runs/${run}/actions/edit`, {
          method: "POST",
          headers: { ...runHeaders(run), "content-type": "application/json" },
          body: JSON.stringify(editRequest(run)),
        });
        return (await response.json()).editId;
      }),
    );
    expect(editIds[0]).not.toBe(editIds[1]);

    const exactReplay = await fetch(`${harness.origin}/__fixture__/runs/edits-a/actions/edit`, {
      method: "POST",
      headers: { ...runHeaders("edits-a"), "content-type": "application/json" },
      body: JSON.stringify(editRequest("edits-a")),
    });
    expect(exactReplay.status).toBe(200);
    expect((await exactReplay.json()).outcome).toBe("duplicate");
    const conflictingReplay = await fetch(`${harness.origin}/__fixture__/runs/edits-a/actions/edit`, {
      method: "POST",
      headers: { ...runHeaders("edits-a"), "content-type": "application/json" },
      body: JSON.stringify({
        ...editRequest("edits-a"),
        attributes: { STATUS: "Changed request" },
      }),
    });
    expect(conflictingReplay.status).toBe(409);
    expect((await conflictingReplay.json()).error.code).toBe("FIXTURE_IDEMPOTENCY_CONFLICT");

    const hostileEdit = await fetch(`${harness.origin}/__fixture__/runs/edits-a/actions/edit`, {
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
  it("rejects duplicate run selectors on snapshot and stream routes", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    expect((await fetch(`${harness.origin}/api/v1/incidents?run=default&run=default`)).status).toBe(400);
    expect((await fetch(`${harness.origin}/api/v1/streaming/features?run=default&run=default`)).status).toBe(400);
  });

  it("serves full range representations and revalidates snapshots against current run state", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    await createRun(harness.origin, "incident-range", "range");
    const full = await fetch(`${harness.origin}/api/v1/incidents`, { headers: runHeaders("incident-range") });
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect((await full.json()).features.length).toBeGreaterThan(0);
    const partial = await fetch(`${harness.origin}/api/v1/incidents`, {
      headers: runHeaders("incident-range", "public", { range: "bytes=0-31" }),
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toMatch(/^bytes 0-31\//);

    await createRun(harness.origin, "incident-etag", "cache-revalidate");
    const snapshotUrl = `${harness.origin}/api/v1/incidents`;
    const first = await fetch(snapshotUrl, { headers: runHeaders("incident-etag") });
    const firstEtag = first.headers.get("etag");
    const firstBody = await first.text();
    expect(firstEtag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const notModified = await fetch(snapshotUrl, {
      headers: runHeaders("incident-etag", "public", { "if-none-match": firstEtag ?? "" }),
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(notModified.headers.get("etag")).toBe(firstEtag);
    expect(await notModified.text()).toBe("");
    const step = await fetch(`${harness.origin}/__fixture__/runs/incident-etag/actions/step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(step.status).toBe(200);
    const changed = await fetch(snapshotUrl, {
      headers: runHeaders("incident-etag", "public", { "if-none-match": firstEtag ?? "" }),
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(firstEtag);
    expect(await changed.text()).not.toBe(firstBody);
  });

  it("marks incident cache-hit and cache-stale snapshots private with coherent freshness metadata", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    for (const [scenario, age, warning] of [
      ["cache-hit", "10", null],
      ["cache-stale", "600", '110 - "Response is stale"'],
    ] as const) {
      const runId = `incident-${scenario}`;
      await createRun(harness.origin, runId, scenario);
      const response = await fetch(`${harness.origin}/api/v1/incidents`, { headers: runHeaders(runId) });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, max-age=60");
      expect(response.headers.get("age")).toBe(age);
      expect(response.headers.get("warning")).toBe(warning);
    }
  });

  it("validates incident selectors before consuming throttle or stream capacity", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    await createRun(harness.origin, "incident-invalid-throttle", "throttled");
    expect(
      (
        await fetch(`${harness.origin}/api/v1/streaming/features?unknown=value`, {
          headers: runHeaders("incident-invalid-throttle"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${harness.origin}/api/v1/streaming/features?${new URLSearchParams({
            deltaToken: "delta",
            fields: "id,status",
            layerId: "incident-points",
            layers: "incident-points",
            metadata: "{}",
            mode: "snapshot-then-delta",
            requestId: "incident-test",
            sequence: "0",
            serviceId: "incident-ops",
            sourceId: "incident-ops",
            spatialFilter: "{}",
            timestamp: "2026-05-05T18:10:00Z",
            watermark: "2026-05-05T18:10:00Z",
            where: "1=1",
          })}`,
          {
            headers: runHeaders("incident-invalid-throttle"),
          },
        )
      ).status,
    ).toBe(429);
  });

  it("disables realtime discovery before rejecting a forced unsupported stream", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    await createRun(harness.origin, "incident-unsupported", "unsupported");
    const headers = runHeaders("incident-unsupported");
    const capabilities = await (
      await fetch(`${harness.origin}/api/v1/streaming/features/capabilities`, { headers })
    ).json();
    expect(capabilities).toMatchObject({ enabled: false, data: { enabled: false, transport: "sse" } });
    const forced = await fetch(`${harness.origin}/api/v1/streaming/features`, { headers });
    expect(forced.status).toBe(501);
    expect(await forced.json()).toMatchObject({ error: { code: "FIXTURE_UNSUPPORTED", capability: "realtime" } });
  });

  it("keeps realtime resume and page cursors distinct and rejects stale/foreign bindings", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    await createRun(harness.origin, "incident-page", "paginated");
    await createRun(harness.origin, "incident-other", "paginated");
    const first = await openSse(`${harness.origin}/api/v1/streaming/features`, runHeaders("incident-page"));
    const snapshot = await first.next();
    expect(snapshot.features).toHaveLength(2);
    expect(snapshot.replace).toBe(true);
    expect(snapshot.pageCursor).toContain("page:incident-page:");
    expect(snapshot.cursor).toContain("rt:incident-page:");
    await first.close();

    const page = await openSse(
      `${harness.origin}/api/v1/streaming/features?pageCursor=${encodeURIComponent(snapshot.pageCursor)}`,
      runHeaders("incident-page"),
    );
    const continuation = await page.next();
    expect(continuation.features).toHaveLength(2);
    expect(continuation.replace).toBe(false);
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

  it("emits duplicate/reordered/stale-cursor/reconnect events and keeps event vs observation time distinct", async () => {
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
    await action("reorder-event");
    expect((await stream.next()).sequence).toBe(0);
    await action("stale-cursor");
    expect(await stream.next()).toMatchObject({ type: "error", code: "cursor-expired", terminal: false });
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
    expect(await crossActionReplay.json()).toMatchObject({
      outcome: "conflict",
      operation: "reset",
      idempotencyKey: "bound-request",
    });

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
    expect(await (await reset()).json()).toMatchObject({ outcome: "reset", operation: "reset", actualRevision: 4 });
    expect(await (await reset()).json()).toMatchObject({ outcome: "duplicate", operation: "reset", actualRevision: 4 });
  });

  it("bounds concurrent subscribers and releases every stream on close", async () => {
    const harness = await start({ sampleId: "incident-operations" });
    const streams = [];
    for (let index = 0; index < 8; index += 1) {
      streams.push(await openSse(`${harness.origin}/api/v1/streaming/features`));
    }
    const overflow = await fetch(`${harness.origin}/api/v1/streaming/features`);
    expect(overflow.status).toBe(429);
    const invalid = await fetch(`${harness.origin}/api/v1/streaming/features?unknown=value`);
    expect(invalid.status).toBe(400);
    await Promise.all(streams.map((stream) => stream.close()));
  });
});

describe("bounded registry and SSE primitives", () => {
  it("disposes failed run construction without publishing partial state", () => {
    const disposals: Array<{ runId: string; reason: string; marker: string | undefined; active: boolean }> = [];
    const registry = createRunRegistry<{ marker: string }>({
      handler: {
        createRunState: (run) => {
          if (run.id === "broken") {
            run.state = { marker: "partial" };
            throw new Error("sensitive construction failure");
          }
          return { marker: "ready" };
        },
        disposeRunState: (run, reason) => {
          disposals.push({ runId: run.id, reason, marker: run.state?.marker, active: run.active });
        },
      },
      maximumRuns: 3,
    });

    expect(() => registry.create({ id: "broken", scenario: "happy" })).toThrow(/creation failed/i);
    expect(() => registry.get("broken")).toThrow(/unknown fixture run/i);
    const defaultRun = registry.get();
    expectTypeOf(defaultRun.ids.next).toBeFunction();
    expectTypeOf(defaultRun.createdAt).toEqualTypeOf<number>();
    expectTypeOf(defaultRun.touchedAt).toEqualTypeOf<number>();
    expectTypeOf(defaultRun.mutation).toEqualTypeOf<Promise<unknown>>();
    const compileOnlyAsyncMutation = () => {
      // @ts-expect-error Fixture mutations must complete synchronously under the registry lock.
      return registry.mutate(defaultRun, async () => "not-allowed");
    };
    expectTypeOf(compileOnlyAsyncMutation).toBeFunction();
    expect(defaultRun.state).toEqual({ marker: "ready" });
    expect(registry.size()).toBe(1);
    expect(disposals).toEqual([
      { runId: "broken", reason: "run-construction-failed", marker: "partial", active: false },
    ]);
    registry.close();
  });

  it("disposes out-of-band resources when construction throws before assigning state", () => {
    const resources = new Set<string>();
    const disposals: string[] = [];
    const registry = createRunRegistry({
      handler: {
        createRunState: (run) => {
          if (run.id === "broken") {
            resources.add(run.id);
            throw new Error("construction failed before state");
          }
          return {};
        },
        disposeRunState: (run, reason) => {
          if (resources.delete(run.id)) disposals.push(reason);
        },
      },
      maximumRuns: 3,
    });

    expect(() => registry.create({ id: "broken", scenario: "happy" })).toThrow(/creation failed/i);
    expect(resources.size).toBe(0);
    expect(disposals).toEqual(["run-construction-failed"]);
    expect(registry.size()).toBe(1);
    registry.close();
  });

  it("validates run ids before TTL cleanup can dispose unrelated runs", () => {
    let registryTime = 10_000;
    const disposals: Array<{ runId: string; reason: string }> = [];
    const registry = createRunRegistry({
      handler: {
        createRunState: () => ({}),
        disposeRunState: (run, reason) => disposals.push({ runId: run.id, reason }),
      },
      maximumRuns: 2,
      runTtlMs: 1_000,
      now: () => registryTime,
    });
    registry.create({ id: "other", scenario: "happy", authScope: "public", seed: "other" });
    registryTime += 1_001;

    expect(() => registry.get("INVALID!")).toThrow(/invalid fixture run id/i);
    for (const options of [
      { id: "INVALID!", scenario: "happy", authScope: "public", seed: "valid" },
      { id: "valid-id", scenario: "surprise", authScope: "public", seed: "valid" },
      { id: "valid-id", scenario: "happy", authScope: "bad scope", seed: "valid" },
      { id: "valid-id", scenario: "happy", authScope: "public", seed: "bad\nseed" },
    ]) {
      expect(() => registry.create(options as never)).toThrow(/invalid|scenario/i);
      expect(registry.size()).toBe(2);
      expect(disposals).toEqual([]);
    }
    expect(registry.size()).toBe(2);
    expect(disposals).toEqual([]);

    registry.cleanupExpired();
    expect(registry.size()).toBe(1);
    expect(disposals).toEqual([{ runId: "other", reason: "ttl-expired" }]);
    expect(registry.close()).toEqual([]);
  });

  it("caps retained idempotency receipts for both mutable sample handlers", async () => {
    const firstMap = await start({ sampleId: "first-map" });
    for (let index = 0; index < 128; index += 1) {
      const response = await fetch(`${firstMap.origin}/__fixture__/runs/default/actions/edit`, {
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
    const firstMapOverflow = await fetch(`${firstMap.origin}/__fixture__/runs/default/actions/edit`, {
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

  it("keeps the fresh run active when detached old-state disposal mutates and fails", async () => {
    let constructions = 0;
    const registry = createRunRegistry({
      handler: {
        createRunState: () => {
          constructions += 1;
          return { marker: `state-${constructions}` };
        },
        inspectRunState: (target) => ({ marker: target.state.marker }),
        disposeRunState: (target, reason) => {
          if (reason === "reset") {
            if (!target.state) throw new Error("reset disposal lost its detached state");
            target.state.marker = "partially-disposed-old-state";
            throw new Error("sensitive reset failure");
          }
        },
      },
    });
    const run = registry.get();
    const oldState = run.state;
    await expect(registry.reset(run)).resolves.toBe(run);
    expect(oldState).toEqual({ marker: "partially-disposed-old-state" });
    expect(run.state).not.toBe(oldState);
    expect(registry.snapshot(run).state).toEqual({ marker: "state-2" });
    await expect(registry.mutate(run, (activeRun) => activeRun.state.marker)).resolves.toBe("state-2");
    expect(registry.disposalErrors()).toEqual([
      { runId: "default", reason: "reset", message: "Fixture run disposal failed." },
    ]);
    registry.close();
  });

  it("cleans a partial replacement candidate without disposing or replacing active state", async () => {
    let constructions = 0;
    const disposals: Array<{ reason: string; marker: string }> = [];
    const registry = createRunRegistry({
      handler: {
        createRunState: (target) => {
          constructions += 1;
          if (constructions === 2) {
            target.state = { marker: "partial-candidate" };
            throw new Error("sensitive construction failure");
          }
          return { marker: `state-${constructions}` };
        },
        disposeRunState: (target, reason) => {
          disposals.push({ reason, marker: (target.state as { marker: string }).marker });
        },
      },
    });
    const run = registry.get();
    const state = run.state;
    const clock = run.clock;
    await expect(registry.reset(run)).rejects.toThrow(/constructing replacement state/i);
    expect(run.state).toBe(state);
    expect(run.clock).toBe(clock);
    expect(disposals).toEqual([{ reason: "reset-candidate-construction-failed", marker: "partial-candidate" }]);
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
