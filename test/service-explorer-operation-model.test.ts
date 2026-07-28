import { describe, expect, it, vi } from "vitest";

import {
  SERVICE_EXPLORER_MAX_LIMIT,
  SERVICE_EXPLORER_OPERATION_TIMEOUT_MS,
  generateServiceExplorerCode,
  projectServiceExplorerOperations,
} from "../examples/service-explorer/src/operation-model.js";
import type {
  ServiceExplorerCapabilityDecisionView,
  ServiceExplorerReadyState,
} from "../examples/service-explorer/src/truth-model.js";
import { type Query, type Result, type Source, type SourceDescriptor, capabilities } from "../src/contract/index.js";
import type { HonuaKernelConnection } from "../src/index.js";

describe("Service Explorer accepted-operation projection", () => {
  it("enables a feature operation only when inspected truth and both strict planners accept it", () => {
    const descriptor = featureDescriptor();
    const source = fakeSource(descriptor);
    const projection = projectServiceExplorerOperations(
      readyState(descriptor, [decision("query", true), decision("render", true)]),
      fakeConnection(source),
      25,
    );

    expect(projection.actions.query).toMatchObject({ enabled: true, code: "planner.accepted" });
    expect(projection.queryPlan).toMatchObject({
      pushdown: "full",
      fidelity: "exact",
      cache: { action: "bypass", policy: "bypass", reason: "policy-bypass" },
    });
    expect(projection.actions.render).toMatchObject({ enabled: true, code: "map-planner.accepted" });
    expect(projection.renderPlan?.selected?.strategy).toBe("geojson-query");
  });

  it("keeps unsupported actions disabled with the inspected structured reason", () => {
    const descriptor = featureDescriptor();
    const projection = projectServiceExplorerOperations(
      readyState(descriptor, [
        decision("query", false, "not-advertised"),
        decision("render", false, "adapter-unsupported"),
      ]),
      fakeConnection(fakeSource(descriptor)),
    );

    expect(projection.actions.query).toEqual(
      expect.objectContaining({ enabled: false, code: "not-advertised", reason: "query is not-advertised" }),
    );
    expect(projection.actions.render).toEqual(
      expect.objectContaining({ enabled: false, code: "adapter-unsupported", reason: "render is adapter-unsupported" }),
    );
    expect(projection.queryPlan).toBeUndefined();
    expect(projection.renderPlan).toBeUndefined();
  });

  it("rejects an unsafe limit before planning and leaves the foreign Source mutable", () => {
    const descriptor = featureDescriptor();
    const source = fakeSource(descriptor);
    const projection = projectServiceExplorerOperations(
      readyState(descriptor, [decision("query", true), decision("render", true)]),
      fakeConnection(source),
      SERVICE_EXPLORER_MAX_LIMIT + 1,
    );

    expect(projection.actions.query).toMatchObject({ enabled: false, code: "input.invalid-limit" });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
  });

  it("does not treat a render claim as planner acceptance when exact metadata is absent", () => {
    const descriptor: SourceDescriptor = {
      id: "basemap",
      protocol: "maplibre-vector",
      locator: { url: "https://tiles.example.test/{z}/{x}/{y}.pbf" },
      capabilities: capabilities(["render"]),
    };
    const projection = projectServiceExplorerOperations(
      readyState(descriptor, [decision("query", false, "adapter-unsupported"), decision("render", true)]),
      fakeConnection(fakeSource(descriptor)),
    );

    expect(projection.actions.query.enabled).toBe(false);
    expect(projection.actions.render).toMatchObject({ enabled: false, code: "map-planner.missing-metadata" });
  });

  it("generates public-surface code bound to the accepted query plan without credential material", () => {
    const descriptor = featureDescriptor();
    const state = readyState(descriptor, [decision("query", true), decision("render", true)]);
    const projection = projectServiceExplorerOperations(state, fakeConnection(fakeSource(descriptor)));
    const queryCode = generateServiceExplorerCode(state, projection, "query");
    const renderCode = generateServiceExplorerCode(state, projection, "render");

    expect(queryCode).toContain('from "@honua/sdk-js"');
    expect(queryCode).toContain("explainQuery");
    expect(queryCode).toContain(`AbortSignal.timeout(${SERVICE_EXPLORER_OPERATION_TIMEOUT_MS})`);
    expect(queryCode).toContain("executeQueryPlan(queryPlan, source, { signal })");
    expect(renderCode).toContain("explainAutomaticSourceToMapLibre(source, { queryPlan })");
    expect(renderCode).toContain("mountAutomaticSourceToMapLibre(map, source, renderPlan, { queryPlan, signal })");
    expect(renderCode).toContain("mounted.dispose()");
    expect(renderCode).toContain("map.remove()");
    expect(`${queryCode}${renderCode}`).not.toMatch(/secret|token|authorizationScopeFingerprint/i);
  });
});

function featureDescriptor(): SourceDescriptor {
  return {
    id: "places",
    protocol: "geoservices-feature-service",
    locator: { url: "https://services.example.test", serviceId: "places", layerId: 0, srsName: "EPSG:4326" },
    capabilities: capabilities(["query", "render"]),
    schema: { primaryKey: "OBJECTID" },
  };
}

function decision(
  capability: "query" | "render",
  effective: boolean,
  code: ServiceExplorerCapabilityDecisionView["code"] = effective ? "enabled" : "not-advertised",
): ServiceExplorerCapabilityDecisionView {
  return {
    capability,
    effective,
    code,
    reason: effective ? `${capability} is enabled` : `${capability} is ${code}`,
    adapterSupported: code !== "adapter-unsupported",
    positiveEvidence: effective,
    policyAllowed: true,
    evidence: [],
    evidenceTruncated: false,
  };
}

function readyState(
  descriptor: SourceDescriptor,
  capabilityDecisions: readonly ServiceExplorerCapabilityDecisionView[],
): ServiceExplorerReadyState {
  return {
    kind: "ready",
    request: {
      id: 1,
      endpoint: "https://services.example.test",
      protocolHint: descriptor.protocol,
      sourceId: descriptor.id,
      authorization: { mode: "anonymous", scopeIdentity: "public", credentialsRetained: false },
    },
    inspection: {
      service: {
        id: "fixture",
        endpoint: "https://services.example.test",
        protocol: descriptor.protocol,
        protocolHint: descriptor.protocol,
        detection: {
          requestedProtocolHint: descriptor.protocol,
          resolvedProtocol: descriptor.protocol,
          confidence: "not-reported",
        },
        evidenceStates: ["metadata"],
        cache: { scope: "discovery-metadata", status: "bypass", featureData: "not-loaded" },
        authorization: { mode: "anonymous", scopeIdentity: "public", credentialsRetained: false },
      },
      dataset: {
        id: "fixture",
        sourceCount: 1,
        visibleSourceCount: 1,
        sourceIds: [descriptor.id],
        selectedSourceId: descriptor.id,
        selectedSourceVisible: true,
        selectionRequired: false,
      },
      sources: [
        {
          id: descriptor.id,
          protocol: descriptor.protocol,
          locator: { url: descriptor.locator.url },
          discovery: "metadata",
          crsCount: 1,
          crs: ["EPSG:4326"],
          schema: { state: "available", fieldCount: 0, fields: [], truncated: false },
          effectiveCapabilityCount: capabilityDecisions.filter((item) => item.effective).length,
          effectiveCapabilities: capabilityDecisions.filter((item) => item.effective).map((item) => item.capability),
          capabilityDecisionCount: capabilityDecisions.length,
          capabilityDecisions,
          provenanceCount: 0,
          provenance: [],
          truncated: false,
        },
      ],
      diagnostics: [],
      truncated: false,
    },
  };
}

function fakeSource<T = Record<string, unknown>>(descriptor: SourceDescriptor): Source<T> {
  const result: Result<T> = { features: [], exceededTransferLimit: false };
  return {
    descriptor,
    capabilities: descriptor.capabilities,
    query: vi.fn(async (_query: Query<T>) => result),
    queryAll: vi.fn(async (_query: Query<T>) => result),
  } as unknown as Source<T>;
}

function fakeConnection(source: Source<Record<string, unknown>>): HonuaKernelConnection {
  return {
    source: vi.fn(() => source),
  } as unknown as HonuaKernelConnection;
}
