import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function evidenceIdentity() {
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  const files = [
    "src/evaluation.ts",
    "src/query.ts",
    "src/map-runtime.ts",
    "src/model.ts",
    "src/fixture.ts",
    "evaluation.v1.json",
    "live-adapter.mjs",
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
    sourceDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim()),
    harnessSha256: hash.digest("hex"),
  };
}
