/**
 * Loader for the shared, versioned geospatial-grpc conformance fixtures.
 *
 * The fixtures are the single source of truth for the canonical
 * `geospatial.v1` wire contract (see geospatial-grpc#18 / #3 / #19). They are
 * NOT vendored into this repo — CI pulls a pinned version with
 * `conformance/fetch-fixtures.sh --version <X.Y.Z>` and extracts it to a
 * directory that this loader discovers via `HONUA_CONFORMANCE_FIXTURES_DIR`.
 *
 * Each fixture is a JSON document in the protobuf-JSON shape of a
 * `geospatial.v1` message (camelCase fields, enum value names, scalar
 * wrappers like `{ "stringValue": "…" }`). The manifest maps fixture file →
 * fully-qualified message type. This module reads the request/response
 * fixtures for a workflow and exposes them as typed JS objects; the mapping
 * to the protocol-neutral `Query` / expected `Result` lives in `mapping.ts`.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

/** Env var pointing at an extracted `conformance-fixtures-<version>` dir. */
export const FIXTURES_DIR_ENV = "HONUA_CONFORMANCE_FIXTURES_DIR";

/** Env var pinning the fixture version the suite expects (defence in depth). */
export const FIXTURES_VERSION_ENV = "HONUA_CONFORMANCE_FIXTURES_VERSION";

/** The fixture version this SDK release is wired against. */
export const PINNED_FIXTURES_VERSION = "0.1.0-alpha.1";

/** A parsed manifest entry: fixture file → fully-qualified message type. */
export interface ManifestEntry {
  fixture: string;
  messageType: string;
}

/** A loaded request/response fixture pair for one workflow. */
export interface FixtureCase<Req = Record<string, unknown>, Resp = Record<string, unknown>> {
  /** Workflow id, e.g. `feature_query`. */
  id: string;
  /** Fully-qualified request message type, e.g. `geospatial.v1.QueryFeaturesRequest`. */
  requestType: string;
  /** Fully-qualified response message type. */
  responseType: string;
  /** Parsed canonical request payload (the `fixtures/` copy). */
  request: Req;
  /** Parsed canonical golden response payload (the `golden/` copy). */
  golden: Resp;
}

/**
 * Resolve the extracted-fixtures directory. Returns `undefined` when
 * `HONUA_CONFORMANCE_FIXTURES_DIR` is unset so the conformance suite can
 * degrade to an explicit no-op (mirroring the integration lane's
 * connect-only gate) instead of failing on forks / unconfigured pushes.
 */
export function tryResolveFixturesDir(): string | undefined {
  const raw = process.env[FIXTURES_DIR_ENV]?.trim();
  if (!raw) return undefined;
  const resolved = path.resolve(raw);
  if (!fs.existsSync(path.join(resolved, "fixtures"))) {
    throw new Error(
      `${FIXTURES_DIR_ENV}=${resolved} does not contain a fixtures/ directory. Run conformance/fetch-fixtures.sh --version <X.Y.Z> and point this var at the extracted dir.`,
    );
  }
  return resolved;
}

/** Throws when the fixtures dir is not configured. */
export function resolveFixturesDir(): string {
  const dir = tryResolveFixturesDir();
  if (!dir) {
    throw new Error(
      `${FIXTURES_DIR_ENV} is not set. Fetch the pinned fixtures with ` +
        `conformance/fetch-fixtures.sh --version ${PINNED_FIXTURES_VERSION} and export ${FIXTURES_DIR_ENV}.`,
    );
  }
  return dir;
}

/**
 * Read and assert the extracted bundle's `VERSION` equals the version the
 * suite is pinned to (or `HONUA_CONFORMANCE_FIXTURES_VERSION` when set). This
 * is the SDK-side analogue of `fetch-fixtures.sh`'s embedded-VERSION check: a
 * fixture set maps 1:1 to a `geospatial.v1` schema release, so running the
 * wrong bundle against a live server would silently test the wrong contract.
 */
export function assertFixturesVersion(dir: string): string {
  const expected = process.env[FIXTURES_VERSION_ENV]?.trim() || PINNED_FIXTURES_VERSION;
  const versionPath = path.join(dir, "VERSION");
  if (!fs.existsSync(versionPath)) {
    throw new Error(`Conformance bundle at ${dir} is missing VERSION; expected ${expected}.`);
  }
  const got = fs.readFileSync(versionPath, "utf8").trim();
  if (got !== expected) {
    throw new Error(
      `Conformance bundle VERSION (${got}) does not match the pinned version (${expected}). Bump conformance/fetch-fixtures.sh --version and the SDK pin together.`,
    );
  }
  return got;
}

/** Parse `fixtures/manifest.txt` into structured entries. */
export function readManifest(dir: string): ManifestEntry[] {
  const manifestPath = path.join(dir, "fixtures", "manifest.txt");
  const raw = fs.readFileSync(manifestPath, "utf8");
  const entries: ManifestEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [fixture, messageType] = trimmed.split(/\s+/, 2);
    if (!fixture || !messageType) continue;
    entries.push({ fixture, messageType });
  }
  return entries;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/**
 * Load a request/response fixture pair for `workflowId`. `workflowId` is the
 * shared prefix of the `<workflowId>_request.json` / `<workflowId>_response.json`
 * fixture files (e.g. `feature_query`). The request is read from `fixtures/`
 * (the canonical input) and the golden from `golden/` (the canonical
 * round-tripped output the live `Result` must conform to).
 */
export function loadFixtureCase<Req = Record<string, unknown>, Resp = Record<string, unknown>>(
  dir: string,
  workflowId: string,
): FixtureCase<Req, Resp> {
  const manifest = readManifest(dir);
  const reqFile = `${workflowId}_request.json`;
  const respFile = `${workflowId}_response.json`;
  const reqEntry = manifest.find((entry) => entry.fixture === reqFile);
  const respEntry = manifest.find((entry) => entry.fixture === respFile);
  if (!reqEntry || !respEntry) {
    throw new Error(
      `Workflow "${workflowId}" not found in manifest (${dir}/fixtures/manifest.txt). ` +
        `Expected entries for ${reqFile} and ${respFile}.`,
    );
  }
  return {
    id: workflowId,
    requestType: reqEntry.messageType,
    responseType: respEntry.messageType,
    request: readJson<Req>(path.join(dir, "fixtures", reqFile)),
    golden: readJson<Resp>(path.join(dir, "golden", respFile)),
  };
}
