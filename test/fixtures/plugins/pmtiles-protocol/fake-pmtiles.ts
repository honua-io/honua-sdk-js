import type { DescribePmtilesArchiveDeps, PmtilesArchiveLike, PmtilesModuleLike } from "../../../../src/contract/index.js";

/**
 * A tiny in-memory `pmtiles` reader fake, mirroring `test/pmtiles-contract.test.ts`.
 * It never performs network I/O, so the plugin certification/conformance and
 * seam-parity tests can drive `pmtilesProtocolModule()`/`pmtilesProtocolPlugin()`
 * deterministically without the real `pmtiles` package or a network fixture.
 */
export function createFakePmtilesDeps(): DescribePmtilesArchiveDeps {
  const PMTiles: PmtilesModuleLike = class implements PmtilesArchiveLike {
    public async getHeader() {
      return {
        minZoom: 0,
        maxZoom: 4,
        minLon: -10,
        minLat: -5,
        maxLon: 10,
        maxLat: 5,
        centerZoom: 2,
        centerLon: 0,
        centerLat: 0,
        tileType: 1,
      };
    }
    public async getMetadata() {
      return { vector_layers: [{ id: "conformance-layer" }] };
    }
  };
  return { PMTiles };
}
