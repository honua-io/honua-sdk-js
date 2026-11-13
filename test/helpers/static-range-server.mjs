// Static file server for publication tests: single HTTP range requests, HEAD,
// CORS preflight, an optional per-response delay, and a log of every request
// with the bytes it sent. `rangeSupport` imitates other hosts: "get-only"
// answers HEAD with the whole length and status 200 as many CDNs do, "none"
// ignores Range entirely.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const MEDIA_TYPES = {
  ".json": "application/json",
  ".parquet": "application/vnd.apache.parquet",
  ".pmtiles": "application/vnd.pmtiles",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
};

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  if (match[1] === "") return { start: Math.max(0, size - Number(match[2])), end: size - 1 };
  return { start: Number(match[1]), end: match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Range, If-None-Match, Accept");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, ETag");
}

function fileContents(cache, file) {
  if (!cache.has(file)) {
    const bytes = readFileSync(file);
    cache.set(file, { bytes, etag: `"${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}"` });
  }
  return cache.get(file);
}

function requestedRange(request, size, rangeSupport) {
  if (rangeSupport === "none" || (rangeSupport === "get-only" && request.method === "HEAD")) return undefined;
  return parseRange(request.headers.range, size);
}

function sendFile({ request, response, entry }, { file, contents, cacheControl, rangeSupport }) {
  const { bytes, etag } = contents;
  response.setHeader("Content-Type", MEDIA_TYPES[path.extname(file)] ?? "application/octet-stream");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", cacheControl);
  const range = requestedRange(request, bytes.length, rangeSupport);
  if (range && range.start >= bytes.length) {
    entry.status = 416;
    response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end();
    return;
  }
  const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
  entry.status = range ? 206 : 200;
  entry.bytes = request.method === "HEAD" ? 0 : body.length;
  response.writeHead(entry.status, {
    "Content-Length": body.length,
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}` } : {}),
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

/**
 * @param {{ files: Record<string, string>, delayMs?: number, cors?: boolean, cacheControl?: string, rangeSupport?: "full" | "get-only" | "none" }} options
 *   files maps a URL path (for example "/maui/parcels.parquet") to a file on disk.
 */
export async function startStaticRangeServer({
  files,
  delayMs = 0,
  cors = true,
  cacheControl = "no-cache",
  rangeSupport = "full",
}) {
  const requests = [];
  const cache = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const entry = { method: request.method, path: url.pathname, range: request.headers.range ?? null, status: 0, bytes: 0 };
    requests.push(entry);
    if (cors) setCorsHeaders(response);
    const file = files[url.pathname];
    if (request.method === "OPTIONS" || !file) {
      entry.status = request.method === "OPTIONS" ? 204 : 404;
      response.writeHead(entry.status).end();
      return;
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    sendFile({ request, response, entry }, { file, contents: fileContents(cache, file), cacheControl, rangeSupport });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    bytesSent(pathname) {
      return requests.filter((entry) => !pathname || entry.path === pathname).reduce((total, entry) => total + entry.bytes, 0);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
