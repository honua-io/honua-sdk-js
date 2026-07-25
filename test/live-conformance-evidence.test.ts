/**
 * Deterministic, always-on coverage for the scheduled live-conformance lane
 * (issue #535).
 *
 * The lane itself only runs on a schedule against public reference services;
 * this spec drives the same runner over
 * `test/helpers/live-conformance-reference-services.ts` so the parts that must
 * never rot — the reviewed endpoint manifest, the redaction policy, the request
 * budgets, the typed degradation vocabulary, and the semantic assertions that
 * separate an upstream outage from an SDK regression — are gated on every
 * commit with zero network access.
 */

import fs from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  LIVE_CONFORMANCE_EVIDENCE_FORMAT,
  assertLiveConformanceEvidenceRedacted,
  availabilityStatusCode,
  classifyLiveConformanceFailure,
  collectLiveConformanceEvidence,
  createBoundedLiveConformanceFetch,
  imageSignatureOf,
  isCredentialQueryParameter,
  isLiveConformanceEnabled,
  loadLiveConformanceEndpointManifest,
  normalizeLiveConformanceBudgets,
  redactLiveConformanceEndpoint,
  redactQueryParameters,
  summarizeLiveConformanceEvidence,
  validateLiveConformanceEndpoint,
  validateLiveConformanceEndpointManifest,
  validateLiveConformanceEvidence,
} from "../scripts/live-conformance-evidence.mjs";
import { HonuaClient, connect, explainQuery } from "../src/index.js";
import { projectRasterSourceToMapLibre } from "../src/map/index.js";
import {
  REFERENCE_ROUTE_KEYS,
  REFERENCE_TILE_JPEG,
  createReferenceServiceFetch,
} from "./helpers/live-conformance-reference-services.js";

const sdk = { connect, explainQuery, HonuaClient, projectRasterSourceToMapLibre };
const OBSERVED_AT = "2026-07-25T12:00:00.000Z";
const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";

const ajv = new Ajv2020.default({ strict: false, allErrors: true });
const validateAgainstSchema = (relativePath: string) =>
  ajv.compile(JSON.parse(fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")));
const evidenceSchema = validateAgainstSchema("schemas/live-conformance-evidence.v1.json");
const endpointManifestSchema = validateAgainstSchema("config/live-conformance-endpoints.schema.json");

function expectSchemaValid(validate: ReturnType<typeof ajv.compile>, document: unknown): void {
  const valid = validate(document);
  if (!valid) throw new Error(`schema validation failed: ${JSON.stringify(validate.errors?.slice(0, 4))}`);
  expect(valid).toBe(true);
}

function runOffline(
  overrides: Record<string, ((url: URL) => Response) | null> = {},
  options: Record<string, unknown> = {},
) {
  return collectLiveConformanceEvidence({
    enabled: true,
    observedAt: OBSERVED_AT,
    sourceRevision: SOURCE_REVISION,
    sdk,
    fetchFn: createReferenceServiceFetch({ overrides }),
    ...options,
  });
}

describe("live-conformance endpoint manifest", () => {
  const { manifest, sha256 } = loadLiveConformanceEndpointManifest();

  it("is a versioned, reviewed, anonymous manifest with nested budgets", () => {
    expectSchemaValid(endpointManifestSchema, manifest);
    expect(manifest.format).toBe("honua.sdk.live-conformance-endpoints.v1");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.manifestEvidenceId).toBe("live-conformance");
    expect(manifest.defaults.authMode).toBe("anonymous");
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    const budgets = normalizeLiveConformanceBudgets(manifest.budgets);
    expect(budgets.requestTimeoutMs).toBeLessThanOrEqual(budgets.targetTimeoutMs);
    expect(budgets.targetTimeoutMs).toBeLessThanOrEqual(budgets.runTimeoutMs);
    expect(budgets.maxPageSize).toBeLessThanOrEqual(25);
    expect(budgets.maxRetriesPerRequest).toBeLessThanOrEqual(2);
  });

  it("spans the GeoServices, OGC API, WFS, WMS, WMTS, STAC, and OData families", () => {
    const protocols = manifest.targets.map((target) => target.protocol);
    expect(protocols).toContain("geoservices-feature-service");
    expect(protocols).toContain("ogc-features");
    expect(protocols).toContain("wfs");
    expect(protocols).toContain("wms");
    expect(protocols).toContain("wmts");
    expect(protocols).toContain("stac");
    expect(protocols).toContain("odata");
    // Two independently implemented OGC API Features servers, so one vendor's
    // landing-page shape cannot pass for the standard.
    expect(protocols.filter((protocol) => protocol === "ogc-features")).toHaveLength(2);
  });

  it("carries owner, review expiry, provider attribution, and reviewer notes for every target", () => {
    for (const target of manifest.targets) {
      expect(target.owner.length).toBeGreaterThan(2);
      expect(Date.parse(target.reviewExpiresAt)).toBeGreaterThan(Date.parse(target.reviewedAt));
      expect(target.attribution.length).toBeGreaterThan(1);
      expect(target.notes.length).toBeGreaterThanOrEqual(10);
      expect(target.endpoint.startsWith("https://")).toBe(true);
      expect(target.endpoint).not.toContain("?");
      expect(target.expect.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("rejects credentialed, non-public, or unreviewed targets", () => {
    expect(() => validateLiveConformanceEndpoint("https://example.test/svc?token=abc")).toThrow(/credentials, query/);
    expect(() => validateLiveConformanceEndpoint("http://example.test/svc")).toThrow(/HTTPS/);
    expect(() => validateLiveConformanceEndpoint("https://user:pw@example.test/svc")).toThrow(/credentials/);
    expect(() => validateLiveConformanceEndpoint("https://127.0.0.1/svc")).toThrow(/public DNS/);
    expect(() => validateLiveConformanceEndpoint("https://localhost/svc")).toThrow(/public DNS/);
    expect(validateLiveConformanceEndpoint("http://127.0.0.1:8080/svc", { allowLoopback: true })).toBe(
      "http://127.0.0.1:8080/svc",
    );
  });

  it("fails closed on manifest drift", () => {
    const clone = (mutate: (draft: any) => void) => {
      const draft = JSON.parse(JSON.stringify(manifest));
      mutate(draft);
      return draft;
    };
    const expectDrift = (mutate: (draft: any) => void, pattern: RegExp) => {
      expect(() => validateLiveConformanceEndpointManifest(clone(mutate))).toThrow(pattern);
    };
    expectDrift((draft) => {
      draft.format = "other";
    }, /format drift/);
    expectDrift((draft) => {
      draft.defaults.authMode = "api-key";
    }, /anonymous/);
    expectDrift((draft) => {
      draft.targets[0].reviewExpiresAt = "2099-01-01";
    }, /review window exceeds/);
    expectDrift((draft) => {
      draft.targets[0].enabled = false;
    }, /typed skip metadata/);
    expectDrift((draft) => {
      draft.targets = draft.targets.filter((target: { protocol: string }) => target.protocol !== "wmts");
    }, /covers no target for the wmts family/);
    expectDrift((draft) => {
      draft.targets[1].id = draft.targets[0].id;
    }, /duplicated/);
  });
});

describe("live-conformance redaction policy", () => {
  it("records parameter names always and values only for the reviewed allowlist", () => {
    const parameters = redactQueryParameters(new URLSearchParams("f=json&limit=1&api_key=secret&sig=abc123"));
    expect(parameters).toEqual([
      { name: "f", value: "json" },
      { name: "limit", value: "1" },
      { name: "api_key", value: null },
      { name: "sig", value: null },
    ]);
  });

  it("recognizes credential parameters across naming conventions", () => {
    for (const name of ["token", "access_token", "accessToken", "X-Api-Key", "apikey", "AWSAccessKeyId", "sig"]) {
      expect(isCredentialQueryParameter(name)).toBe(true);
    }
    for (const name of ["limit", "bbox", "typeNames", "$top", "resultRecordCount"]) {
      expect(isCredentialQueryParameter(name)).toBe(false);
    }
  });

  it("keeps endpoint identities free of queries and fragments", () => {
    expect(redactLiveConformanceEndpoint("https://demo.pygeoapi.io/master")).toEqual({
      identity: "demo.pygeoapi.io/master",
      origin: "https://demo.pygeoapi.io",
      path: "/master",
    });
  });

  it("fails closed when a credential pattern reaches the artifact", async () => {
    const evidence = await runOffline();
    expect(() =>
      assertLiveConformanceEvidenceRedacted({
        ...evidence,
        targets: [
          {
            ...evidence.targets[0],
            traffic: {
              ...evidence.targets[0].traffic,
              ledger: [
                {
                  method: "GET",
                  path: "/svc",
                  status: 200,
                  bytes: 1,
                  mediaType: "application/json",
                  parameters: [{ name: "access_token", value: null }],
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/credential parameter/);
    expect(() => assertLiveConformanceEvidenceRedacted({ ...evidence, reason: "Bearer abcdefghij123456" })).toThrow(
      /credential pattern/,
    );
  });
});

describe("live-conformance request budgets", () => {
  const budgets = normalizeLiveConformanceBudgets({
    runTimeoutMs: 5_000,
    targetTimeoutMs: 4_000,
    requestTimeoutMs: 3_000,
    maxRequestsPerTarget: 2,
    maxResponseBytes: 64,
    maxTotalResponseBytes: 128,
    maxRetriesPerRequest: 0,
    maxPageSize: 1,
  });

  it("rejects budgets that are not nested or not integral", () => {
    expect(() => normalizeLiveConformanceBudgets({ ...budgets, requestTimeoutMs: 9_000 })).toThrow(/nest/);
    expect(() => normalizeLiveConformanceBudgets({ ...budgets, maxResponseBytes: 1_000 })).toThrow(
      /exceed the total response budget/,
    );
    expect(() => normalizeLiveConformanceBudgets({ ...budgets, maxRequestsPerTarget: 0 })).toThrow(/safe integer/);
  });

  it("caps the request count per target", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const bounded = createBoundedLiveConformanceFetch({
      targetUrl: "https://demo.pygeoapi.io/master",
      budgets,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await bounded("https://demo.pygeoapi.io/master");
    await bounded("https://demo.pygeoapi.io/master/conformance");
    await expect(bounded("https://demo.pygeoapi.io/master/collections")).rejects.toThrow(/2-request/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("caps the response size and refuses redirects, other origins, writes, and credentials", async () => {
    const bounded = createBoundedLiveConformanceFetch({
      targetUrl: "https://demo.pygeoapi.io/master",
      budgets: { ...budgets, maxRequestsPerTarget: 32 },
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = new URL(new Request(input).url);
        if (url.pathname.endsWith("/huge")) {
          return new Response("x".repeat(4_096), { headers: { "content-type": "application/json" } });
        }
        if (url.pathname.endsWith("/moved")) {
          return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
        }
        if (url.pathname.endsWith("/html")) {
          return new Response("<html/>", { headers: { "content-type": "text/html" } });
        }
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    await expect(bounded("https://demo.pygeoapi.io/master/huge")).rejects.toThrow(/byte budget/);
    await expect(bounded("https://demo.pygeoapi.io/master/moved")).rejects.toThrow(/redirect/);
    await expect(bounded("https://demo.pygeoapi.io/master/html")).rejects.toThrow(/unreviewed text\/html/);
    await expect(bounded("https://elsewhere.test/master")).rejects.toThrow(/same-origin/);
    await expect(bounded("https://demo.pygeoapi.io/master", { method: "POST" })).rejects.toThrow(/GET\/HEAD/);
    await expect(
      bounded("https://demo.pygeoapi.io/master", { headers: { authorization: "Bearer nope" } }),
    ).rejects.toThrow(/credential headers/);
    await expect(bounded("https://demo.pygeoapi.io/master?token=nope")).rejects.toThrow(/credential query/);
  });

  it("classifies availability statuses inside the fetch seam", async () => {
    expect(availabilityStatusCode(429)).toBe("endpoint-rate-limited");
    expect(availabilityStatusCode(408)).toBe("endpoint-timeout");
    expect(availabilityStatusCode(503)).toBe("endpoint-server-error");
    expect(availabilityStatusCode(404)).toBeNull();
    expect(availabilityStatusCode(200)).toBeNull();

    const bounded = createBoundedLiveConformanceFetch({
      targetUrl: "https://demo.pygeoapi.io/master",
      budgets: { ...budgets, maxRequestsPerTarget: 32 },
      fetchFn: (async (input: RequestInfo | URL) => {
        const status = Number(new URL(new Request(input).url).pathname.split("/").pop());
        return new Response(status === 200 ? "{}" : "upstream", {
          status,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    for (const [status, code] of [
      [429, "endpoint-rate-limited"],
      [503, "endpoint-server-error"],
      [408, "endpoint-timeout"],
    ] as const) {
      await expect(bounded(`https://demo.pygeoapi.io/master/${status}`)).rejects.toMatchObject({ reasonCode: code });
    }
    // A 4xx still reaches the SDK, which turns it into a semantic failure.
    await expect(bounded("https://demo.pygeoapi.io/master/404")).resolves.toMatchObject({ status: 404 });
  });

  it("keeps a typed transport reason when the SDK wraps the rejection", () => {
    const wrapped = new Error("HonuaNetworkError", {
      cause: Object.assign(new Error("HTTP 503"), { reasonCode: "endpoint-server-error" }),
    });
    wrapped.name = "HonuaNetworkError";
    expect(classifyLiveConformanceFailure(wrapped).code).toBe("endpoint-server-error");
  });

  it("classifies availability problems apart from semantic ones", () => {
    expect(classifyLiveConformanceFailure({ name: "HonuaNetworkError", message: "fetch failed" }).code).toBe(
      "endpoint-unreachable",
    );
    expect(classifyLiveConformanceFailure({ name: "TimeoutError", message: "timed out" }).code).toBe(
      "endpoint-timeout",
    );
    expect(classifyLiveConformanceFailure({ name: "HonuaHttpError", message: "HTTP 503: down" }).code).toBe(
      "endpoint-server-error",
    );
    expect(classifyLiveConformanceFailure({ name: "HonuaHttpError", message: "HTTP 429: slow down" }).code).toBe(
      "endpoint-rate-limited",
    );
    expect(classifyLiveConformanceFailure({ name: "HonuaHttpError", message: "HTTP 404: gone" }).code).toBe(
      "endpoint-client-error",
    );
    expect(classifyLiveConformanceFailure({ sdkCode: "core.capability-not-supported", message: "no" }).code).toBe(
      "capability-regression",
    );
  });

  it("reads image signatures for the bounded tile assertion", () => {
    expect(imageSignatureOf(REFERENCE_TILE_JPEG)).toBe("jpeg");
    expect(imageSignatureOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
    expect(imageSignatureOf(new Uint8Array([0x3c, 0x21]))).toBe("unknown");
  });
});

describe("live-conformance network gate", () => {
  it("is scheduled/manual only", () => {
    expect(isLiveConformanceEnabled({})).toBe(false);
    expect(isLiveConformanceEnabled({ HONUA_LIVE_CONFORMANCE_ENABLED: "false" })).toBe(false);
    expect(isLiveConformanceEnabled({ HONUA_LIVE_CONFORMANCE_ENABLED: "true" })).toBe(true);
    expect(isLiveConformanceEnabled({ HONUA_LIVE_CONFORMANCE_ENABLED: "1" })).toBe(true);
  });

  it("emits a valid skipped artifact with typed reasons and never touches fetch", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const evidence = await collectLiveConformanceEvidence({
      enabled: false,
      observedAt: OBSERVED_AT,
      sourceRevision: SOURCE_REVISION,
      fetchFn,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expectSchemaValid(evidenceSchema, evidence);
    expect(evidence.format).toBe(LIVE_CONFORMANCE_EVIDENCE_FORMAT);
    expect(evidence.status).toBe("skipped");
    expect(evidence.totals.skipped).toBe(evidence.totals.targets);
    for (const target of evidence.targets) {
      expect(target.status).toBe("skipped");
      expect(target.degradation.state).toBe("muted");
      expect(target.degradation.reasons[0]?.code).toBe("live-lane-disabled");
      expect(target.degradation.reasons[0]?.owner.length).toBeGreaterThan(2);
      expect(target.degradation.reasons[0]?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(summarizeLiveConformanceEvidence(evidence).exitCode).toBe(0);
    expect(summarizeLiveConformanceEvidence(evidence, { strict: true }).exitCode).toBe(1);
  });
});

describe("live-conformance journeys against the deterministic reference services", () => {
  it("drives discovery plus one bounded supported operation for every reviewed target", async () => {
    const evidence = await runOffline();
    expectSchemaValid(evidenceSchema, evidence);
    expect(evidence.status).toBe("executed");
    expect(evidence.totals.executed).toBe(evidence.totals.targets);
    expect(evidence.totals.failed).toBe(0);
    expect(evidence.totals.degraded).toBe(0);
    expect(evidence.sdk.gitCommit).toBe(SOURCE_REVISION);
    expect(evidence.runner.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.endpointManifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validateLiveConformanceEvidence(evidence, { now: OBSERVED_AT })).toBe(evidence);

    for (const target of evidence.targets) {
      expect(target.status).toBe("executed");
      expect(target.discovery?.protocol).toBe(target.protocol);
      expect(target.discovery?.sourceId).toBeTruthy();
      // REQ-002: per-operation truth, not a single protocol boolean.
      expect(target.discovery?.capabilityDecisions.length ?? 0).toBeGreaterThan(1);
      expect(target.operation).not.toBeNull();
      expect(target.assertions.length).toBeGreaterThan(3);
      expect(target.assertions.every((assertion) => assertion.outcome === "pass")).toBe(true);
      expect(target.traffic.requests).toBeGreaterThan(0);
      expect(target.traffic.requests).toBeLessThanOrEqual(evidence.budgets.maxRequestsPerTarget);
      expect(target.traffic.responseBytes).toBeLessThanOrEqual(evidence.budgets.maxTotalResponseBytes);
      for (const entry of target.traffic.ledger) {
        expect(entry.method).toBe("GET");
        expect(entry.path.startsWith("/")).toBe(true);
      }
    }
  });

  it("records conformance-class or capabilities-operation evidence per protocol family", async () => {
    const evidence = await runOffline();
    const byId = new Map(evidence.targets.map((target) => [target.id, target]));

    const pygeoapi = byId.get("pygeoapi-demo-lakes");
    expect(pygeoapi?.discovery?.conformance.kind).toBe("ogc-features-conformance-classes");
    expect(pygeoapi?.discovery?.conformance.classes).toContain(
      "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    );

    const stac = byId.get("earth-search-sentinel-2-l2a");
    expect(stac?.discovery?.conformance.kind).toBe("stac-landing-conformance-classes");
    expect(stac?.discovery?.conformance.classes).toContain("https://api.stacspec.org/v1.0.0/item-search");

    const wms = byId.get("terrestris-osm-wms");
    expect(wms?.discovery?.conformance.kind).toBe("capabilities-document-operations");
    expect(wms?.discovery?.protocolVersion).toBe("1.3.0");
    expect(wms?.discovery?.conformance.operations.map((operation) => operation.name)).toContain("render");

    const geoservices = byId.get("esri-sampleserver6-citizen-requests");
    expect(geoservices?.discovery?.conformance.kind).toBe("service-metadata-operations");
    expect(geoservices?.discovery?.conformance.operations.some((operation) => operation.available)).toBe(true);

    // WFS keeps its operation truth in the capability decisions rather than a
    // metadata operations map; the artifact still records operations.
    const wfs = byId.get("pdok-bag-wfs-woonplaats");
    expect(wfs?.discovery?.conformance.operations.length ?? 0).toBeGreaterThan(0);

    for (const target of evidence.targets) {
      const conformance = target.discovery?.conformance;
      expect((conformance?.classes.length ?? 0) + (conformance?.operations.length ?? 0)).toBeGreaterThan(0);
      expect(target.assertions.map((assertion) => assertion.id)).toContain(
        "discovery-records-operation-or-conformance-class-evidence",
      );
    }
  });

  it("proves the query journey parses a bounded page and refuses unadvertised operations", async () => {
    const evidence = await runOffline();
    for (const target of evidence.targets.filter((candidate) => candidate.journey === "query")) {
      expect(target.operation?.kind).toBe("source-query");
      expect(target.operation?.itemCount).toBe(1);
      expect(target.operation?.requestedLimit).toBe(1);
      expect(target.operation?.attributeCount ?? 0).toBeGreaterThan(0);
      expect(target.operation?.degradedReasons).toEqual([]);
      expect(target.operation?.capabilityGuard?.sdkCode).toBe("core.capability-not-supported");
    }
    const stac = evidence.targets.find((target) => target.protocol === "stac");
    // STAC has no deterministic query compiler; that is recorded, not faked.
    expect(stac?.operation?.plan?.available).toBe(false);
    expect(stac?.operation?.plan?.reason).toMatch(/compiler/);
    const pygeoapi = evidence.targets.find((target) => target.id === "pygeoapi-demo-lakes");
    expect(pygeoapi?.operation?.plan?.available).toBe(true);
    expect(pygeoapi?.operation?.plan?.fidelity).toBe("exact");
    expect(pygeoapi?.operation?.plan?.requestUpperBound).toBe(1);
  });

  it("proves the raster journey projects a MapLibre template and fetches one bounded tile", async () => {
    const evidence = await runOffline();
    const raster = evidence.targets.filter((target) => target.journey === "raster-tiles");
    expect(raster).toHaveLength(2);
    const wms = raster.find((target) => target.protocol === "wms");
    expect(wms?.operation?.raster?.strategy).toBe("wms-raster");
    expect(wms?.operation?.raster?.mediaType).toBe("image/jpeg");
    expect(wms?.operation?.raster?.signature).toBe("jpeg");
    expect(wms?.operation?.raster?.bytes).toBe(REFERENCE_TILE_JPEG.byteLength);
    const wmts = raster.find((target) => target.protocol === "wmts");
    expect(wmts?.operation?.raster?.strategy).toBe("wmts-raster");
    expect(wmts?.operation?.raster?.tile).toEqual({ z: 0, x: 0, y: 0 });
  });

  it("proves the capability-gap contract on every executed target, raster included", async () => {
    const evidence = await runOffline();
    for (const target of evidence.targets) {
      expect(target.status).toBe("executed");
      // A raster target must exercise the guard too; a missing guard used to
      // be silently skipped, which let the artifact overstate what it proved.
      expect(target.operation?.capabilityGuard).not.toBeNull();
      expect(target.operation?.capabilityGuard?.errorName).toBe("HonuaCapabilityNotSupportedError");
      expect(target.operation?.capabilityGuard?.sdkCode).toBe("core.capability-not-supported");
      expect(target.assertions.map((assertion) => assertion.id)).toEqual(
        expect.arrayContaining([
          "capability-guard-resolves-a-source",
          "capability-guard-finds-an-unadvertised-operation",
          "unadvertised-operations-throw-instead-of-returning-empty-data",
        ]),
      );
    }
    const raster = evidence.targets.filter((target) => target.journey === "raster-tiles");
    expect(raster.map((target) => target.operation?.capabilityGuard?.capability)).toEqual(["query", "query"]);
  });

  it("refuses to publish an executed target that skipped the capability-gap proof", async () => {
    const evidence = await runOffline();
    const tampered = {
      ...evidence,
      targets: evidence.targets.map((target, index) =>
        index === 0 ? { ...target, operation: { ...target.operation, capabilityGuard: null } } : target,
      ),
    };
    expect(() => validateLiveConformanceEvidence(tampered, { now: OBSERVED_AT })).toThrow(
      /executed without proving that an unadvertised operation throws/,
    );
  });
});

describe("live-conformance degrades honestly", () => {
  it("reports an unreachable endpoint as a typed degradation with owner and expiry", async () => {
    const evidence = await runOffline({
      [REFERENCE_ROUTE_KEYS.pygeoapiLanding]: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(evidence.status).toBe("degraded");
    const target = evidence.targets.find((candidate) => candidate.id === "pygeoapi-demo-lakes");
    expect(target?.status).toBe("degraded");
    expect(target?.degradation.state).toBe("unavailable");
    expect(target?.degradation.reasons[0]?.code).toBe("endpoint-unreachable");
    expect(target?.degradation.reasons[0]?.owner).toBe(target?.owner);
    expect(target?.degradation.reasons[0]?.expiresAt).toBe(target?.reviewExpiresAt);
    expect(target?.operation).toBeNull();
    // The rest of the lane still executes; one outage never hides the others.
    expect(evidence.totals.executed).toBe(evidence.totals.targets - 1);
    expect(summarizeLiveConformanceEvidence(evidence).exitCode).toBe(2);
    expect(summarizeLiveConformanceEvidence(evidence, { allowDegraded: true }).exitCode).toBe(0);
    expect(validateLiveConformanceEvidence(evidence, { now: OBSERVED_AT })).toBe(evidence);
    expectSchemaValid(evidenceSchema, evidence);
  });

  it("treats an upstream 5xx as unavailable but an SDK-visible 4xx as a failure", async () => {
    const down = await runOffline({
      [REFERENCE_ROUTE_KEYS.wfsCapabilities]: () => new Response("maintenance", { status: 503 }),
    });
    const wfsDown = down.targets.find((target) => target.protocol === "wfs");
    expect(wfsDown?.status).toBe("degraded");
    expect(wfsDown?.degradation.reasons[0]?.code).toBe("endpoint-server-error");

    const gone = await runOffline({ [REFERENCE_ROUTE_KEYS.wfsGetFeature]: null });
    const wfsGone = gone.targets.find((target) => target.protocol === "wfs");
    expect(wfsGone?.status).toBe("failed");
    expect(wfsGone?.degradation.reasons[0]?.code).toBe("endpoint-client-error");
    expect(gone.status).toBe("failed");
    expect(summarizeLiveConformanceEvidence(gone).exitCode).toBe(1);
  });

  it("fails the lane when an advertised conformance class disappears", async () => {
    const evidence = await runOffline({
      [REFERENCE_ROUTE_KEYS.pygeoapiConformance]: () =>
        new Response(JSON.stringify({ conformsTo: ["http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core"] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const target = evidence.targets.find((candidate) => candidate.id === "pygeoapi-demo-lakes");
    expect(target?.status).toBe("failed");
    expect(target?.degradation.state).toBe("capability-gap");
    expect(target?.degradation.reasons[0]?.code).toBe("capability-regression");
    expect(target?.degradation.reasons[0]?.message).toMatch(/conf\/geojson/);
    expect(evidence.status).toBe("failed");
  });

  it("fails the lane when a 200 response violates the bounded-page contract", async () => {
    const evidence = await runOffline({
      [REFERENCE_ROUTE_KEYS.pygeoapiItems]: () =>
        new Response(
          JSON.stringify({
            type: "FeatureCollection",
            numberMatched: 2,
            numberReturned: 2,
            features: [
              { type: "Feature", id: 1, properties: { name: "a" }, geometry: { type: "Point", coordinates: [0, 0] } },
              { type: "Feature", id: 2, properties: { name: "b" }, geometry: { type: "Point", coordinates: [1, 1] } },
            ],
            links: [],
          }),
          { headers: { "content-type": "application/geo+json" } },
        ),
    });
    const target = evidence.targets.find((candidate) => candidate.id === "pygeoapi-demo-lakes");
    expect(target?.status).toBe("failed");
    expect(target?.degradation.state).toBe("semantic-regression");
    expect(target?.degradation.reasons[0]?.code).toBe("semantic-assertion-failed");
    expect(target?.assertions.at(-1)).toMatchObject({
      id: "bounded-page-honours-the-requested-limit",
      outcome: "fail",
    });
  });

  it("degrades rather than fails when a bounded tile is rate-limited or 5xx", async () => {
    const rateLimited = await runOffline({
      [REFERENCE_ROUTE_KEYS.wmtsTile]: () => new Response("slow down", { status: 429 }),
    });
    const limited = rateLimited.targets.find((target) => target.protocol === "wmts");
    expect(limited?.status).toBe("degraded");
    expect(limited?.degradation.state).toBe("unavailable");
    expect(limited?.degradation.reasons[0]?.code).toBe("endpoint-rate-limited");
    expect(rateLimited.status).toBe("degraded");
    // An ordinary upstream outage must stay inside the availability exit code
    // so --allow-degraded can keep a scheduled run green.
    expect(summarizeLiveConformanceEvidence(rateLimited).exitCode).toBe(2);
    expect(summarizeLiveConformanceEvidence(rateLimited, { allowDegraded: true }).exitCode).toBe(0);

    const serverError = await runOffline({
      [REFERENCE_ROUTE_KEYS.wmsService]: (url) =>
        (url.searchParams.get("REQUEST") ?? "").toLowerCase() === "getmap"
          ? new Response("upstream exploded", { status: 502 })
          : new Response(null, { status: 500 }),
    });
    const wms = serverError.targets.find((target) => target.protocol === "wms");
    expect(wms?.status).toBe("degraded");
    expect(wms?.degradation.reasons[0]?.code).toBe("endpoint-server-error");
    expect(summarizeLiveConformanceEvidence(serverError).exitCode).toBe(2);
  });

  it("enforces the response-byte ceiling across the run, not once per target", async () => {
    // The first two targets consume ~18 KB of the 20 KB run budget offline; a
    // per-target ceiling would have let all eight through.
    const evidence = await runOffline({}, { budgets: { maxResponseBytes: 20_000, maxTotalResponseBytes: 20_000 } });
    expect(evidence.budgets.maxTotalResponseBytes).toBe(20_000);
    expect(evidence.totals.responseBytes).toBeLessThanOrEqual(20_000);
    expect(evidence.totals.executed).toBeGreaterThan(0);
    expect(evidence.totals.executed).toBeLessThan(evidence.totals.targets);
    const starved = evidence.targets.filter((target) => target.status !== "executed");
    expect(starved.length).toBeGreaterThan(0);
    expect(starved[0]?.degradation.reasons[0]?.code).toBe("budget-exceeded");
    expect(starved[0]?.degradation.state).toBe("unavailable");
  });

  it("fails the lane when a bounded tile stops being an image", async () => {
    const evidence = await runOffline({
      [REFERENCE_ROUTE_KEYS.wmtsTile]: () =>
        new Response("<html>rate limited</html>", { status: 200, headers: { "content-type": "image/jpeg" } }),
    });
    const target = evidence.targets.find((candidate) => candidate.protocol === "wmts");
    expect(target?.status).toBe("failed");
    expect(target?.degradation.reasons[0]?.code).toBe("semantic-assertion-failed");
    expect(target?.assertions.at(-1)?.id).toBe("bounded-tile-bytes-match-an-image-signature");
  });

  it("expires muted targets and expired reviews instead of skipping them forever", async () => {
    const { manifest } = loadLiveConformanceEndpointManifest();
    const muted = JSON.parse(JSON.stringify(manifest));
    muted.targets = [
      {
        ...muted.targets[0],
        enabled: false,
        skip: {
          reasonCode: "upstream-service-retired",
          reason: "The upstream sample service was retired by its operator.",
          owner: "honua-io/honua-sdk-js maintainers",
          expiresAt: "2026-12-31",
          tracking: "https://github.com/honua-io/honua-sdk-js/issues/535",
        },
      },
      ...muted.targets.slice(1),
    ];
    const withMute = await collectLiveConformanceEvidence({
      enabled: true,
      manifest: muted,
      observedAt: OBSERVED_AT,
      sourceRevision: SOURCE_REVISION,
      sdk,
      fetchFn: createReferenceServiceFetch(),
    });
    expect(withMute.targets[0].status).toBe("skipped");
    expect(withMute.targets[0].degradation.reasons[0]?.code).toBe("target-muted");
    expect(withMute.targets[0].degradation.reasons[0]?.tracking).toContain("issues/535");

    const stale = JSON.parse(JSON.stringify(muted));
    stale.targets[0].skip.expiresAt = "2026-01-01";
    const withStaleMute = await collectLiveConformanceEvidence({
      enabled: true,
      manifest: stale,
      observedAt: OBSERVED_AT,
      sourceRevision: SOURCE_REVISION,
      sdk,
      fetchFn: createReferenceServiceFetch(),
    });
    expect(withStaleMute.targets[0].status).toBe("failed");
    expect(withStaleMute.targets[0].degradation.reasons[0]?.code).toBe("mute-metadata-expired");

    const expiredReview = await collectLiveConformanceEvidence({
      enabled: true,
      manifest,
      observedAt: "2099-01-01T00:00:00.000Z",
      sourceRevision: SOURCE_REVISION,
      sdk,
      fetchFn: createReferenceServiceFetch(),
    });
    expect(expiredReview.status).toBe("failed");
    expect(expiredReview.targets.every((target) => target.status === "failed")).toBe(true);
    expect(expiredReview.targets[0].degradation.reasons[0]?.code).toBe("endpoint-review-expired");
  });
});
