import fixtureManifest from "../fixture-cog-manifest.v1.json";

interface Chunk { path: string; offset: number; bytes: number; sha256: string }
interface Manifest { asset: { path: string; mediaType: string; bytes: number; sha256: string; etag: string; license: string; width: number; height: number; bbox: [number, number, number, number] }; chunks: Chunk[] }
export interface FixtureCogTransportSnapshot { virtualRangeRequests: number; virtualRangeBytes: number; chunkRequests: number; chunkBytes: number; fullAssetRequests: number; verifiedChunks: number }
const manifest = fixtureManifest as unknown as Manifest, cache = new Map<string, Uint8Array>();
const telemetry = { virtualRangeRequests: 0, virtualRangeBytes: 0, chunkRequests: 0, chunkBytes: 0, fullAssetRequests: 0 };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "public, max-age=31536000, immutable" } });
function item() {
  const [w, s, e, n] = manifest.asset.bbox;
  const assets: Record<string, unknown> = { cog: { href: `./${manifest.asset.path}`, type: manifest.asset.mediaType, roles: ["data"], title: "Deterministic Oahu natural-color COG fixture", "file:size": manifest.asset.bytes, "checksum:multihash": `sha256:${manifest.asset.sha256}` } };
  for (const key of ["cog-alt", "slow-cog", "no-range-cog", "cors-cog", "unsupported-crs", "unsupported-format"]) assets[key] = { href: `./assets/${key}`, type: manifest.asset.mediaType, roles: ["data"] };
  return { type: "Feature", stac_version: "1.0.0", id: "oahu-natural-color-fixture-v1", bbox: [w, s, e, n], geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: { datetime: "2024-01-01T00:00:00Z", license: manifest.asset.license, "proj:epsg": 4326, "proj:shape": [manifest.asset.height, manifest.asset.width], "proj:bbox": [w, s, e, n] }, links: [], assets };
}
async function verify(bytes: Uint8Array, expected: string) { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)); const actual = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(""); if (actual !== expected) throw new Error(`fixture.integrity: chunk digest mismatch (${actual}).`); }
export const fixtureCogTransportSnapshot = (): FixtureCogTransportSnapshot => ({ ...telemetry, verifiedChunks: cache.size });
export function createFixtureCogFetch({ fixtureRootUrl, fetchImpl = globalThis.fetch.bind(globalThis) }: { fixtureRootUrl: URL; fetchImpl?: typeof fetch }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init), url = new URL(request.url), method = request.method.toUpperCase();
    if (method === "GET" && url.pathname.endsWith("/fixtures/cog/item.json")) return json(item());
    if (method === "POST" && url.pathname.endsWith("/stac/search")) return json({ type: "FeatureCollection", features: [item()], links: [] });
    if (!url.pathname.endsWith(`/fixtures/cog/${manifest.asset.path}`)) return fetchImpl(request);
    if (method === "HEAD") return new Response(null, { headers: { "accept-ranges": "bytes", "content-length": String(manifest.asset.bytes), "content-type": manifest.asset.mediaType, etag: manifest.asset.etag } });
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
    if (!match) { telemetry.fullAssetRequests += 1; return new Response("Range-only fixture", { status: 413, headers: { "content-range": `bytes */${manifest.asset.bytes}` } }); }
    const start = Number(match[1]), end = Number(match[2]), length = end - start + 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= manifest.asset.bytes || length > 64 * 1024) return new Response("Invalid range", { status: 416, headers: { "content-range": `bytes */${manifest.asset.bytes}` } });
    const output = new Uint8Array(length);
    for (const chunk of manifest.chunks.filter((candidate) => candidate.offset <= end && candidate.offset + candidate.bytes > start)) {
      let bytes = cache.get(chunk.path);
      if (!bytes) { const response = await fetchImpl(new URL(chunk.path, fixtureRootUrl), { signal: request.signal }); if (!response.ok) throw new Error(`fixture.transport: ${chunk.path} returned ${response.status}.`); bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length !== chunk.bytes) throw new Error(`fixture.integrity: ${chunk.path} length mismatch.`); await verify(bytes, chunk.sha256); cache.set(chunk.path, bytes); telemetry.chunkRequests += 1; telemetry.chunkBytes += bytes.length; }
      const copyStart = Math.max(start, chunk.offset), copyEnd = Math.min(end + 1, chunk.offset + chunk.bytes); output.set(bytes.subarray(copyStart - chunk.offset, copyEnd - chunk.offset), copyStart - start);
    }
    telemetry.virtualRangeRequests += 1; telemetry.virtualRangeBytes += length;
    return new Response(output, { status: 206, headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${manifest.asset.bytes}`, "content-length": String(length), "content-type": manifest.asset.mediaType, etag: manifest.asset.etag } });
  }) as typeof fetch;
}
export const fixtureCogManifest = manifest;
