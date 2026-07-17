import { readFile } from "node:fs/promises";

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CANONICAL_SERVICE_EXPLORER_LIVE_ENDPOINTS,
  collectServiceExplorerLiveEvidence,
  createBoundedServiceExplorerFetch,
  createServiceExplorerLiveTargets,
  validateServiceExplorerLiveEndpoint,
} from "../examples/service-explorer/live-evidence.mjs";
import {
  type ServiceExplorerFixtureServer,
  startServiceExplorerFixtureServer,
} from "../examples/service-explorer/mock-server.mjs";
import {
  generateCiSelection,
  validateEvidenceEnvelope,
  validateLiveEvidenceProducer,
} from "../scripts/sample-contract.mjs";

const SOURCE_REVISION = "1".repeat(40);
const OBSERVED_AT = "2026-07-17T12:00:00.000Z";
const openServers: ServiceExplorerFixtureServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function fixtureServer(): Promise<ServiceExplorerFixtureServer> {
  const server = await startServiceExplorerFixtureServer({ build: false });
  openServers.push(server);
  return server;
}

describe("Service Explorer public-live evidence producer", () => {
  it("validates one bounded GeoServices and OGC observation against the canonical evidence schema", async () => {
    const fixture = await fixtureServer();
    const requests: Request[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return fetch(request);
    });
    const targets = createServiceExplorerLiveTargets({
      geoservicesUrl: `${fixture.url}/fixtures/geoservices/rest/services/CitizenRequests/FeatureServer/0`,
      ogcUrl: `${fixture.url}/fixtures/ogc`,
      ogcSourceId: "places",
      allowLoopback: true,
    });

    const evidence = await collectServiceExplorerLiveEvidence({
      targets,
      allowLoopback: true,
      fetchFn,
      observedAt: OBSERVED_AT,
      sourceRevision: SOURCE_REVISION,
    });

    expect(validateEvidenceEnvelope(evidence, { now: OBSERVED_AT })).toBe(evidence);
    const schema = JSON.parse(
      await readFile("samples/contract/v1/schemas/sample-evidence.schema.json", "utf8"),
    ) as object;
    const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validateSchema(evidence), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(evidence).toMatchObject({
      sampleId: "service-explorer",
      lane: "live",
      status: "executed",
      authMode: "anonymous",
      sdk: { gitCommit: SOURCE_REVISION },
      source: { endpoint: `${fixture.url}/fixtures/ogc` },
      semantics: {
        outcome: "geoservices-and-ogc-plans-executed",
        itemCount: 2,
      },
      degradation: { state: "none", reasons: [] },
    });

    const catalog = JSON.parse(await readFile("samples/catalog.v2.json", "utf8"));
    const sample = catalog.samples.find((candidate: { id: string }) => candidate.id === "service-explorer");
    await expect(
      validateLiveEvidenceProducer(evidence as unknown as Record<string, unknown>, sample),
    ).resolves.toBeUndefined();
    const selection = generateCiSelection(catalog);
    expect(selection.samples.find((candidate) => candidate.id === "service-explorer")).toMatchObject({
      track: "lab",
      commandPlan: {
        liveEvidence: {
          execution: "scheduled-only",
          commands: ["npm run demo:service-explorer:live-evidence"],
        },
      },
      liveEvidence: { mode: "public-live", status: "planned" },
    });

    const geoservicesQuery = requests.find((request) => request.url.includes("/FeatureServer/0/query?"));
    const ogcQuery = requests.find((request) => request.url.includes("/collections/places/items?"));
    expect(new URL(geoservicesQuery?.url ?? "about:blank").searchParams.get("resultRecordCount")).toBe("1");
    expect(new URL(ogcQuery?.url ?? "about:blank").searchParams.get("limit")).toBe("1");
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests.length).toBeLessThanOrEqual(12);
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("x-api-key")).toBeNull();
    }
  });

  it("pins production targets to credential-free HTTPS DNS endpoints", () => {
    expect(createServiceExplorerLiveTargets()).toMatchObject([
      {
        id: "geoservices",
        protocol: "geoservices-feature-service",
        url: CANONICAL_SERVICE_EXPLORER_LIVE_ENDPOINTS.geoservices,
        sourceId: "0",
      },
      {
        id: "ogc",
        protocol: "ogc-features",
        url: CANONICAL_SERVICE_EXPLORER_LIVE_ENDPOINTS.ogc,
        sourceId: "lakes",
        collectionId: "lakes",
      },
    ]);
    expect(() => validateServiceExplorerLiveEndpoint("http://public.example.test/service")).toThrow("HTTPS");
    expect(() => validateServiceExplorerLiveEndpoint("https://user:password@example.test/service")).toThrow(
      "credentials",
    );
    expect(() => validateServiceExplorerLiveEndpoint("https://example.test/service?access_token=secret")).toThrow(
      "queries",
    );
    expect(() => validateServiceExplorerLiveEndpoint("https://127.0.0.1/service")).toThrow("public DNS");
    expect(() => createServiceExplorerLiveTargets({ ogcSourceId: "../unbounded" })).toThrow(
      "bounded structural identifier",
    );
  });

  it("fails closed on credential headers, oversized responses, and deadlines without external traffic", async () => {
    const fixture = await fixtureServer();
    const guardedFetch = createBoundedServiceExplorerFetch({
      targetUrl: `${fixture.url}/fixtures/ogc`,
      allowLoopback: true,
      budgets: {
        requestTimeoutMs: 50,
        maxRequestsPerTarget: 2,
        maxResponseBytes: 64 * 1024,
        maxTotalResponseBytes: 64 * 1024,
      },
    });
    await expect(
      guardedFetch(`${fixture.url}/fixtures/ogc`, {
        headers: { Authorization: "Bearer fixture-value-that-must-not-leave" },
      }),
    ).rejects.toThrow("credential headers");

    const oversizedTargets = createServiceExplorerLiveTargets({
      geoservicesUrl: `${fixture.url}/fixtures/geoservices/rest/services/CitizenRequests/FeatureServer/0`,
      ogcUrl: `${fixture.url}/fixtures/ogc`,
      ogcSourceId: "places",
      allowLoopback: true,
    });
    await expect(
      collectServiceExplorerLiveEvidence({
        targets: oversizedTargets,
        allowLoopback: true,
        observedAt: OBSERVED_AT,
        sourceRevision: SOURCE_REVISION,
        budgets: {
          requestTimeoutMs: 500,
          maxRequestsPerTarget: 12,
          maxResponseBytes: 64,
          maxTotalResponseBytes: 128,
        },
      }),
    ).rejects.toThrow("byte budget");

    const deadlineFetch = createBoundedServiceExplorerFetch({
      targetUrl: `${fixture.url}/fixtures/slow-ogc`,
      allowLoopback: true,
      budgets: {
        requestTimeoutMs: 25,
        maxRequestsPerTarget: 1,
        maxResponseBytes: 64 * 1024,
        maxTotalResponseBytes: 64 * 1024,
      },
    });
    await expect(deadlineFetch(`${fixture.url}/fixtures/slow-ogc`)).rejects.toMatchObject({
      name: expect.stringMatching(/^(AbortError|TimeoutError)$/u),
    });
  });
});
