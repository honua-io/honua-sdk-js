import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import sampleKitManifest from "../examples/_kit/manifest.v1.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SHARED_DESIGN_IMPORT = "_kit/design/index.css";

function sourceFiles(sampleId: string): readonly string[] {
  const root = path.join(REPO_ROOT, "examples", sampleId, "src");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:css|html|js|jsx|ts|tsx)$/u.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("sample design language adoption", () => {
  it("keeps every qualified catalog sample connected to the shared design entrypoint", () => {
    const missing = sampleKitManifest.samples
      .map((sample) => {
        const imports = sourceFiles(sample.id).filter((file) =>
          fs.readFileSync(file, "utf8").includes(SHARED_DESIGN_IMPORT),
        );
        return imports.length > 0 ? undefined : sample.id;
      })
      .filter((sampleId): sampleId is string => sampleId !== undefined);

    expect(missing).toEqual([]);
  });
});
