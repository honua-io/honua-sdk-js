/**
 * Independent, out-of-tree-style "cloud tiles" protocol plugin (issue #538
 * REQ-004). Not imported by SDK core, and shares no implementation with
 * `src/contract/pmtiles.ts`: it proves that a third-party protocol module can
 * implement the public `ProtocolModule` seam (`src/contract/protocol-module.ts`)
 * and certify through the same #392 plugin manifest/registry kit as the
 * first-party PMTiles protocol plugin, without editing SDK core.
 */
export { createFakeCloudTilesReader } from "./fake-cloud-tiles-reader.js";
export type { CloudTilesDescription, CloudTilesReaderLike } from "./fake-cloud-tiles-reader.js";
export { cloudTilesProtocolModule } from "./protocol-module.js";
export type { CloudTilesArchiveHandle } from "./protocol-module.js";
export { cloudTilesProtocolManifest } from "./manifest.js";
export { cloudTilesProtocolPlugin } from "./plugin.js";
export type { CloudTilesProtocolExtension } from "./plugin.js";
export { cloudTilesProtocolConformanceSpec, cloudTilesProtocolProbe } from "./conformance.js";
