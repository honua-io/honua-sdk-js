import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEPLER_PEERS = ["@kepler.gl/actions", "react", "react-dom", "redux"] as const;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)));
    else if (entry.name.endsWith(".ts")) files.push(entryPath);
  }
  return files;
}

describe("Kepler optional-peer boundary", () => {
  it("keeps React, Redux, and Kepler out of static bridge imports", async () => {
    const files = await sourceFiles(path.join(ROOT, "src", "kepler"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const peer of KEPLER_PEERS) {
        const staticImport = new RegExp(
          `^\\s*import\\s+(?!\\()(?:(?![\\r\\n]).)*[\\"']${peer.replaceAll(".", "\\.")}[\\"']`,
          "m",
        );
        if (staticImport.test(source)) violations.push(`${path.relative(ROOT, file)} imports ${peer}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("declares the live Kepler action peer optional", async () => {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(packageJson.peerDependenciesMeta?.["@kepler.gl/actions"]?.optional).toBe(true);
  });
});
