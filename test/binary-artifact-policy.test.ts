import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { forbiddenBinaryArtifactReason, scanBinaryArtifactFiles } from "../scripts/lib/binary-artifact-policy.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-binary-policy-"));
  temporaryRoots.push(root);
  return root;
}

describe("binary artifact policy", () => {
  it("rejects executable extensions including compressed WebAssembly names", () => {
    expect(forbiddenBinaryArtifactReason("vendor/parquet.duckdb_extension.wasm")).toContain("executable extension");
    expect(forbiddenBinaryArtifactReason("dist/module.wasm.gz")).toContain("executable extension");
    expect(forbiddenBinaryArtifactReason("native/addon.node")).toContain("executable extension");
  });

  it("detects executable magic even when the filename looks like data", () => {
    expect(forbiddenBinaryArtifactReason("fixture.dat", Uint8Array.from([0x00, 0x61, 0x73, 0x6d]))).toContain(
      "WebAssembly",
    );
    expect(forbiddenBinaryArtifactReason("fixture.dat", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).toContain("ELF");
    expect(forbiddenBinaryArtifactReason("fixture.parquet", Uint8Array.from([0x50, 0x41, 0x52, 0x31]))).toBeUndefined();
  });

  it("scans only bounded paths under the declared root", () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, "source.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, "renamed.data"), Uint8Array.from([0x00, 0x61, 0x73, 0x6d]));

    expect(scanBinaryArtifactFiles({ root, paths: ["source.ts"] })).toEqual([]);
    expect(scanBinaryArtifactFiles({ root, paths: ["renamed.data", "../escape.wasm"] })).toEqual([
      { file: "renamed.data", reason: "content has WebAssembly executable magic" },
      { file: "../escape.wasm", reason: "path escapes the inspected root" },
    ]);
  });
});
