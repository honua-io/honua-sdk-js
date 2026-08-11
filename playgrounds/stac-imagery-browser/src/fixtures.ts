import type { DynamicStacClient, DynamicStacClientOptions, HonuaStacItemResponse } from "@honua/sdk-js/stac";

export const FIXTURE_STAC_ROOT = "https://stac.fixture.honua.test/v1";
export const MAUI_COLLECTION_ID = "sentinel-2-l2a";

export interface StacFixtureTrace {
  readonly stage: "request" | "sign" | "cancel";
  readonly method: "GET" | "POST" | "SIGN" | "ABORT";
  readonly url: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly assetKey?: string;
}

export interface StacFixtureEnvironment {
  readonly stac: DynamicStacClient;
  readonly trace: StacFixtureTrace[];
  readonly fetchAsset: typeof fetch;
  resetTrace(): void;
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
    bbox: BOUNDS.west,
    preview: "west-maui-preview.svg",
  }),
  mauiItem({
    id: "S2A_MAUI_20260424_CENTRAL",
    title: "Central Maui clear pass",
    datetime: "2026-04-24T21:18:54Z",
    cloudCover: 12,
    bbox: BOUNDS.central,
    preview: "central-maui-preview.svg",
  }),
  mauiItem({
    id: "S2B_MAUI_20260418_EAST",
    title: "Haleakala east slope",
    datetime: "2026-04-18T21:20:29Z",
    cloudCover: 18,
    bbox: BOUNDS.east,
    preview: "east-maui-preview.svg",
  }),
];

export function createStacFixtureEnvironment(
  createClient: (options: DynamicStacClientOptions) => DynamicStacClient,
  pageDelayMs = 80,
): StacFixtureEnvironment {
  const trace: StacFixtureTrace[] = [];
  const fetchAsset = createFixtureFetch(trace, pageDelayMs);
  const stac = createClient({
    baseUrl: FIXTURE_STAC_ROOT,
    clientOptions: { fetchFn: fetchAsset },
    refreshAssetUrl: async ({ assetKey, asset, signal }) => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      trace.push({ stage: "sign", method: "SIGN", url: asset.href, assetKey });
      return `${asset.href}${asset.href.includes("?") ? "&" : "?"}signed=fixture`;
    },
  });
  return {
    stac,
    trace,
    fetchAsset,
    resetTrace() {
      trace.length = 0;
    },
  };
}

function createFixtureFetch(trace: StacFixtureTrace[], pageDelayMs: number): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? input.toString());
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase() as "GET" | "POST";
    const body = parseBody(init?.body);
    trace.push({ stage: "request", method, url: url.href, ...(body ? { body } : {}) });

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
      if (token === "maui-page-2") await abortableDelay(pageDelayMs, init?.signal ?? request?.signal, trace, url);
      const secondPage = token === "maui-page-2";
      return Response.json({
        type: "FeatureCollection",
        features: secondPage ? [MAUI_ITEMS[2]] : MAUI_ITEMS.slice(0, 2),
        links: secondPage
          ? []
          : method === "POST"
            ? [{ rel: "next", href: "./search", method: "POST", body: { token: "maui-page-2" }, merge: true }]
            : [{ rel: "next", href: "./search?token=maui-page-2", method: "GET" }],
        context: { matched: MAUI_ITEMS.length, returned: secondPage ? 1 : 2 },
      });
    }

    if (url.pathname.includes("/assets/") && url.pathname.endsWith(".svg")) {
      return new Response(previewSvg(url.pathname), {
        status: 200,
        headers: { "content-type": "image/svg+xml; charset=utf-8" },
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
      platform: "sentinel-2b",
      "proj:epsg": 32604,
    },
    links: [{ rel: "self", href: `./collections/${MAUI_COLLECTION_ID}/items/${input.id}` }],
    assets: {
      preview: {
        href: `./assets/${input.preview}`,
        type: "image/svg+xml",
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
  trace: StacFixtureTrace[],
  url: URL,
): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timer);
      trace.push({ stage: "cancel", method: "ABORT", url: url.href });
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function previewSvg(pathname: string): string {
  const accent = pathname.includes("west") ? "#f4b942" : pathname.includes("central") ? "#e77728" : "#8ac6a1";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" role="img" aria-label="Selected Maui imagery preview">
  <defs><linearGradient id="ocean" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#073b4c"/><stop offset="1" stop-color="#1d7f78"/></linearGradient><filter id="grain"><feTurbulence baseFrequency=".7" numOctaves="2" seed="7" result="n"/><feBlend in="SourceGraphic" in2="n" mode="soft-light"/></filter></defs>
  <rect width="960" height="540" fill="url(#ocean)"/>
  <path d="M86 318c72-95 151-135 239-109 70 21 85 80 156 67 66-13 79-94 165-119 84-25 175 11 228 104-81 10-122 54-183 91-74 45-136 56-226 35-115-27-204-20-379-69z" fill="${accent}" filter="url(#grain)"/>
  <path d="M319 209c39 32 63 65 72 103M646 158c-29 59-55 109-96 153" fill="none" stroke="#fff7dc" stroke-opacity=".55" stroke-width="9"/>
  <circle cx="480" cy="287" r="8" fill="#fff7dc"/><text x="502" y="296" fill="#fff7dc" font-family="Georgia,serif" font-size="30">Maui</text>
</svg>`;
}
