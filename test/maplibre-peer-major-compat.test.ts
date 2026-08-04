// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ensurePmtilesProtocol,
  isPmtilesProtocolRegistered,
  resetPmtilesProtocol,
} from "../src/runtime/pmtiles-protocol.js";

/**
 * MapLibre peer-major compatibility (issue #1004).
 *
 * The SDK advertises `maplibre-gl` `^5.0.0 || ^6.0.0` as an optional peer. This
 * spec is the machine-checked half of that claim: it imports the *real*
 * installed `maplibre-gl` module and asserts every symbol the SDK reaches for
 * (see `src/runtime/pmtiles-protocol.ts`, `src/web-components/maplibre-renderer.ts`,
 * `src/react/honua-map.tsx`, `examples/shared/maplibre-vite-worker.ts`) exists on it.
 *
 * The default `vitest.config.ts` run resolves `maplibre-gl` to the 6.x
 * devDependency. `vitest.maplibre-v5.config.ts` re-runs this same file with
 * `maplibre-gl` aliased to the `maplibre-gl-v5` (5.24.x) devDependency, so both
 * supported majors are exercised by the same assertions rather than one being
 * claimed. `npm run test:maplibre-majors` runs both legs.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The declared optional-peer range. Widening or narrowing it is a product decision, not a refactor. */
const DECLARED_PEER_RANGE = "^5.0.0 || ^6.0.0";
const SUPPORTED_MAJORS: readonly number[] = [5, 6];

/**
 * Installed directory backing the `maplibre-gl` specifier for this run. The v5
 * leg aliases the specifier, so file-level assertions must follow the alias
 * instead of always reading the 6.x devDependency.
 */
const PEER_PACKAGE = process.env.HONUA_MAPLIBRE_PACKAGE ?? "maplibre-gl";

interface MapLibreModuleLike {
  readonly Map?: unknown;
  readonly Popup?: unknown;
  readonly NavigationControl?: unknown;
  readonly addProtocol?: unknown;
  readonly removeProtocol?: unknown;
  readonly setWorkerUrl?: unknown;
  readonly getVersion?: () => string;
  readonly version?: string;
  readonly default?: Record<string, unknown>;
}

function readJson(...segments: string[]): Record<string, string | Record<string, string>> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, ...segments), "utf8"));
}

function installedPeerVersion(): string {
  return readJson("node_modules", PEER_PACKAGE, "package.json").version as string;
}

function resolveVersion(mod: MapLibreModuleLike): string {
  const version = mod.getVersion?.() ?? mod.version ?? (mod.default?.version as string | undefined);
  expect(typeof version, "maplibre-gl must report its version").toBe("string");
  return version as string;
}

/** MapLibre 6 is ESM-only with named exports; MapLibre 5 may also hang symbols off `default`. */
function symbol(mod: MapLibreModuleLike, name: keyof MapLibreModuleLike): unknown {
  return mod[name] ?? mod.default?.[name as string];
}

describe("maplibre-gl peer major compatibility", () => {
  it("declares both supported majors as an optional peer", () => {
    const rootPackage = readJson("package.json");
    const peers = rootPackage.peerDependencies as Record<string, string>;
    const devs = rootPackage.devDependencies as Record<string, string>;
    expect(peers["maplibre-gl"]).toBe(DECLARED_PEER_RANGE);
    // The 5.x alias is what makes the second CI leg possible; if it is dropped,
    // dual-major support silently degrades to a claim.
    expect(devs["maplibre-gl-v5"]).toMatch(/^npm:maplibre-gl@\^5\./);
    expect(devs["maplibre-gl"]).toMatch(/^\^6\./);
  });

  it("resolves to a major inside the declared peer range", async () => {
    const mod = (await import("maplibre-gl")) as MapLibreModuleLike;
    const version = resolveVersion(mod);
    // Proves the leg under test actually loaded the package it claims to: a
    // broken alias would silently re-run the 6.x leg twice.
    expect(version).toBe(installedPeerVersion());
    expect(SUPPORTED_MAJORS).toContain(Number.parseInt(version.split(".")[0] ?? "", 10));
  });

  it("exposes every symbol the SDK reaches for on the installed major", async () => {
    const mod = (await import("maplibre-gl")) as MapLibreModuleLike;
    for (const name of [
      "Map",
      "Popup",
      "NavigationControl",
      "addProtocol",
      "removeProtocol",
      "setWorkerUrl",
    ] as const) {
      expect(typeof symbol(mod, name), `maplibre-gl must export ${name}`).toBe("function");
    }
  });

  it("registers the pmtiles:// protocol through the installed major's real module", async () => {
    // Exercises `loadMaplibreRegistrar()` (src/runtime/pmtiles-protocol.ts)
    // against the real package instead of the injected test registrar, so a
    // packaging change in either major fails here rather than in a host app.
    const scheme = "honua-peer-compat-pmtiles";
    try {
      await ensurePmtilesProtocol({ scheme });
      expect(isPmtilesProtocolRegistered(scheme)).toBe(true);
    } finally {
      resetPmtilesProtocol();
    }
    expect(isPmtilesProtocolRegistered(scheme)).toBe(false);
  });

  it("takes WebGL context attributes under canvasContextAttributes on the installed major", () => {
    // MapLibre 5.0 moved `preserveDrawingBuffer` / `antialias` /
    // `failIfMajorPerformanceCaveat` into `canvasContextAttributes`, and 6.x
    // kept them there. The SDK's owned-map paths must use the nested form or
    // the web-component snapshot export reads a blank canvas on both majors.
    const typings = readFileSync(
      path.join(REPO_ROOT, "node_modules", PEER_PACKAGE, "dist", "maplibre-gl.d.ts"),
      "utf8",
    );
    expect(typings).toContain("canvasContextAttributes?: WebGLContextAttributesWithType");
  });
});
