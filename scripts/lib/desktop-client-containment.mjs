import { createHash } from "node:crypto";

// An ending boundary keeps each product token whole. Without it, "pro" matches
// the prefix of provider, property, and provenance.
const TERM_PATTERNS = Object.freeze([
  new RegExp(["arc", "py"].join(""), "i"),
  new RegExp(["arcgis", " pro", "\\b"].join(""), "i"),
  new RegExp(["arcgis", "pro", "\\b"].join(""), "i"),
  new RegExp(["arcgis", "-pro", "\\b"].join(""), "i"),
  new RegExp(["\\.", "aprx"].join(""), "i"),
  new RegExp(["\\.", "atbx"].join(""), "i"),
]);

// Line-exact SHA-256 allowlist for nominative desktop-client references.
export const ALLOWED_LINE_HASHES = new Map([
  [
    "src/control-plane/generated/admin-api.ts",
    new Set([
      // Generated publishCogArtifact OpenAPI description.
      "39d878e2c24b68c0acdb7e1c32d5e0aecea337115014253ef8d7995233b3cbeb",
    ]),
  ],
]);

function lineHash(line) {
  return createHash("sha256").update(line).digest("hex");
}

export function inspectDesktopClientContainment(files, { allowedLineHashes = ALLOWED_LINE_HASHES } = {}) {
  const unexpected = [];
  const observedAllowed = new Map();
  const seen = new Set();

  const record = (path, line) => {
    const key = `${path}\0${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    unexpected.push({ path, line });
  };

  for (const { path, content } of files) {
    // The artifact name is the finding for a project or toolbox file. Binary
    // content often contains NUL and is not line-scanned, so the path is checked first.
    if (TERM_PATTERNS.some((pattern) => pattern.test(path))) record(path, 1);
    if (content.includes("\0")) continue;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!TERM_PATTERNS.some((pattern) => pattern.test(line))) continue;
      const hash = lineHash(line);
      if (allowedLineHashes.get(path)?.has(hash)) {
        if (!observedAllowed.has(path)) observedAllowed.set(path, new Set());
        observedAllowed.get(path).add(hash);
      } else {
        record(path, index + 1);
      }
    }
  }

  const missing = [];
  for (const [path, hashes] of allowedLineHashes) {
    for (const hash of hashes) {
      if (!observedAllowed.get(path)?.has(hash)) missing.push({ path, hash });
    }
  }
  return { missing, unexpected };
}
