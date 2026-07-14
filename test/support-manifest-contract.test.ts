import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, PROTOCOLS, PROTOCOL_DEFAULT_CAPABILITIES, type Protocol } from "../src/contract/types.js";

interface OperationClaim {
  readonly operations: readonly string[];
  readonly executionMode: string;
}

interface ProtocolClaim {
  readonly id: Protocol;
  readonly operationClaims: readonly OperationClaim[];
}

interface SupportManifest {
  readonly protocolOperations: readonly string[];
  readonly protocols: readonly ProtocolClaim[];
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "config/support-manifest.v1.json"), "utf8"),
) as SupportManifest;

describe("support manifest contract parity", () => {
  it("tracks the canonical protocol and operation vocabularies in declaration order", () => {
    expect(manifest.protocols.map((protocol) => protocol.id)).toEqual(PROTOCOLS);
    expect(manifest.protocolOperations).toEqual(CAPABILITIES);
  });

  it("tracks every native default capability without treating fallbacks as defaults", () => {
    for (const protocol of manifest.protocols) {
      const manifestedNativeOperations = protocol.operationClaims
        .filter((claim) => claim.executionMode === "native")
        .flatMap((claim) => claim.operations);
      expect(manifestedNativeOperations, protocol.id).toEqual([...PROTOCOL_DEFAULT_CAPABILITIES[protocol.id]]);
    }
  });
});
