/**
 * Installed-consumer / tree-shake guard for the OpenLayers renderer plugin
 * (issue #566 NFR-001, acceptance criterion "Installed-consumer and
 * tree-shake tests prove OpenLayers is absent unless the plugin is
 * imported").
 *
 * The plugin lives entirely under `test/fixtures/plugins/openlayers/`
 * (excluded from `tsc`/Biome and from every published entrypoint), uses a
 * dependency-free structural fake instead of the real `ol` package, and is
 * reached only through an explicit import of that fixture path. This test
 * makes that placement an enforced invariant rather than an implicit
 * convention: no file published from `src/` (the root/browser/subpath
 * barrels bundled into `dist/`) may reference OpenLayers, the fixture path,
 * or declare an `ol`/`openlayers` dependency.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = path.join(ROOT, "src");

function walk(root: string): readonly string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

describe("OpenLayers plugin stays absent from SDK core (#566 NFR-001)", () => {
  it("no file under src/ mentions OpenLayers/ol or imports the plugin fixture", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const text = fs.readFileSync(file, "utf8");
      if (/plugins\/openlayers/i.test(text) || /\bopenlayers\b/i.test(text) || /from ["']ol["']/i.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("package.json declares no runtime, peer, or dev dependency on ol/openlayers", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      readonly dependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
      readonly peerDependenciesMeta?: Record<string, unknown>;
    };
    const groups = [pkg.dependencies, pkg.peerDependencies, pkg.devDependencies, pkg.peerDependenciesMeta];
    for (const group of groups) {
      for (const name of Object.keys(group ?? {})) {
        expect(name.toLowerCase()).not.toBe("ol");
        expect(name.toLowerCase()).not.toContain("openlayers");
      }
    }
  });

  it("the plugin fixture is reachable only from its own directory, not from any src/ or root barrel", () => {
    const barrels = ["index.ts", "honua.ts"].map((name) => path.join(SRC_ROOT, name));
    for (const barrel of barrels) {
      const text = fs.readFileSync(barrel, "utf8");
      expect(text).not.toMatch(/openlayers/i);
    }
  });
});
