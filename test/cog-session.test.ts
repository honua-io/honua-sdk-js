import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";
import {
  type CogDecodedMetadata,
  type CogDecoder,
  type CogDecoderFactory,
  HonuaCogError,
  openStacCogAsset,
} from "../src/cog/index.js";
import type { StacAssetCandidate } from "../src/connect-stac-static.js";
import { connect } from "../src/connect.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/cog/scenarios.json", import.meta.url), "utf8")) as {
  assetText: string;
  metadata: CogDecodedMetadata;
};
const fixtureBytes = new TextEncoder().encode(fixture.assetText);

function candidate(overrides: Partial<StacAssetCandidate> = {}): StacAssetCandidate {
  return {
    id: "oahu-item:visual",
    state: "classified",
    kind: "cog",
    confidence: "high",
    documentUrl: "https://catalog.example/items/oahu.json",
    objectType: "item",
    objectId: "oahu-item",
    collectionId: "oahu-imagery",
    itemId: "oahu-item",
    assetKey: "visual",
    // Deliberately has no filename extension; classification evidence is authoritative.
    href: "https://assets.example/raster/oahu-visual",
    mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
    roles: ["data", "visual"],
    metadata: { crs: ["EPSG:32604"], datetime: "2026-04-12T21:19:01Z" },
    evidence: [
      {
        kind: "media-type",
        value: "image/tiff; application=geotiff; profile=cloud-optimized",
        supports: ["cog"],
      },
    ],
    provenance: [
      {
        source: "https://catalog.example/items/oahu.json",
        retrievedAt: "2026-07-16T08:00:00.000Z",
        validator: '"item-v1"',
      },
    ],
    ...overrides,
  };
}

function partialRangeFetch(
  bytes = fixtureBytes,
  requests: Array<{ range: string; init: RequestInit }> = [],
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    if (!range) throw new Error("missing range");
    requests.push({ range, init: init ?? {} });
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) throw new Error(`invalid range ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = bytes.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
        "Content-Length": String(body.byteLength),
        "Content-Type": "image/tiff",
        ETag: '"asset-v1"',
      },
    });
  }) as typeof fetch;
}

function fixtureDecoder(overrides: Partial<CogDecoder> = {}): CogDecoder {
  return {
    async inspect({ readRange }) {
      await readRange({ offset: 0, length: 8 });
      await readRange({ offset: 32, length: 4 });
      return fixture.metadata;
    },
    async readWindow(_request, { readRange }) {
      const values = await readRange({ offset: 64, length: 4 });
      return { width: 2, height: 2, bands: [{ band: 1, values }] };
    },
    ...overrides,
  };
}

describe("direct STAC-to-COG S1 boundary", () => {
  it("consumes the evidence-classified COG candidate emitted by static STAC discovery", async () => {
    const item = {
      stac_version: "1.1.0",
      type: "Feature",
      id: "oahu-direct",
      collection: "oahu-imagery",
      bbox: [-158.1, 21.3, -157.8, 21.6],
      geometry: null,
      properties: { datetime: "2026-04-12T21:19:01Z", "proj:code": "EPSG:32604" },
      links: [],
      assets: {
        visual: {
          href: "./assets/oahu-visual",
          type: "image/tiff; application=geotiff; profile=cloud-optimized",
          roles: ["data", "visual"],
        },
      },
    };
    const discoveryFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Content-Type": "image/tiff; application=geotiff; profile=cloud-optimized" },
        });
      }
      return new Response(JSON.stringify(item), {
        status: 200,
        headers: { "Content-Type": "application/geo+json", ETag: '"item-v1"' },
      });
    });
    const connection = await connect({
      endpoint: "https://catalog.example/item.json",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: discoveryFetch },
    });
    const discovered = connection.inspection.stacStatic?.assetCandidates.find((asset) => asset.assetKey === "visual");
    expect(discovered).toMatchObject({ state: "classified", kind: "cog" });
    expect(discovered?.source).toBeUndefined();

    const session = openStacCogAsset(discovered!, {
      decoderFactory: async () => fixtureDecoder(),
      fetchFn: partialRangeFetch(),
    });
    await expect(session.inspect()).resolves.toMatchObject({
      format: "cog",
      provenance: { stac: { candidateId: "oahu-direct:visual" } },
    });
    await session.dispose();
  });

  it("lazily inspects and reads bounded ranges with typed deterministic evidence", async () => {
    const requests: Array<{ range: string; init: RequestInit }> = [];
    const factory = vi.fn(async () => fixtureDecoder());
    const session = openStacCogAsset(candidate(), {
      decoderFactory: factory,
      fetchFn: partialRangeFetch(fixtureBytes, requests),
    });

    expect(factory).not.toHaveBeenCalled();
    expect(session.transfer()).toEqual({
      requests: 0,
      bytesFetched: 0,
      metadataRequests: 0,
      metadataBytes: 0,
      windowRequests: 0,
      windowBytes: 0,
      ranges: [],
    });

    const inspection = await session.inspect();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(inspection).toMatchObject({
      format: "cog",
      width: 16,
      height: 16,
      crs: { kind: "known", authority: "EPSG", code: "32604" },
      bands: [{ index: 1, dataType: "uint8", nodata: 0 }],
      resolution: { x: 10, y: 10, unit: "metre" },
      overviewDecimations: [2, 4, 8],
      provenance: {
        stac: {
          candidateId: "oahu-item:visual",
          assetUrl: "https://assets.example/raster/oahu-visual",
          itemId: "oahu-item",
        },
        assetValidator: 'etag:"asset-v1"',
      },
      transfer: { requests: 2, bytesFetched: 12, metadataBytes: 12, windowBytes: 0 },
    });
    expect(inspection.transfer).not.toHaveProperty("retrievedAt");

    const result = await session.readWindow({ x: 0, y: 0, width: 2, height: 2, bands: [1] });
    expect([...result.bands[0]!.values]).toEqual([...fixtureBytes.slice(64, 68)]);
    expect(result.transfer).toMatchObject({
      requests: 3,
      bytesFetched: 16,
      metadataRequests: 2,
      windowRequests: 1,
      ranges: [
        { sequence: 1, purpose: "metadata", offset: 0, length: 8, outcome: "success" },
        { sequence: 2, purpose: "metadata", offset: 32, length: 4, outcome: "success" },
        { sequence: 3, purpose: "window", offset: 64, length: 4, outcome: "success" },
      ],
    });
    expect(requests.every(({ init }) => init.redirect === "error" && init.credentials === "omit")).toBe(true);
    await session.dispose();
  });

  it("rejects ambiguous and suffix-only candidates before factory or fetch side effects", () => {
    const factory = vi.fn(async () => fixtureDecoder());
    const fetchFn = vi.fn(partialRangeFetch());
    const suffixOnly = candidate({
      state: "ambiguous",
      kind: undefined,
      confidence: "low",
      href: "https://assets.example/raster/looks-like-a-cog.tif",
      mediaType: undefined,
      evidence: [{ kind: "extension", value: "https://stac-extensions.github.io/file/v2.1.0/schema.json" }],
    });

    expect(() => openStacCogAsset(suffixOnly, { decoderFactory: factory, fetchFn })).toThrowError(
      expect.objectContaining({ code: "invalid-candidate" }),
    );
    expect(factory).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();

    expect(() =>
      openStacCogAsset(
        candidate({
          evidence: [{ kind: "extension", value: "https://stac-extensions.github.io/file/v2.1.0/schema.json" }],
        }),
        { decoderFactory: factory, fetchFn },
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-candidate" }));
    expect(factory).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects malformed secondary classification evidence as a typed candidate error", () => {
    const factory = vi.fn(async () => fixtureDecoder());
    const fetchFn = vi.fn(partialRangeFetch());
    const malformed = candidate({
      evidence: [
        ...candidate().evidence,
        { kind: "role", value: "data", supports: "cog" } as unknown as StacAssetCandidate["evidence"][number],
      ],
    });

    expect(() => openStacCogAsset(malformed, { decoderFactory: factory, fetchFn })).toThrowError(
      expect.objectContaining({ name: "HonuaCogError", code: "invalid-candidate" }),
    );
    expect(factory).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects decoded sample arrays that contradict inspected band metadata", async () => {
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async () =>
        fixtureDecoder({
          async readWindow() {
            return { width: 2, height: 2, bands: [{ band: 1, values: new Uint16Array(4) }] };
          },
        }),
      fetchFn: partialRangeFetch(),
    });

    await session.inspect();
    await expect(session.readWindow({ x: 0, y: 0, width: 2, height: 2, bands: [1] })).rejects.toMatchObject({
      name: "HonuaCogError",
      code: "invalid-window",
    });
    await session.dispose();
  });

  it("limits the factory signal to initialization and uses operation signals after it settles", async () => {
    const controller = new AbortController();
    let initializationSignal: AbortSignal | undefined;
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async ({ signal }) => {
        initializationSignal = signal;
        return fixtureDecoder();
      },
      fetchFn: partialRangeFetch(),
    });

    await session.inspect({ signal: controller.signal });
    controller.abort();
    expect(initializationSignal?.aborted).toBe(false);
    await expect(session.readWindow({ x: 0, y: 0, width: 2, height: 2, bands: [1] })).resolves.toMatchObject({
      width: 2,
      height: 2,
    });
    await session.dispose();
    expect(initializationSignal?.aborted).toBe(true);
  });

  it.each([
    ["ignored Range", async () => new Response(new Uint8Array(1024), { status: 200 }), "range-unsupported"],
    [
      "opaque CORS response",
      async () => {
        const response = new Response(null, {
          status: 206,
          headers: { "Content-Range": `bytes 0-7/${fixtureBytes.byteLength}` },
        });
        Object.defineProperty(response, "type", { configurable: true, value: "opaque" });
        return response;
      },
      "cors-unavailable",
    ],
  ])("fails visibly for %s without whole-file fallback", async (_label, implementation, code) => {
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async () => fixtureDecoder(),
      fetchFn: vi.fn(implementation) as typeof fetch,
    });
    await expect(session.inspect()).rejects.toMatchObject({ code });
    expect(session.transfer().bytesFetched).toBe(0);
    await session.dispose();
  });

  it("rejects dishonest streamed overflow and records the bytes received", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 206,
        headers: { "Content-Range": `bytes 0-3/${fixtureBytes.byteLength}` },
      });
    }) as typeof fetch;
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async () =>
        fixtureDecoder({
          async inspect({ readRange }) {
            await readRange({ offset: 0, length: 4 });
            return fixture.metadata;
          },
        }),
      fetchFn,
    });

    await expect(session.inspect()).rejects.toMatchObject({ code: "range-overflow" });
    expect(session.transfer()).toMatchObject({
      requests: 1,
      bytesFetched: 5,
      ranges: [{ outcome: "rejected", errorCode: "range-overflow", bytesReceived: 5 }],
    });
    await session.dispose();
  });

  it("rejects a range that covers the complete resource before reading it", async () => {
    const bytes = new Uint8Array(8);
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async () => fixtureDecoder(),
      fetchFn: partialRangeFetch(bytes),
    });
    await expect(session.inspect()).rejects.toMatchObject({ code: "whole-file-disallowed" });
    expect(session.transfer().bytesFetched).toBe(0);
    await session.dispose();
  });

  it.each([
    ["non-cloud-optimized GeoTIFF", { ...fixture.metadata, format: "geotiff" }, "unsupported-format"],
    [
      "unsupported CRS",
      { ...fixture.metadata, crs: { kind: "unsupported", description: "local engineering grid" } },
      "unsupported-crs",
    ],
  ])("fails closed for %s decoder truth", async (_label, metadata, code) => {
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async () =>
        fixtureDecoder({
          async inspect() {
            return metadata as CogDecodedMetadata;
          },
        }),
      fetchFn: partialRangeFetch(),
    });
    await expect(session.inspect()).rejects.toMatchObject({ code });
    await session.dispose();
  });

  it("enforces range and request ceilings before another network request", async () => {
    const fetchFn = partialRangeFetch();
    const tooLarge = openStacCogAsset(candidate(), {
      decoderFactory: async () =>
        fixtureDecoder({
          async inspect({ readRange }) {
            await readRange({ offset: 0, length: 9 });
            return fixture.metadata;
          },
        }),
      fetchFn,
      limits: { maxRangeBytes: 8 },
    });
    await expect(tooLarge.inspect()).rejects.toMatchObject({ code: "invalid-range" });
    expect(fetchFn).not.toHaveBeenCalled();
    await tooLarge.dispose();

    const oneRequest = openStacCogAsset(candidate(), {
      decoderFactory: async () => fixtureDecoder(),
      fetchFn: partialRangeFetch(),
      limits: { maxMetadataRequests: 1 },
    });
    await expect(oneRequest.inspect()).rejects.toMatchObject({ code: "request-limit-exceeded" });
    expect(oneRequest.transfer().requests).toBe(1);
    await oneRequest.dispose();
  });

  it("cancels obsolete window ranges while allowing the newest read to finish", async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range")!;
      seen.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start === 64) {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      }
      return new Response(fixtureBytes.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fixtureBytes.byteLength}`,
          "Content-Length": String(end - start + 1),
          ETag: '"asset-v1"',
        },
      });
    }) as typeof fetch;
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async () =>
        fixtureDecoder({
          async inspect() {
            return fixture.metadata;
          },
          async readWindow(request, { readRange }) {
            const offset = request.x === 0 ? 64 : 68;
            const values = await readRange({ offset, length: 4 });
            return { width: 2, height: 2, bands: [{ band: 1, values }] };
          },
        }),
      fetchFn,
    });

    await session.inspect();
    const first = session.readWindow({ x: 0, y: 0, width: 2, height: 2, bands: [1] });
    await vi.waitFor(() => expect(seen).toContain("bytes=64-67"));
    const second = session.readWindow({ x: 1, y: 0, width: 2, height: 2, bands: [1] });

    await expect(first).rejects.toMatchObject({ code: "obsolete-read" });
    await expect(second).resolves.toMatchObject({ window: { x: 1 }, transfer: { windowRequests: 2 } });
    expect(session.transfer().ranges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequence: 1, outcome: "aborted", errorCode: "aborted" }),
        expect.objectContaining({ sequence: 2, outcome: "success" }),
      ]),
    );
    await session.dispose();
  });

  it("cancels a pending range body when its fetch implementation ignores the abort signal", async () => {
    let requestCount = 0;
    const cancelBody = vi.fn();
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      const range = new Headers(init?.headers).get("range")!;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      const headers = {
        "Content-Range": `bytes ${start}-${end}/${fixtureBytes.byteLength}`,
        "Content-Length": String(end - start + 1),
        ETag: '"asset-v1"',
      };
      if (requestCount === 1) {
        const body = new ReadableStream<Uint8Array>({
          pull() {
            // Deliberately never settles; the transport must cancel this reader directly.
          },
          cancel() {
            cancelBody();
          },
        });
        return new Response(body, { status: 206, headers });
      }
      return new Response(fixtureBytes.slice(start, end + 1), { status: 206, headers });
    }) as typeof fetch;
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async () =>
        fixtureDecoder({
          async inspect() {
            return fixture.metadata;
          },
          async readWindow(request, { readRange }) {
            const offset = request.x === 0 ? 64 : 68;
            const values = await readRange({ offset, length: 4 });
            return { width: 2, height: 2, bands: [{ band: 1, values }] };
          },
        }),
      fetchFn,
    });

    await session.inspect();
    const first = session.readWindow({ x: 0, y: 0, width: 2, height: 2, bands: [1] });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const second = session.readWindow({ x: 1, y: 0, width: 2, height: 2, bands: [1] });

    await expect(first).rejects.toMatchObject({ code: "obsolete-read" });
    await expect(second).resolves.toMatchObject({ window: { x: 1 } });
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(session.transfer().ranges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequence: 1, outcome: "aborted", errorCode: "aborted" }),
        expect.objectContaining({ sequence: 2, outcome: "success" }),
      ]),
    );
    await session.dispose();
  });

  it("maps external aborts and closes a decoder that settles after disposal", async () => {
    const controller = new AbortController();
    const session = openStacCogAsset(candidate(), {
      decoderFactory: async () => fixtureDecoder(),
      fetchFn: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      }) as typeof fetch,
    });
    const inspection = session.inspect({ signal: controller.signal });
    controller.abort();
    await expect(inspection).rejects.toMatchObject({ code: "aborted" });
    await session.dispose();

    let resolveFactory!: (decoder: CogDecoder) => void;
    const dispose = vi.fn();
    const lateFactory: CogDecoderFactory = () =>
      new Promise<CogDecoder>((resolve) => {
        resolveFactory = resolve;
      });
    const late = openStacCogAsset(candidate(), { decoderFactory: lateFactory, fetchFn: partialRangeFetch() });
    const pending = late.inspect();
    await Promise.resolve();
    await late.dispose();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    resolveFactory(fixtureDecoder({ dispose }));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it("keeps the experimental COG adapter out of stable root barrels", () => {
    const root = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const honua = fs.readFileSync(new URL("../src/honua.ts", import.meta.url), "utf8");
    expect(root).not.toMatch(/from ["']\.\/cog\//);
    expect(honua).not.toMatch(/from ["']\.\/cog\//);
  });
});

it("exports a typed COG error", () => {
  expect(new HonuaCogError("invalid-candidate", "fixture")).toMatchObject({
    name: "HonuaCogError",
    code: "invalid-candidate",
  });
});
