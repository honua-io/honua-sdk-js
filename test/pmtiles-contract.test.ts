/**
 * PMTiles contract-level tests: archive metadata inspection (`describe()`),
 * capability negotiation (tiles-only; the query family throws), and Dataset
 * integration. Reads the committed fixture archives through the real `pmtiles`
 * reader via a buffer-backed `Source`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HonuaPmtilesArchive,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type PmtilesModuleLike,
  type PmtilesSourceLike,
  type SourceDescriptor,
  createDataset,
  describePmtilesArchive,
  stripPmtilesScheme,
  toPmtilesSourceUrl,
} from "../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";

function fixtureBuffer(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/pmtiles/${name}`, import.meta.url)));
}

/** Buffer-backed `pmtiles` Source that reads byte ranges from a committed file. */
function bufferSource(name: string): PmtilesSourceLike {
  const buffer = fixtureBuffer(name);
  return {
    getKey: () => name,
    async getBytes(offset, length) {
      const slice = buffer.subarray(offset, offset + length);
      const copy = new Uint8Array(slice.byteLength);
      copy.set(slice);
      return { data: copy.buffer as ArrayBuffer };
    },
  };
}

// A tiny stub client — the PMTiles adapter never touches it.
const stubClient = { checkCompatibility: async () => ({ supported: true }) } as never;

describe("contract / PMTiles describe()", () => {
  it("reads bounds, zooms, tile kind, and center from a raster archive", async () => {
    const info = await describePmtilesArchive("https://example.com/sample-raster.pmtiles", {
      source: bufferSource("sample-raster.pmtiles"),
    });
    expect(info.tileKind).toBe("png");
    expect(info.bounds).toEqual([-123.2, 37, -121.5, 38.2]);
    expect(info.minZoom).toBe(0);
    expect(info.maxZoom).toBe(5);
    expect(info.center).toEqual([-122.35, 37.6, 3]);
    expect(info.vectorLayers).toEqual([]);
    expect(info.attribution).toBe("Honua PMTiles sample");
  });

  it("reads vector layer names from a vector archive", async () => {
    const info = await describePmtilesArchive("https://example.com/sample-vector.pmtiles", {
      source: bufferSource("sample-vector.pmtiles"),
    });
    expect(info.tileKind).toBe("mvt");
    expect(info.vectorLayers.map((layer) => layer.id)).toEqual(["landuse", "roads"]);
    expect(info.vectorLayers[0]).toMatchObject({
      id: "landuse",
      description: "Land use polygons",
      minZoom: 0,
      maxZoom: 5,
      fields: { class: "String" },
    });
  });

  it("maps an unknown header tile type to 'unknown' and tolerates absent metadata", async () => {
    const fakePMTiles: PmtilesModuleLike = class {
      async getHeader() {
        return {
          minZoom: 2,
          maxZoom: 9,
          minLon: -10,
          minLat: -5,
          maxLon: 10,
          maxLat: 5,
          centerZoom: 4,
          centerLon: 0,
          centerLat: 0,
          tileType: 99,
        };
      }
      async getMetadata() {
        return null;
      }
    } as unknown as PmtilesModuleLike;
    const info = await describePmtilesArchive("mem://archive", { PMTiles: fakePMTiles });
    expect(info.tileKind).toBe("unknown");
    expect(info.minZoom).toBe(2);
    expect(info.maxZoom).toBe(9);
    expect(info.vectorLayers).toEqual([]);
    expect(info.attribution).toBeUndefined();
    expect(info.metadata).toEqual({});
  });

  it("HonuaPmtilesArchive.describe() caches after the first call", async () => {
    let opens = 0;
    const fakePMTiles: PmtilesModuleLike = class {
      constructor() {
        opens += 1;
      }
      async getHeader() {
        return {
          minZoom: 0,
          maxZoom: 3,
          minLon: 0,
          minLat: 0,
          maxLon: 1,
          maxLat: 1,
          centerZoom: 1,
          centerLon: 0.5,
          centerLat: 0.5,
          tileType: 2,
        };
      }
      async getMetadata() {
        return {};
      }
    } as unknown as PmtilesModuleLike;
    const archive = new HonuaPmtilesArchive("mem://archive", { PMTiles: fakePMTiles });
    const first = await archive.describe();
    const second = await archive.describe();
    expect(second).toBe(first);
    expect(opens).toBe(1);
  });
});

describe("contract / PMTiles scheme helpers", () => {
  it("round-trips the pmtiles:// scheme", () => {
    expect(stripPmtilesScheme("pmtiles://https://x/y.pmtiles")).toBe("https://x/y.pmtiles");
    expect(stripPmtilesScheme("https://x/y.pmtiles")).toBe("https://x/y.pmtiles");
    expect(toPmtilesSourceUrl("https://x/y.pmtiles")).toBe("pmtiles://https://x/y.pmtiles");
    expect(toPmtilesSourceUrl("pmtiles://https://x/y.pmtiles")).toBe("pmtiles://https://x/y.pmtiles");
  });
});

describe("contract / PMTiles Source capability negotiation", () => {
  const descriptor: SourceDescriptor = {
    id: "basemap",
    protocol: "pmtiles",
    locator: { url: "pmtiles://https://example.com/sample-raster.pmtiles" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
  };

  function buildSource() {
    const dataset = createDataset({
      id: "pmtiles-ds",
      client: stubClient,
      skipCompatibilityCheck: true,
      sources: [descriptor],
    });
    const source = dataset.source("basemap");
    if (!source) throw new Error("expected a pmtiles source");
    return source;
  }

  it("advertises tiles-only capabilities", () => {
    expect([...PROTOCOL_DEFAULT_CAPABILITIES.pmtiles]).toEqual(["tiles"]);
    const source = buildSource();
    expect(source.capabilities.has("tiles")).toBe(true);
    expect(source.capabilities.has("query")).toBe(false);
  });

  it("throws HonuaCapabilityNotSupportedError for every query-family method", async () => {
    const source = buildSource();
    await expect(source.query()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.queryAll()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.queryExtent()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.queryObjectIds()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.applyEdits({})).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(async () => {
      for await (const _page of source.stream()) {
        /* should throw before yielding */
      }
    }).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("exposes the archive handle through Source.protocol('pmtiles') with the scheme stripped", async () => {
    const source = buildSource();
    const archive = source.protocol("pmtiles");
    expect(archive).toBeInstanceOf(HonuaPmtilesArchive);
    expect(archive?.url).toBe("https://example.com/sample-raster.pmtiles");
  });
});
