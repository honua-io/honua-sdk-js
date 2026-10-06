import { createHash } from "node:crypto";

const TERM_PATTERNS = Object.freeze([
  new RegExp(["arc", "py"].join(""), "i"),
  new RegExp(["arcgis", " pro"].join(""), "i"),
  new RegExp(["arcgis", "pro"].join(""), "i"),
  new RegExp(["arcgis", "-pro"].join(""), "i"),
  new RegExp(["\\.", "aprx"].join(""), "i"),
  new RegExp(["\\.", "atbx"].join(""), "i"),
]);

// R30 permits these five nominative references. Hashing the complete line keeps
// the exception narrow: adding procedural detail to an allowed line still fails.
const ALLOWED_LINE_HASHES = new Map([
  ["bundle-budgets.json", new Set(["84e9a59b2e58ae9c60adaa2f8de2eb1bb947d05c7eb0ce9cba63c5064d417481"])],
  ["src/migration/oss-corpus.ts", new Set([
    "ea0069448974a085c14648f409cfde3a71b2b00d225752159e394eb522af4ae8",
    "008a3cbc15b003061ca0bad662d87b2642c83af1f4b94e1be63e1bcde5db2483",
  ])],
  ["test/feature-filter-compat.test.ts", new Set(["fe5d1e2efc2c171effa2337740fc28c1bf76c159762765de0abdefddb68b569f"])],
  ["test/playwright/cesium-scene-adapter-fixture.mjs", new Set([
    "a0fa83386baac527fd0689a7436ff670b9b09d48422118fe423cbd950ed9ebfa",
  ])],
]);

function lineHash(line) {
  return createHash("sha256").update(line).digest("hex");
}

export function inspectDesktopClientContainment(files) {
  const unexpected = [];
  const observedAllowed = new Map();

  for (const { path, content } of files) {
    if (content.includes("\0")) continue;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!TERM_PATTERNS.some((pattern) => pattern.test(line))) continue;
      const hash = lineHash(line);
      if (ALLOWED_LINE_HASHES.get(path)?.has(hash)) {
        if (!observedAllowed.has(path)) observedAllowed.set(path, new Set());
        observedAllowed.get(path).add(hash);
      } else {
        unexpected.push({ path, line: index + 1 });
      }
    }
  }

  const missing = [];
  for (const [path, hashes] of ALLOWED_LINE_HASHES) {
    for (const hash of hashes) {
      if (!observedAllowed.get(path)?.has(hash)) missing.push({ path, hash });
    }
  }
  return { missing, unexpected };
}
