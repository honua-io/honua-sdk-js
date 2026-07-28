import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECT_SOURCE_PROTOCOLS } from "../src/connect.js";
import { PROTOCOLS, type Protocol } from "../src/contract/types.js";

interface ConnectParityMatrix {
  readonly version: string;
  readonly requiredSemanticFields: readonly string[];
  readonly lifecycleCases: readonly string[];
  readonly sourceProtocols: readonly {
    readonly protocol: string;
    readonly fixture: string;
    readonly sourceKind: string;
    readonly semanticFields: readonly string[];
    readonly lifecycleCases: readonly string[];
  }[];
  readonly operationOnly: readonly {
    readonly protocol: string;
    readonly fixture: string;
    readonly sourceKind: string;
    readonly lifecycleCases: readonly string[];
  }[];
}

const matrix = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../config/connect-parity-matrix.v1.json"), "utf8"),
) as ConnectParityMatrix;

describe("portable connect parity matrix", () => {
  it("covers every source-backed connect protocol exactly once", () => {
    const protocols = matrix.sourceProtocols.map((entry) => entry.protocol);
    expect(new Set(protocols).size).toBe(protocols.length);
    expect([...protocols].sort()).toEqual([...CONNECT_SOURCE_PROTOCOLS].sort());
    expect(matrix.sourceProtocols.every((entry) => entry.fixture.startsWith("connect-"))).toBe(true);
  });

  it("keeps operation-only services outside the source inventory", () => {
    const sourceProtocols = new Set(matrix.sourceProtocols.map((entry) => entry.protocol));
    for (const entry of matrix.operationOnly) {
      expect(entry.sourceKind).toBe("operation-only");
      expect(sourceProtocols.has(entry.protocol)).toBe(false);
      expect(entry.protocol === "ogc-processes" || (PROTOCOLS as readonly string[]).includes(entry.protocol)).toBe(
        true,
      );
      expect(entry.fixture.startsWith("connect-")).toBe(true);
    }
  });

  it("requires portable semantic and lifecycle coverage for every source fixture", () => {
    const requiredSemanticFields = new Set(matrix.requiredSemanticFields);
    const requiredLifecycleCases = new Set(matrix.lifecycleCases);
    expect(matrix.version).toBe("1.0");
    expect(requiredSemanticFields.size).toBe(matrix.requiredSemanticFields.length);
    expect(requiredLifecycleCases.size).toBe(matrix.lifecycleCases.length);
    for (const entry of matrix.sourceProtocols) {
      expect(entry.semanticFields.length).toBeGreaterThan(0);
      expect(entry.lifecycleCases.length).toBeGreaterThan(0);
      expect(entry.semanticFields.every((field) => requiredSemanticFields.has(field))).toBe(true);
      expect(entry.lifecycleCases.every((scenario) => requiredLifecycleCases.has(scenario))).toBe(true);
      expect(entry.semanticFields).toContain("schemaState");
      expect(entry.semanticFields).toContain("capabilities");
      expect(entry.semanticFields).toContain("provenance");
    }
  });

  it("retains the matrix's language-neutral protocol identifiers", () => {
    const protocolSet = new Set(PROTOCOLS as readonly Protocol[]);
    for (const entry of matrix.sourceProtocols) expect(protocolSet.has(entry.protocol as Protocol)).toBe(true);
  });
});
