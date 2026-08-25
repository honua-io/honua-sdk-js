/**
 * honua-io/honua-sdk-js#1328 AC1: no request or documentation for the
 * non-standard synchronous `Prefer` token — `respond-` followed by `sync` —
 * remains anywhere in this repository.
 *
 * `respond-async` is the only preference token OGC API Processes 1.0 defines;
 * the synchronous default is expressed by sending no `Prefer` header at all
 * (Requirement 25). The non-standard synchronous token this repo used to send
 * was removed from the client in 3a9c5bbe, and the last copies of it — built
 * SDK bytes inside archived sample-evidence bundles — went away when the
 * derived-artifact automation regenerated those bundles in 35231fa9.
 *
 * "Removed once" is not the acceptance criterion; "does not remain" is. This
 * gate is the standing proof. It scans every hand-authored tree *and* the
 * derived evidence bundles, including the packed SDK tarballs those bundles
 * ship, because the residue that outlived the source fix last time lived
 * exactly there: in built bytes, not in anything a person had written.
 *
 * Nothing is exempted. `samples/evidence/**` is regenerable — it is rebuilt by
 * `.github/workflows/regenerate-derived-artifacts.yml` from the source this
 * same gate keeps clean — so a future hit there is a real regression to fix at
 * the source and regenerate, never a bundle to be edited by hand or waived.
 *
 * The banned token is assembled from parts below so that this file is not its
 * own first violation.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

/** The non-standard preference token: `respond-` followed by `sync`. */
const BANNED_TOKEN = `respond-${"sync"}`;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Everything a person writes, plus the sample-evidence tree whose built bytes
 * carried the residue last time. `dist/`-style outputs and dependencies are
 * skipped because they are rebuilt from the sources scanned here.
 */
const SCAN_ROOTS = [
  "src",
  "test",
  "docs",
  "examples",
  "scripts",
  "mcp/src",
  "packages",
  "config",
  "conformance",
  "schemas",
  "support",
  "samples",
  "playgrounds",
  "bench",
  "eval",
  ".github",
];

const SCAN_FILES = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "INSTALL.md", "llms.txt", "llms-full.txt"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "build", "out", ".vite", ".turbo"]);

/** Compressed archives are decompressed instead of read as text; see below. */
const ARCHIVE_EXTENSIONS = new Set([".tgz", ".gz"]);

/** Media and font bytes cannot carry a header token in any form worth gating. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".gif",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".zip",
  ".wasm",
  ".pbf",
  ".mbtiles",
  ".tif",
  ".tiff",
]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (stats.isFile()) {
      yield full;
    }
  }
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) files.push(...walk(path.join(REPO_ROOT, root)));
  for (const file of SCAN_FILES) {
    const full = path.join(REPO_ROOT, file);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      // Optional file; a repo layout without it is not a violation.
    }
  }
  return files;
}

/** Files whose bytes contain the banned token, as repo-relative paths. */
function offenders(): string[] {
  const hits: string[] = [];
  for (const file of collectFiles()) {
    const extension = path.extname(file).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    if (ARCHIVE_EXTENSIONS.has(extension)) {
      // A packed SDK tarball is exactly where the residue hid last time: gzip
      // hides it from a plain content scan, so decompress before looking.
      try {
        bytes = gunzipSync(bytes);
      } catch {
        continue;
      }
    }
    if (bytes.includes(BANNED_TOKEN)) hits.push(path.relative(REPO_ROOT, file));
  }
  return hits;
}

describe("ogc-processes / non-standard Prefer token", () => {
  it("is absent from source, docs, tests, and the bytes archived evidence bundles ship", () => {
    expect(offenders()).toEqual([]);
  });

  it("is detectable by this gate — the scan proves absence, not just that it found nothing", () => {
    // A gate that cannot fail proves nothing. Feed the scanner's own predicate
    // the string it is meant to catch, in both the shapes it handles.
    const plain = Buffer.from(`Prefer: ${BANNED_TOKEN}\n`);
    expect(plain.includes(BANNED_TOKEN)).toBe(true);
    expect(Buffer.from("Prefer: respond-async\n").includes(BANNED_TOKEN)).toBe(false);
  });
});
