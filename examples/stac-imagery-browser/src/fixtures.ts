import { HonuaClient } from "@honua/sdk-js/honua";
import type { DynamicStacClient, DynamicStacClientOptions, HonuaStacItemResponse } from "@honua/sdk-js/stac";

export const FIXTURE_STAC_ROOT = "https://stac.fixture.honua.test/v1";
export const MAUI_COLLECTION_ID = "sentinel-2-l2a";
export const PMTILES_AUTHORIZATION_SCOPE = "fixture:maui:pmtiles";
export const PMTILES_INSPECTION_LIMITS = Object.freeze({
  maxRequests: 1,
  maxRangeBytes: 16 * 1024,
  maxTotalBytes: 16 * 1024,
  maxDecompressedBytes: 4 * 1024,
});

const PMTILES_ETAG = '"maui-pmtiles-v3"';
const PMTILES_VIRTUAL_BYTES = 64 * 1024;
const PMTILES_FIXTURE_BASE64 =
  "UE1UaWxlcwN/AAAAAAAAABkAAAAAAAAAmAAAAAAAAADIAAAAAAAAAGABAAAAAAAAAAAAAAAAAABgAQAAAAAAABQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAQICAQAFACyRtoDADRZAkpS3gNvEFgMg3xK3AE5pFh+LCAAAAAAAAANjZGAUYQQAWVMpowUAAAAfiwgAAAAAAAADjY+xSgRBEER/ZahIYQITk/kCA4VDzY5D2p2+o2Gme5mePW5d9t/luMVEBLMKXtWjFihVRsKT6URh9/IuhT041bFwuDvz0K3dI6LP4xWzM7dCMyKo9yafUxfTP+qIuPU/Cs3cHGm/QDISCmme/Apk9qHJuK08k+YwOYfRynwydURU0S+zivQQUelyy48RR+GSHWnBUMgdCW+9iZ6wrnHTNKPsvySvRjkMrJ1bEeX/Obb7P4rD+g3ykNp3OgEAAB+LCAAAAAAAAAMDAAAAAAAAAAAA";

export interface StacFixtureTrace {
  readonly stage: "request" | "sign" | "range" | "cancel";
  readonly method: "GET" | "POST" | "SIGN" | "RANGE" | "ABORT";
  readonly url: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly assetKey?: string;
  readonly range?: string;
  readonly status?: number;
  readonly authorization?: "none" | "[redacted]";
}

export interface StacFixtureEnvironment {
  readonly stac: DynamicStacClient;
  readonly trace: StacFixtureTrace[];
  readonly fetchAsset: typeof fetch;
  createAssetClient(endpoint: string): HonuaClient;
  resetTrace(): void;
  setTraceScope(signal: AbortSignal, scope: number): void;
  setTraceSelection(signal: AbortSignal, selection: number): void;
  traceForScope(scope: number, selection?: number): StacFixtureTrace[];
}

export interface StacFixtureOptions {
  readonly assetDelayMs?: number;
  readonly pmtilesDelayMs?: number;
  readonly pageDelayMs?: number;
  readonly pages?: readonly (readonly HonuaStacItemResponse[])[];
}

const BOUNDS = {
  west: [-156.72, 20.69, -156.33, 20.99],
  central: [-156.52, 20.63, -156.08, 20.96],
  east: [-156.32, 20.58, -155.88, 20.9],
} as const;

export const MAUI_ITEMS: readonly HonuaStacItemResponse[] = [
  mauiItem({
    id: "S2B_MAUI_20260502_WEST",
    title: "West Maui cloud break",
    datetime: "2026-05-02T21:20:29Z",
    cloudCover: 7,
    platform: "sentinel-2b",
    bbox: BOUNDS.west,
    preview: "west-maui-preview.png",
  }),
  mauiItem({
    id: "S2A_MAUI_20260424_CENTRAL",
    title: "Central Maui clear pass",
    datetime: "2026-04-24T21:18:54Z",
    cloudCover: 12,
    platform: "sentinel-2a",
    bbox: BOUNDS.central,
    preview: "central-maui-preview.png",
  }),
  mauiItem({
    id: "S2B_MAUI_20260418_EAST",
    title: "Haleakala east slope",
    datetime: "2026-04-18T21:20:29Z",
    cloudCover: 18,
    platform: "sentinel-2b",
    bbox: BOUNDS.east,
    preview: "east-maui-preview.png",
  }),
];

export function createStacFixtureEnvironment(
  createClient: (options: DynamicStacClientOptions) => DynamicStacClient,
  options: StacFixtureOptions = {},
): StacFixtureEnvironment {
  const trace: StacFixtureTrace[] = [];
  const traceScopes = new WeakMap<StacFixtureTrace, number>();
  const traceSelections = new WeakMap<StacFixtureTrace, number>();
  const signalScopes = new WeakMap<AbortSignal, number>();
  const signalSelections = new WeakMap<AbortSignal, number>();
  let activeTraceScope = 0;
  let lastAbortedTraceScope = 0;
  const resolveTraceScope = (signal: AbortSignal | null | undefined): number => {
    const mappedScope = signal ? signalScopes.get(signal) : undefined;
    if (mappedScope !== undefined) return mappedScope;
    return signal?.aborted ? lastAbortedTraceScope : activeTraceScope;
  };
  const resolveTraceSelection = (signal: AbortSignal | null | undefined): number | undefined =>
    signal ? signalSelections.get(signal) : undefined;
  const recordTrace = (entry: StacFixtureTrace, scope = activeTraceScope, selection?: number): void => {
    trace.push(entry);
    traceScopes.set(entry, scope);
    if (selection !== undefined) traceSelections.set(entry, selection);
  };
  const pages = options.pages ?? [MAUI_ITEMS.slice(0, 2), MAUI_ITEMS.slice(2)];
  const assetDelayMs = options.assetDelayMs ?? 0;
  const fetchAsset = createFixtureFetch(
    recordTrace,
    resolveTraceScope,
    resolveTraceSelection,
    assetDelayMs,
    options.pmtilesDelayMs ?? assetDelayMs,
    options.pageDelayMs ?? 80,
    pages,
  );
  const stac = createClient({
    baseUrl: FIXTURE_STAC_ROOT,
    clientOptions: {
      fetchFn: fetchAsset,
      auth: { getCredentials: () => ({ bearerToken: STAC_FIXTURE_AUTH_SENTINEL }) },
    },
    refreshAssetUrl: async ({ assetKey, asset, signal }) => {
      const traceScope = resolveTraceScope(signal);
      const traceSelection = resolveTraceSelection(signal);
      await abortableDelay(
        assetDelayMs,
        signal,
        recordTrace,
        traceScope,
        traceSelection,
        new URL(asset.href, FIXTURE_STAC_ROOT),
      );
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      recordTrace({ stage: "sign", method: "SIGN", url: asset.href, assetKey }, traceScope, traceSelection);
      if (assetKey === "tiles") return asset.href.replace("/assets/", "/assets/signed/maui-v3/");
      return `${asset.href}${asset.href.includes("?") ? "&" : "?"}signed=fixture`;
    },
  });
  return {
    stac,
    trace,
    fetchAsset,
    createAssetClient(endpoint) {
      return new HonuaClient({
        baseUrl: new URL(endpoint).origin,
        fetchFn: fetchAsset,
        auth: { getCredentials: () => ({ bearerToken: STAC_FIXTURE_AUTH_SENTINEL }) },
      });
    },
    resetTrace() {
      trace.length = 0;
    },
    setTraceScope(signal, scope) {
      activeTraceScope = scope;
      signalScopes.set(signal, scope);
      signal.addEventListener(
        "abort",
        () => {
          lastAbortedTraceScope = scope;
        },
        { once: true },
      );
    },
    setTraceSelection(signal, selection) {
      signalSelections.set(signal, selection);
    },
    traceForScope(scope, selection) {
      return trace.filter(
        (entry) =>
          traceScopes.get(entry) === scope &&
          (selection === undefined ||
            traceSelections.get(entry) === undefined ||
            traceSelections.get(entry) === selection),
      );
    },
  };
}

function createFixtureFetch(
  recordTrace: (entry: StacFixtureTrace, scope?: number, selection?: number) => void,
  resolveTraceScope: (signal: AbortSignal | null | undefined) => number,
  resolveTraceSelection: (signal: AbortSignal | null | undefined) => number | undefined,
  assetDelayMs: number,
  pmtilesDelayMs: number,
  pageDelayMs: number,
  pages: readonly (readonly HonuaStacItemResponse[])[],
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? input.toString());
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase() as "GET" | "POST";
    const body = parseBody(init?.body);
    const signal = init?.signal ?? request?.signal;
    const traceScope = resolveTraceScope(signal);
    const traceSelection = resolveTraceSelection(signal);
    const traceUrl = redactedTraceUrl(url);
    recordTrace({ stage: "request", method, url: traceUrl, ...(body ? { body } : {}) }, traceScope, traceSelection);

    if (url.pathname.endsWith("/v1") || url.pathname.endsWith("/v1/")) {
      return Response.json({
        stac_version: "1.0.0",
        type: "Catalog",
        id: "honua-maui-fixture",
        description: "Deterministic Maui imagery fixture",
        conformsTo: ["https://api.stacspec.org/v1.0.0/item-search"],
        links: [
          { rel: "data", href: "./collections", type: "application/json" },
          { rel: "search", href: "./search", type: "application/geo+json", method: "GET" },
          { rel: "search", href: "./search", type: "application/geo+json", method: "POST" },
        ],
      });
    }

    if (url.pathname.endsWith("/collections")) {
      return Response.json({
        collections: [
          {
            id: MAUI_COLLECTION_ID,
            title: "Sentinel-2 L2A Maui fixture",
            description: "Three pinned Maui observations for deterministic product evidence.",
            license: "CC-BY-4.0",
            extent: {
              spatial: { bbox: [[-156.75, 20.55, -155.85, 21.05]] },
              temporal: { interval: [["2026-04-01T00:00:00Z", "2026-05-05T23:59:59Z"]] },
            },
            links: [{ rel: "self", href: `./collections/${MAUI_COLLECTION_ID}` }],
          },
        ],
        links: [{ rel: "root", href: "./" }],
      });
    }

    if (url.pathname.endsWith("/search")) {
      const token = method === "POST" ? body?.token : url.searchParams.get("token");
      const pageIndex =
        typeof token === "string" && /^maui-page-[2-9][0-9]*$/u.test(token)
          ? Number.parseInt(token.slice("maui-page-".length), 10) - 1
          : 0;
      if (pageIndex > 0) {
        await abortableDelay(pageDelayMs, signal, recordTrace, traceScope, traceSelection, url);
      }
      const features = pages[pageIndex] ?? [];
      const hasNext = pageIndex + 1 < pages.length;
      const nextToken = `maui-page-${pageIndex + 2}`;
      return Response.json({
        type: "FeatureCollection",
        features,
        links: !hasNext
          ? []
          : method === "POST"
            ? [{ rel: "next", href: "./search", method: "POST", body: { token: nextToken }, merge: true }]
            : [{ rel: "next", href: `./search?token=${nextToken}`, method: "GET" }],
        context: { matched: pages.reduce((total, page) => total + page.length, 0), returned: features.length },
      });
    }

    if (url.pathname.includes("/assets/") && url.pathname.endsWith(".png")) {
      await abortableDelay(assetDelayMs, signal, recordTrace, traceScope, traceSelection, url);
      return new Response(previewPng(), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (url.pathname.includes("/assets/") && url.pathname.endsWith(".pmtiles")) {
      const headers = mergedRequestHeaders(request, init);
      const range = headers.get("range");
      const authorization = headers.get("authorization");
      if (
        !url.pathname.includes("/assets/signed/maui-v3/") ||
        authorization !== `Bearer ${STAC_FIXTURE_AUTH_SENTINEL}`
      ) {
        return Response.json({ message: "Fixture asset authorization required." }, { status: 401 });
      }
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range ?? "");
      if (!match) return Response.json({ message: "An exact PMTiles byte range is required." }, { status: 416 });
      const start = Number(match[1]);
      const end = Number(match[2]);
      const fixture = pmtilesFixture();
      if (start < 0 || end < start || end >= fixture.byteLength) {
        return Response.json({ message: "PMTiles byte range is outside the fixture." }, { status: 416 });
      }
      await abortableDelay(pmtilesDelayMs, signal, recordTrace, traceScope, traceSelection, url);
      const responseBytes = fixture.slice(start, end + 1);
      recordTrace(
        {
          stage: "range",
          method: "RANGE",
          url: traceUrl,
          range: range ?? undefined,
          status: 206,
          authorization: "[redacted]",
        },
        traceScope,
        traceSelection,
      );
      return new Response(responseBytes, {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(responseBytes.byteLength),
          "content-range": `bytes ${start}-${end}/${fixture.byteLength}`,
          "content-type": "application/vnd.pmtiles",
          etag: PMTILES_ETAG,
        },
      });
    }

    return Response.json({ message: `Unknown fixture route: ${url.pathname}` }, { status: 404 });
  };
}

function mauiItem(input: {
  readonly id: string;
  readonly title: string;
  readonly datetime: string;
  readonly cloudCover: number;
  readonly platform: "sentinel-2a" | "sentinel-2b";
  readonly bbox: readonly [number, number, number, number];
  readonly preview: string;
}): HonuaStacItemResponse {
  const [xmin, ymin, xmax, ymax] = input.bbox;
  return {
    type: "Feature",
    id: input.id,
    collection: MAUI_COLLECTION_ID,
    bbox: [...input.bbox],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [xmin, ymin],
          [xmax, ymin],
          [xmax, ymax],
          [xmin, ymax],
          [xmin, ymin],
        ],
      ],
    },
    properties: {
      title: input.title,
      datetime: input.datetime,
      "eo:cloud_cover": input.cloudCover,
      platform: input.platform,
      "proj:epsg": 32604,
    },
    links: [{ rel: "self", href: `./collections/${MAUI_COLLECTION_ID}/items/${input.id}` }],
    assets: {
      preview: {
        href: `./assets/${input.preview}`,
        type: "image/png",
        title: "Maui visual preview",
        roles: ["visual"],
      },
      visual: {
        href: "./assets/maui-visual.tif",
        type: "image/tiff; application=geotiff; profile=cloud-optimized",
        title: "Cloud-optimized visual raster",
        roles: ["visual", "data"],
        "proj:code": "EPSG:32604",
        "raster:bands": [
          { name: "B04", common_name: "red", data_type: "uint16", scale: 0.0001 },
          { name: "B03", common_name: "green", data_type: "uint16", scale: 0.0001 },
          { name: "B02", common_name: "blue", data_type: "uint16", scale: 0.0001 },
        ],
      },
      tiles: {
        href: "./assets/maui.pmtiles",
        type: "application/vnd.pmtiles",
        title: "Maui vector overlay",
        roles: ["data"],
      },
      parcels: {
        href: "./assets/maui.parquet",
        type: "application/vnd.apache.parquet",
        title: "Maui analysis table",
        roles: ["data"],
      },
      metadata: {
        href: "./assets/maui.json",
        type: "application/json",
        title: "Provider metadata",
        roles: ["metadata"],
      },
    },
  };
}

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> | undefined {
  if (typeof body !== "string" || body.length === 0) return undefined;
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal | null | undefined,
  recordTrace: (entry: StacFixtureTrace, scope?: number, selection?: number) => void,
  traceScope: number,
  traceSelection: number | undefined,
  url: URL,
): Promise<void> {
  if (signal?.aborted) {
    recordTrace({ stage: "cancel", method: "ABORT", url: redactedTraceUrl(url) }, traceScope, traceSelection);
    throw new DOMException("aborted", "AbortError");
  }
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      recordTrace({ stage: "cancel", method: "ABORT", url: redactedTraceUrl(url) }, traceScope, traceSelection);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function mergedRequestHeaders(request: Request | undefined, init: RequestInit | undefined): Headers {
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return headers;
}

function redactedTraceUrl(input: URL): string {
  const url = new URL(input);
  url.pathname = url.pathname.replace("/assets/signed/maui-v3/", "/assets/signed/REDACTED/");
  for (const name of ["signed", "sig", "signature", "access_token"]) {
    if (url.searchParams.has(name)) url.searchParams.set(name, "[redacted]");
  }
  return url.href;
}

function pmtilesFixture(): Uint8Array<ArrayBuffer> {
  const committed = Uint8Array.from(atob(PMTILES_FIXTURE_BASE64), (character) => character.charCodeAt(0));
  const fixture = new Uint8Array(PMTILES_VIRTUAL_BYTES);
  fixture.set(committed);
  return fixture;
}

function previewPng(): Uint8Array<ArrayBuffer> {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADCSURBVChTBcGhrcUgAEBRZmADNmADNkDgwTzzQqipoAIMCEwTUlODeeaHNe8/R0gXUO6Ddl+MO7DuxLuL5CrFNYQMH1T4osOBCSc2XPhQSaFRwkDI+EXFAx1PTLywseJjI8VBiTdC5gOVT3S+MLlic8PnQco3JT8I2U9Uv9C9YnrD9oHvN6k/lP4i5LxQs6Jnw8yBnTd+PqT5UuZCyFVRq6HXwKwbux78eklrUdYPIXdD7YHeN2Y/2P3i9yLtH2X/8Q8IkZChO6EkQgAAAABJRU5ErkJggg==";
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}
import { STAC_FIXTURE_AUTH_SENTINEL } from "./fixture-auth-sentinel.js";
