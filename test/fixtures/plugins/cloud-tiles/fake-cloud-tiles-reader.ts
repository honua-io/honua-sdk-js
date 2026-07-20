/**
 * A tiny, fully independent fake "cloud tiles" archive reader. It shares no
 * code with `src/contract/pmtiles.ts` — this is what an out-of-tree package
 * (`@example/honua-cloud-tiles`, the exact package name used in
 * `docs/plugin-manifest-certification.md`'s own manifest example) would ship.
 */
export interface CloudTilesDescription {
  readonly bounds: readonly [number, number, number, number];
  readonly maxZoom: number;
  readonly tileCount: number;
}

export interface CloudTilesReaderLike {
  describe(url: string): Promise<CloudTilesDescription>;
}

export function createFakeCloudTilesReader(): CloudTilesReaderLike {
  return {
    async describe(url: string): Promise<CloudTilesDescription> {
      if (!url) throw new Error("cloud-tiles: describe() requires a url");
      return { bounds: [-10, -5, 10, 5], maxZoom: 12, tileCount: 4096 };
    },
  };
}
