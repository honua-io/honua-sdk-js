import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, PROTOCOLS, PROTOCOL_DEFAULT_CAPABILITIES } from "../../src/contract/index.js";

interface ContractFixture {
  schemaVersion: number;
  canonicalNouns: readonly string[];
  languageBindings: ReadonlyArray<{
    concept: string;
    typescript: string;
    python: string;
    dotnet: string;
  }>;
  protocols: readonly string[];
  protocolAliases: Record<string, string>;
  capabilities: readonly string[];
  defaultCapabilities: Record<string, readonly string[]>;
  resultScenarios: readonly ResultScenario[];
  unsupportedCapabilityScenarios: readonly UnsupportedCapabilityScenario[];
}

interface ResultScenario {
  id: string;
  protocol: string;
  operation?: string;
  sourceDescriptor?: {
    id: string;
    protocol: string;
    locator: Record<string, unknown>;
    capabilities: readonly string[];
  };
  query: Record<string, unknown>;
  result: {
    features: readonly ContractFeature[];
    exceededTransferLimit: boolean;
    totalCount?: number;
    fields?: ReadonlyArray<Record<string, unknown>>;
    aggregateRows?: ReadonlyArray<Record<string, unknown>>;
    degraded?: readonly DegradedReason[];
  };
}

interface ContractFeature {
  id?: string | number;
  attributes: Record<string, unknown>;
  geometry?: Record<string, unknown> | null;
}

interface DegradedReason {
  capability: string;
  reason: string;
  protocol?: string;
  sourceId?: string;
}

interface UnsupportedCapabilityScenario {
  id: string;
  protocol: string;
  operation: string;
  requiredCapability: string;
  expectedError: {
    name: string;
    capability: string;
    protocol: string;
  };
}

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/sdk-contract");
const fixture = JSON.parse(readFileSync(resolve(fixturesDir, "semantic-contract.v1.json"), "utf8")) as ContractFixture;

describe("cross-SDK contract fixture", () => {
  it("pins the exported protocol registry", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.protocols).toEqual(PROTOCOLS);
  });

  it("pins the exported capability registry", () => {
    expect(fixture.capabilities).toEqual(CAPABILITIES);
  });

  it("pins the default capability set for every protocol", () => {
    expect(Object.keys(fixture.defaultCapabilities)).toEqual(PROTOCOLS);

    for (const protocol of PROTOCOLS) {
      expect(fixture.defaultCapabilities[protocol]).toEqual([...PROTOCOL_DEFAULT_CAPABILITIES[protocol]]);
    }
  });

  it("keeps protocol aliases pointed at canonical protocol ids", () => {
    for (const [alias, canonical] of Object.entries(fixture.protocolAliases)) {
      expect(alias).not.toBe(canonical);
      expect(PROTOCOLS).toContain(canonical);
    }
  });

  it("documents idiomatic bindings without requiring identical spelling across languages", () => {
    const bindingsByConcept = new Map(fixture.languageBindings.map((binding) => [binding.concept, binding]));
    expect(bindingsByConcept.get("queryAll")).toMatchObject({
      typescript: "queryAll()",
      python: "query_all()",
      dotnet: "QueryAllAsync()",
    });
    expect(bindingsByConcept.get("returnGeometry")).toMatchObject({
      typescript: "returnGeometry",
      python: "return_geometry",
      dotnet: "ReturnGeometry",
    });
  });

  it("defines the canonical source/query/result nouns used by downstream SDKs", () => {
    expect(fixture.canonicalNouns).toEqual([
      "Dataset",
      "SourceDescriptor",
      "Source",
      "Protocol",
      "Capability",
      "Query",
      "Result",
      "EditEnvelope",
      "EditResult",
      "MapBinding",
    ]);
  });

  it("validates result scenarios across queryable protocol families", () => {
    const protocolsWithResults = new Set<string>();

    for (const scenario of fixture.resultScenarios) {
      protocolsWithResults.add(scenario.protocol);
      expect(PROTOCOLS).toContain(scenario.protocol);
      expect(scenario.id).toMatch(/^[a-z0-9-]+$/);
      expect(typeof scenario.query).toBe("object");
      expect(Array.isArray(scenario.result.features)).toBe(true);
      expect(typeof scenario.result.exceededTransferLimit).toBe("boolean");

      if (scenario.sourceDescriptor) {
        expect(scenario.sourceDescriptor.protocol).toBe(scenario.protocol);
        for (const capability of scenario.sourceDescriptor.capabilities) {
          expect(CAPABILITIES).toContain(capability);
        }
      }

      for (const feature of scenario.result.features) {
        expect(feature.attributes).toBeDefined();
        expect(typeof feature.attributes).toBe("object");
        if ("geometry" in feature) {
          expect(feature.geometry === null || typeof feature.geometry === "object").toBe(true);
        }
      }

      if (scenario.result.degraded) {
        for (const reason of scenario.result.degraded) {
          expect(CAPABILITIES).toContain(reason.capability);
          if (reason.protocol) expect(PROTOCOLS).toContain(reason.protocol);
          expect(reason.reason.length).toBeGreaterThan(0);
        }
      }
    }

    expect(protocolsWithResults).toEqual(
      new Set(["geoservices-feature-service", "ogc-features", "stac", "odata", "wfs"]),
    );
  });

  it("validates unsupported-capability scenarios as explicit errors", () => {
    for (const scenario of fixture.unsupportedCapabilityScenarios) {
      expect(PROTOCOLS).toContain(scenario.protocol);
      expect(CAPABILITIES).toContain(scenario.requiredCapability);
      expect(scenario.expectedError).toEqual({
        name: "HonuaCapabilityNotSupportedError",
        capability: scenario.requiredCapability,
        protocol: scenario.protocol,
      });
    }
  });
});
