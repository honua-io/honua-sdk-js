import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { integrationSdkAliases } from "../vitest.integration.config.js";

const packageName = "@honua/sdk-js";
const integrationRoot = path.resolve(import.meta.dirname, "integration");
const publicSurface = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../config/public-surface.json"), "utf8"),
) as {
  entrypoints: Array<{ subpath: string; tier: string }>;
};

function integrationTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return integrationTypeScriptFiles(resolved);
    return entry.isFile() && entry.name.endsWith(".ts") ? [resolved] : [];
  });
}

function packageImports(source: string): string[] {
  const imports = new Set<string>();
  const pattern = /(?:from\s+|import\s*\()\s*["'](@honua\/sdk-js(?:\/[^"']+)?)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) imports.add(match[1]);
  }
  return [...imports];
}

function subpathFor(specifier: string): string {
  return specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
}

describe("integration SDK package resolution", () => {
  it("maps every stable package entrypoint imported by integration tests to one exact source entry", () => {
    const stableSubpaths = new Set(
      publicSurface.entrypoints
        .filter((entrypoint) => entrypoint.tier === "stable")
        .map((entrypoint) => entrypoint.subpath),
    );
    const importedSpecifiers = new Set(
      integrationTypeScriptFiles(integrationRoot).flatMap((file) => packageImports(fs.readFileSync(file, "utf8"))),
    );

    expect([...importedSpecifiers].sort()).toEqual(["@honua/sdk-js", "@honua/sdk-js/geocoding", "@honua/sdk-js/honua"]);

    for (const specifier of importedSpecifiers) {
      expect(stableSubpaths.has(subpathFor(specifier)), `${specifier} must be stable`).toBe(true);
      const matches = integrationSdkAliases.filter(({ find }) => find.test(specifier));
      expect(matches, `${specifier} must have exactly one exact alias`).toHaveLength(1);
      expect(fs.existsSync(matches[0]!.replacement), `${specifier} alias target must exist`).toBe(true);
    }

    expect(integrationSdkAliases.some(({ find }) => find.test("@honua/sdk-js/not-exported"))).toBe(false);
  });
});
