/**
 * External-style OpenLayers renderer plugin (issue #566). Not imported by SDK
 * core: it proves that a third-party, non-Web-Mercator renderer can register
 * and mount through the public renderer plugin seam (`src/kernel/renderer.ts`,
 * #534) and the versioned plugin manifest/registry kit (`src/plugin/`, #392)
 * without editing either. See `docs/decisions/sdk-1.0-execution-plan.md`.
 */

export {
  createFakeOpenLayersPeer,
  FakeOlMap,
  FakeOlProjectionRegistry,
  FakeOlViewImpl,
  isFakeOlMap,
} from "./fake-ol.js";
export type { FakeOlLayer, FakeOlProjectionDefinition, FakeOlView, FakeOpenLayersPeer } from "./fake-ol.js";
export { classifyOpenLayersCrsFidelity } from "./crs-fidelity.js";
export type { OpenLayersCrsFidelity, OpenLayersCrsFidelityResult } from "./crs-fidelity.js";
export { openLayersRendererManifest } from "./manifest.js";
export { OPENLAYERS_RENDERER_KIND, OpenLayersRendererError, openLayersRenderer } from "./renderer-adapter.js";
export type { OpenLayersRendererErrorCode, OpenLayersRendererKind, OpenLayersRendererOptions } from "./renderer-adapter.js";
export { openLayersRendererPlugin } from "./plugin.js";
export type { OpenLayersRendererExtension } from "./plugin.js";
export { openLayersRendererConformanceSpec, openLayersRendererProbe } from "./conformance.js";
