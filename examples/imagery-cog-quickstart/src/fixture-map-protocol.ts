import type { AddProtocolAction } from "maplibre-gl";

import fixtureManifest from "../fixture-cog-manifest.v1.json" with { type: "json" };

interface RenderFixture {
  id: string;
  path: string;
  mediaType: "image/png";
  bytes: number;
  sha256: string;
  license: "CC0-1.0";
  width: number;
  height: number;
  purpose: string;
}

interface FixtureMapManifest {
  asset: {
    bbox: [number, number, number, number];
  };
  renderFixtures: RenderFixture[];
}

interface MapLibreProtocolApi {
  addProtocol(name: string, handler: AddProtocolAction): void;
  removeProtocol(name: string): void;
}

const PROTOCOL = "honua-cog-fixture";
const manifest = fixtureManifest as unknown as FixtureMapManifest;
const fixtures = new Map(manifest.renderFixtures.map((fixture) => [fixture.id, fixture]));

async function verify(bytes: Uint8Array, expected: string): Promise<void> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  const actual = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) throw new Error(`fixture.integrity: render fixture digest mismatch (${actual}).`);
}

export function fixtureRasterTileUrl(id: string): string {
  if (id !== "terrain-rgb" || !fixtures.has(id))
    throw new Error(`fixture.protocol: unsupported raster tile fixture ${id}.`);
  return `${PROTOCOL}://${id}/{z}/{x}/{y}`;
}

export interface FixtureImageSourceDefinition {
  type: "image";
  url: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

export function fixtureImageSource(id: string, fixtureRootUrl: URL): FixtureImageSourceDefinition {
  const fixture = fixtures.get(id);
  if (!fixture || id === "terrain-rgb") throw new Error(`fixture.image-source: unsupported imagery fixture ${id}.`);
  const [west, south, east, north] = manifest.asset.bbox;
  return {
    type: "image",
    url: new URL(fixture.path, fixtureRootUrl).href,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  };
}

export function registerFixtureMapProtocol({
  maplibre,
  fixtureRootUrl,
  fetchImpl = globalThis.fetch.bind(globalThis),
}: {
  maplibre: MapLibreProtocolApi;
  fixtureRootUrl: URL;
  fetchImpl?: typeof fetch;
}): () => void {
  const cache = new Map<string, Uint8Array>();
  const handler: AddProtocolAction = async (request, abortController) => {
    const url = new URL(request.url);
    const fixture = fixtures.get(url.hostname);
    if (url.protocol !== `${PROTOCOL}:` || fixture?.id !== "terrain-rgb" || !/^\/\d+\/\d+\/\d+$/u.test(url.pathname))
      throw new Error(`fixture.protocol: unsupported tile identity ${request.url}.`);
    let bytes = cache.get(fixture.id);
    if (!bytes) {
      const response = await fetchImpl(new URL(fixture.path, fixtureRootUrl), { signal: abortController.signal });
      if (!response.ok) throw new Error(`fixture.protocol: ${fixture.path} returned ${response.status}.`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== fixture.bytes) throw new Error(`fixture.integrity: ${fixture.path} length mismatch.`);
      await verify(bytes, fixture.sha256);
      cache.set(fixture.id, bytes);
    }
    return { data: bytes.slice().buffer };
  };
  maplibre.addProtocol(PROTOCOL, handler);
  return () => {
    cache.clear();
    maplibre.removeProtocol(PROTOCOL);
  };
}

export const fixtureMapManifest = manifest;
