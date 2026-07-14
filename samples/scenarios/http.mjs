import fs from "node:fs";
import path from "node:path";

export const FIXTURE_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
});

const RESERVED_HEADERS = new Set([
  "cache-control",
  "connection",
  "content-length",
  "content-security-policy",
  "content-type",
  "cross-origin-resource-policy",
  "referrer-policy",
  "transfer-encoding",
  "x-content-type-options",
  "x-honua-fixture-network",
]);

function sanitizedExtraHeaders(extra) {
  return Object.fromEntries(Object.entries(extra).filter(([name]) => !RESERVED_HEADERS.has(name.toLowerCase())));
}

export function fixtureHeaders(extra = {}) {
  return {
    ...sanitizedExtraHeaders(extra),
    "cache-control": "no-store",
    "content-security-policy": FIXTURE_CSP,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-honua-fixture-network": "loopback-only",
  };
}

export function fixtureResponseHeaders({ contentType, contentLength, connection }, extra = {}) {
  if (typeof contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+(?:; charset=utf-8)?$/.test(contentType)) {
    throw new TypeError("Fixture response content type is invalid.");
  }
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new TypeError("Fixture response content length is invalid.");
  }
  if (connection !== undefined && connection !== "keep-alive" && connection !== "close") {
    throw new TypeError("Fixture response connection mode is invalid.");
  }
  return {
    ...fixtureHeaders(extra),
    ...(connection ? { connection } : {}),
    ...(contentLength === undefined ? {} : { "content-length": contentLength }),
    "content-type": contentType,
  };
}

export function sendJson(res, status, value, extraHeaders = {}) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(
    status,
    fixtureResponseHeaders(
      { contentLength: Buffer.byteLength(body), contentType: "application/json; charset=utf-8" },
      extraHeaders,
    ),
  );
  res.end(body);
}

export function sendText(res, status, body, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, fixtureResponseHeaders({ contentLength: value.byteLength, contentType }, extraHeaders));
  res.end(value);
}

export async function readJsonBody(req, maximumBytes = 65_536) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw Object.assign(new Error("Request body exceeds fixture limit."), { status: 413 });
    chunks.push(chunk);
  }
  if (bytes === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON request body: ${error.message}`), { status: 400 });
  }
}

export function serveStaticFile(res, staticRoot, pathname) {
  if (!staticRoot) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, "Invalid URL encoding.");
    return true;
  }
  let decodedTwice = decoded;
  try {
    decodedTwice = decodeURIComponent(decoded);
  } catch {
    sendText(res, 400, "Invalid nested URL encoding.");
    return true;
  }
  if (
    decoded.includes("\0") ||
    decodedTwice.includes("\0") ||
    decoded.split("/").includes("..") ||
    decodedTwice.split(/[\\/]/).includes("..")
  ) {
    sendText(res, 400, "Path traversal is not allowed.");
    return true;
  }
  const root = fs.realpathSync(staticRoot);
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    sendText(res, 400, "Path traversal is not allowed.");
    return true;
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    const real = fs.realpathSync(candidate);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      sendText(res, 403, "Static symlink escape is not allowed.");
      return true;
    }
    const contentType = MIME_TYPES[path.extname(real)] ?? "application/octet-stream";
    sendText(res, 200, fs.readFileSync(real), contentType, {
      ...(contentType === "application/octet-stream" ? { "content-disposition": "attachment" } : {}),
    });
    return true;
  }
  if (decoded === "/" || !path.extname(decoded)) {
    const index = path.join(root, "index.html");
    if (fs.existsSync(index)) {
      sendText(res, 200, fs.readFileSync(index), "text/html; charset=utf-8");
      return true;
    }
  }
  return false;
}
