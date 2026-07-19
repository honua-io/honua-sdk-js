/**
 * First-party PMTiles `protocol` plugin certification fixture (issue #538).
 * Unlike the other `test/fixtures/plugins/*` directories, `pmtilesProtocolPlugin`
 * itself is NOT test-only scaffolding — it lives in `src/plugin/pmtiles-protocol-plugin.js`
 * and packages the same `pmtilesProtocolModule()` that `pmtilesSource()` uses
 * internally. This fixture only supplies the deterministic fake `pmtiles`
 * reader and the conformance probe/spec needed to certify it.
 */
export { createFakePmtilesDeps } from "./fake-pmtiles.js";
export { pmtilesProtocolConformanceSpec, pmtilesProtocolProbe } from "./conformance.js";
