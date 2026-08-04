/**
 * The state-sync ports duck-type their renderers so `src/scene-workspace/` can
 * stay free of peer imports. That only holds up if the structural targets are
 * actually satisfied by the real renderer types — a target that is subtly too
 * strict compiles fine here and then fails in a consumer's build.
 *
 * These are compile-time assertions against the real `maplibre-gl` and `cesium`
 * type declarations (both dev dependencies). The file imports types only, so it
 * loads neither runtime.
 */

import type { Viewer } from "cesium";
import type { Map as MapLibreMap } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import type { CesiumStateSyncTarget, MapLibreStateSyncTarget } from "../src/scene-workspace/index.js";

/** Fails to compile if `Source` does not satisfy `Target`. */
type Satisfies<Target, Source extends Target> = [Target, Source];

type MapLibreMapIsATarget = Satisfies<MapLibreStateSyncTarget, MapLibreMap>;
type CesiumViewerIsATarget = Satisfies<CesiumStateSyncTarget, Viewer>;

describe("shipped port targets accept the real renderer types", () => {
  it("compiles a live 2D map and a live Cesium viewer against the port targets", () => {
    // The assertions above are the test; this keeps the file a runnable spec and
    // documents that neither renderer package is loaded to make them.
    const proof: [MapLibreMapIsATarget?, CesiumViewerIsATarget?] = [];
    expect(proof).toHaveLength(0);
  });
});
