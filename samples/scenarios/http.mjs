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

const MAXIMUM_STATIC_FILE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_STATIC_FILE_BYTES_BIGINT = BigInt(MAXIMUM_STATIC_FILE_BYTES);
const READ_ONLY_NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const CACHE_POLICIES = Object.freeze({
  "no-store": "no-store",
  "private-fresh": "private, max-age=60",
  "private-revalidate": "private, max-age=0, must-revalidate",
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

export function fixtureHeaders(extra = {}, cachePolicy = "no-store") {
  const cacheControl = CACHE_POLICIES[cachePolicy];
  if (!cacheControl) throw new TypeError("Fixture cache policy is invalid.");
  return {
    ...sanitizedExtraHeaders(extra),
    "cache-control": cacheControl,
    "content-security-policy": FIXTURE_CSP,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-honua-fixture-network": "loopback-only",
  };
}

export function fixtureResponseHeaders(
  { contentType, contentLength, connection },
  extra = {},
  cachePolicy = "no-store",
) {
  const contentTypeSupported =
    typeof contentType === "string" &&
    (/^[\w.+-]+\/[\w.+-]+(?:; charset=utf-8)?$/.test(contentType) ||
      contentType === "application/vnd.oai.openapi+json;version=3.0; charset=utf-8");
  if (!contentTypeSupported) {
    throw new TypeError("Fixture response content type is invalid.");
  }
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new TypeError("Fixture response content length is invalid.");
  }
  if (connection !== undefined && connection !== "keep-alive" && connection !== "close") {
    throw new TypeError("Fixture response connection mode is invalid.");
  }
  return {
    ...fixtureHeaders(extra, cachePolicy),
    ...(connection ? { connection } : {}),
    ...(contentLength === undefined ? {} : { "content-length": contentLength }),
    "content-type": contentType,
  };
}

export function sendJson(res, status, value, extraHeaders = {}, cachePolicy = "no-store") {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(
    status,
    fixtureResponseHeaders(
      { contentLength: Buffer.byteLength(body), contentType: "application/json; charset=utf-8" },
      extraHeaders,
      cachePolicy,
    ),
  );
  res.end(body);
}

export function sendText(
  res,
  status,
  body,
  contentType = "text/plain; charset=utf-8",
  extraHeaders = {},
  cachePolicy = "no-store",
) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(
    status,
    fixtureResponseHeaders({ contentLength: value.byteLength, contentType }, extraHeaders, cachePolicy),
  );
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

function isInsideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isMissingPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function fixtureStaticError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createStaticRootBinding(staticRoot) {
  const resolved = path.resolve(staticRoot);
  const requestedStat = fs.lstatSync(resolved, { bigint: true });
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error("Fixture staticRoot must be a real directory.");
  }
  const canonicalPath = fs.realpathSync(resolved);
  const canonicalStat = fs.lstatSync(canonicalPath, { bigint: true });
  const completedStat = fs.lstatSync(resolved, { bigint: true });
  if (
    !canonicalStat.isDirectory() ||
    canonicalStat.isSymbolicLink() ||
    !completedStat.isDirectory() ||
    completedStat.isSymbolicLink() ||
    requestedStat.dev !== canonicalStat.dev ||
    requestedStat.ino !== canonicalStat.ino ||
    completedStat.dev !== canonicalStat.dev ||
    completedStat.ino !== canonicalStat.ino ||
    fs.realpathSync(resolved) !== canonicalPath
  ) {
    throw new Error("Fixture staticRoot must resolve to a real directory.");
  }
  return Object.freeze({ canonicalPath, device: canonicalStat.dev, inode: canonicalStat.ino });
}

function assertStaticRootBinding(binding) {
  let stat;
  try {
    stat = fs.lstatSync(binding.canonicalPath, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) throw fixtureStaticError(403, "Fixture static root binding is no longer available.");
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== binding.device || stat.ino !== binding.inode) {
    throw fixtureStaticError(403, "Fixture static root binding changed after startup.");
  }
}

function sameStableStaticFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertStaticFilePathBinding(binding, candidate, expectedReal, expectedStat) {
  assertStaticRootBinding(binding);
  let currentReal;
  let currentStat;
  try {
    currentReal = fs.realpathSync(candidate);
    currentStat = fs.lstatSync(currentReal, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) throw fixtureStaticError(409, "Static file changed while it was being read.");
    throw error;
  }
  if (
    currentReal !== expectedReal ||
    !isInsideRoot(binding.canonicalPath, currentReal) ||
    !currentStat.isFile() ||
    currentStat.isSymbolicLink() ||
    !sameStableStaticFile(currentStat, expectedStat)
  ) {
    throw fixtureStaticError(403, "Static file path changed or escaped its root while it was being read.");
  }
}

function readBoundedStaticFile(binding, candidate) {
  assertStaticRootBinding(binding);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (!isInsideRoot(binding.canonicalPath, real)) {
    throw fixtureStaticError(403, "Static symlink escape is not allowed.");
  }

  let expected;
  try {
    expected = fs.lstatSync(real, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (!expected.isFile() || expected.isSymbolicLink()) return undefined;
  if (expected.size > MAXIMUM_STATIC_FILE_BYTES_BIGINT) {
    throw fixtureStaticError(413, "Static file exceeds fixture limit.");
  }

  let descriptor;
  try {
    descriptor = fs.openSync(real, READ_ONLY_NO_FOLLOW);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    if (error?.code === "ELOOP") throw fixtureStaticError(403, "Static symlink escape is not allowed.");
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameStableStaticFile(opened, expected)) {
      throw fixtureStaticError(403, "Static file changed while it was being opened.");
    }
    if (opened.size > MAXIMUM_STATIC_FILE_BYTES_BIGINT) {
      throw fixtureStaticError(413, "Static file exceeds fixture limit.");
    }
    assertStaticFilePathBinding(binding, candidate, real, opened);

    const expectedSize = Number(opened.size);
    const body = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < body.byteLength) {
      const bytesRead = fs.readSync(descriptor, body, offset, body.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStableStaticFile(completed, opened) || offset !== expectedSize) {
      throw fixtureStaticError(409, "Static file changed while it was being read.");
    }
    assertStaticFilePathBinding(binding, candidate, real, completed);
    return { body, real };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function serveStaticFile(res, staticRoot, pathname) {
  if (!staticRoot) return false;
  const binding = typeof staticRoot === "string" ? createStaticRootBinding(staticRoot) : staticRoot;
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
  const root = binding.canonicalPath;
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    sendText(res, 400, "Path traversal is not allowed.");
    return true;
  }
  const staticFile = readBoundedStaticFile(binding, candidate);
  if (staticFile) {
    const contentType = MIME_TYPES[path.extname(staticFile.real)] ?? "application/octet-stream";
    sendText(res, 200, staticFile.body, contentType, {
      ...(contentType === "application/octet-stream" ? { "content-disposition": "attachment" } : {}),
    });
    return true;
  }
  if (decoded === "/" || !path.extname(decoded)) {
    const index = path.join(root, "index.html");
    const fallback = readBoundedStaticFile(binding, index);
    if (fallback) {
      sendText(res, 200, fallback.body, "text/html; charset=utf-8");
      return true;
    }
  }
  return false;
}
