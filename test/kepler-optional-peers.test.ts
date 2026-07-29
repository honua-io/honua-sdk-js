import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEPLER_PEERS = ["@kepler.gl/actions", "react", "react-dom", "redux"] as const;

function staticPeerSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImports =
    /\b(?:import|export)\s+(?:(?!\bfrom\b)[\s\S])*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(staticImports)) {
    const specifier = match[1] ?? match[2];
    if (specifier && KEPLER_PEERS.some((peer) => specifier === peer || specifier.startsWith(`${peer}/`))) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

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
      for (const specifier of staticPeerSpecifiers(source)) {
        violations.push(`${path.relative(ROOT, file)} imports ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("detects multiline imports, re-exports, and peer subpaths", () => {
    const source = `
      import {
        createElement,
      } from "react";
      export {
        createStore,
      } from "redux";
      import jsx from "react/jsx-runtime";
      export {select} from "@kepler.gl/actions/helpers";
    `;

    expect(staticPeerSpecifiers(source)).toEqual(["react", "redux", "react/jsx-runtime", "@kepler.gl/actions/helpers"]);
  });

  it("ignores dynamic peer imports", () => {
    expect(staticPeerSpecifiers('await import("react");')).toEqual([]);
  });

  it("declares the live Kepler action peer optional", async () => {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(packageJson.peerDependenciesMeta?.["@kepler.gl/actions"]?.optional).toBe(true);
  });
});
