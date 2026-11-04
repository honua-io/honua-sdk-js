import fs from "node:fs";
import path from "node:path";

import { trimTrailingCharsIn } from "../core/path-utils.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/**
 * ArcGIS REST service kinds recognized when scanning sample source text for
 * service URLs (e.g. `.../arcgis/rest/services/Folder/Svc/FeatureServer/0`).
 */
const ARCGIS_SERVICE_KINDS_LOWER = [
  "featureserver",
  "mapserver",
  "imageserver",
  "vectortileserver",
  "geometryserver",
  "gpserver",
  "geocodeserver",
  "routeserver",
  "naserver",
];

const ARCGIS_ANCHOR = "/arcgis/rest/services/";

// Single-character whitespace test, applied one code unit at a time below —
// this is O(1) per character, not a scan over the whole (attacker-influenced)
// source string, so it carries none of the polynomial-matching risk that
// motivated replacing the original combined regex.
const WHITESPACE_RE = /\s/;

/**
 * Whitespace and delimiter characters that terminate a bare URL scanned out
 * of free-form sample source text (mirrors the `[^\s"'`<>)]` character class
 * previously used in a regex-based extractor).
 */
function isForbiddenUrlChar(code: number): boolean {
  switch (code) {
    case 34: // "
    case 39: // '
    case 96: // `
    case 60: // <
    case 62: // >
    case 41: // )
      return true;
    default:
      return WHITESPACE_RE.test(String.fromCharCode(code));
  }
}

function isPathSegmentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 45 // -
  );
}

function isDigitChar(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Consume the optional `/segment`, `/digits`, and `?query` suffix that may
 * follow an ArcGIS service-kind keyword, returning the index immediately
 * after the last consumed character.
 */
function consumeOptionalServiceSuffix(source: string, start: number): number {
  let pos = start;

  if (pos < source.length && source.charCodeAt(pos) === 47 /* '/' */) {
    let end = pos + 1;
    while (end < source.length && isPathSegmentChar(source.charCodeAt(end))) {
      end += 1;
    }
    if (end > pos + 1) {
      pos = end;
    }
  }

  if (pos < source.length && source.charCodeAt(pos) === 47 /* '/' */) {
    let end = pos + 1;
    while (end < source.length && isDigitChar(source.charCodeAt(end))) {
      end += 1;
    }
    if (end > pos + 1) {
      pos = end;
    }
  }

  if (pos < source.length && source.charCodeAt(pos) === 63 /* '?' */) {
    let end = pos + 1;
    while (end < source.length && !isForbiddenUrlChar(source.charCodeAt(end))) {
      end += 1;
    }
    if (end > pos + 1) {
      pos = end;
    }
  }

  return pos;
}

/**
 * Starting at `anchorIndex` (the position of a `/arcgis/rest/services/`
 * anchor already matched by the caller), attempt to consume a full service
 * path + kind keyword. Returns `matchEnd: -1` when no kind keyword is found,
 * along with `deadEnd`: the furthest index scanned, so the caller can skip
 * straight past it instead of re-scanning the same span for the next
 * candidate anchor (this bound is what keeps the overall scan linear).
 */
function tryConsumeServiceMatch(
  source: string,
  lower: string,
  anchorIndex: number,
): { matchEnd: number; deadEnd: number } {
  const pos = anchorIndex + ARCGIS_ANCHOR.length;
  if (pos >= source.length || isForbiddenUrlChar(source.charCodeAt(pos))) {
    return { matchEnd: -1, deadEnd: pos };
  }

  let cursor = pos + 1;
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    if (isForbiddenUrlChar(code)) {
      return { matchEnd: -1, deadEnd: cursor };
    }
    if (code === 47 /* '/' */) {
      for (const kindLower of ARCGIS_SERVICE_KINDS_LOWER) {
        if (lower.startsWith(kindLower, cursor + 1)) {
          const kindEnd = cursor + 1 + kindLower.length;
          return { matchEnd: consumeOptionalServiceSuffix(source, kindEnd), deadEnd: kindEnd };
        }
      }
    }
    cursor += 1;
  }
  return { matchEnd: -1, deadEnd: cursor };
}

/**
 * Linear-time replacement for a regex that combined two adjacent unbounded
 * `[^...]` quantifiers around a literal anchor (`.../arcgis/rest/services/`)
 * — a shape CodeQL flags as `js/polynomial-redos` because a regex engine can
 * be forced into O(n^2) work re-trying the match at every position of an
 * adversarial input (e.g. many repetitions of the anchor with no service
 * kind ever following). This scan makes a single forward pass over `source`,
 * bounding every backtrack-shaped decision (finding the URL's scheme, and
 * finding the service-kind keyword) to a span that is never re-visited by a
 * later iteration, so total work is O(source.length) regardless of input
 * shape.
 */
export function findArcGisServiceUrls(source: string): string[] {
  const lower = source.toLowerCase();
  const n = source.length;
  const matches: string[] = [];

  let schemeStart = -1;
  let i = 0;
  while (i < n) {
    const code = source.charCodeAt(i);
    if (isForbiddenUrlChar(code)) {
      schemeStart = -1;
      i += 1;
      continue;
    }

    if (schemeStart === -1 && (lower.startsWith("https://", i) || lower.startsWith("http://", i))) {
      schemeStart = i;
    }

    if (schemeStart !== -1 && lower.startsWith(ARCGIS_ANCHOR, i)) {
      const result = tryConsumeServiceMatch(source, lower, i);
      if (result.matchEnd !== -1) {
        matches.push(source.slice(schemeStart, result.matchEnd));
        i = result.matchEnd;
        schemeStart = -1;
        continue;
      }
      i = result.deadEnd;
      continue;
    }

    i += 1;
  }

  return matches;
}

const PORTAL_ITEM_OBJECT_REGEX =
  /\bportalItem\s*:\s*\{[\s\S]{0,320}?\bid\s*:\s*["']([A-Za-z0-9_-]{6,})["'][\s\S]{0,320}?\}/g;
const PORTAL_ITEM_ID_REGEX = /\b(?:itemId|portalItemId)\s*:\s*["']([A-Za-z0-9_-]{6,})["']/g;
const API_KEY_REGEX = /\b(?:apiKey|api_key)\b/i;
const OAUTH_REGEX = /\b(?:OAuthInfo|IdentityManager|registerToken|checkSignInStatus|getCredential)\b/i;
const PREMIUM_REGEX = /\b(?:Directions|RouteLayer|RouteTask|ClosestFacility|ServiceArea|UtilityNetwork)\b/i;

export type MigrationSampleCorpusSchemaVersion = "honua.esri-sample-corpus.v1";

export type MigrationSampleCorpusLane = "pr-fixture" | "manual-live" | "scheduled-live";

export type MigrationSampleStatus = "ci-fixture" | "live-evidence" | "skipped";

export type MigrationSampleSkipReason =
  | "requires-api-key"
  | "requires-oauth"
  | "premium-service"
  | "private-content"
  | "unclear-content-terms"
  | "unsupported-sample-family";

export type SourceApiServiceKind =
  | "FeatureServer"
  | "MapServer"
  | "ImageServer"
  | "VectorTileServer"
  | "GeometryServer"
  | "GPServer"
  | "GeocodeServer"
  | "RouteServer"
  | "NAServer"
  | "unknown";

export interface MigrationSampleCorpusManifest {
  schemaVersion: MigrationSampleCorpusSchemaVersion;
  generatedBy: "honua";
  guardrails: MigrationSampleCorpusGuardrails;
  samples: MigrationSample[];
}

export interface MigrationSampleCorpusGuardrails {
  noVendoredEsriSampleCode: boolean;
  noCommittedEsriServiceData: boolean;
  prCiUsesFixtureOnly: boolean;
  liveRunsRequireOptIn: boolean;
  liveRunLanes: MigrationSampleCorpusLane[];
  notes: string[];
}

export interface MigrationSample {
  id: string;
  title: string;
  source: MigrationSampleSourceReference;
  fixture: MigrationSampleFixtureReference;
  status: MigrationSampleStatus;
  license: MigrationSampleLicenseMetadata;
  terms: MigrationSampleTermsMetadata;
  skipReasons?: MigrationSampleSkipReason[];
  expected?: MigrationSampleExpectedReferences;
}

export interface MigrationSampleSourceReference {
  url: string;
  sampleCodePath?: string;
  referenceOnly: boolean;
  retrievedAt?: string;
}

export interface MigrationSampleFixtureReference {
  root: string;
  entrypoints: string[];
  ownership: "honua";
  description: string;
}

export interface MigrationSampleLicenseMetadata {
  label: string;
  url: string;
  notice: string;
}

export interface MigrationSampleTermsMetadata {
  sampleCode: string;
  serviceContent: string;
  liveEvidence: string;
}

export interface MigrationSampleExpectedReferences {
  serviceKinds?: SourceApiServiceKind[];
  portalItemIds?: string[];
  guardrailFlags?: MigrationSampleGuardrailFlag[];
}

export interface SourceApiServiceReference {
  url: string;
  normalizedUrl: string;
  kind: SourceApiServiceKind;
  servicePath?: string;
  layerId?: number;
}

export interface PortalItemReference {
  id: string;
}

export type MigrationSampleGuardrailFlag =
  | "api-key-reference"
  | "oauth-reference"
  | "premium-service-reference"
  | "external-live-service-reference";

export interface MigrationSampleReferenceExtraction {
  serviceUrls: SourceApiServiceReference[];
  portalItems: PortalItemReference[];
  guardrailFlags: MigrationSampleGuardrailFlag[];
}

export interface MigrationSampleFixtureAnalysis extends MigrationSampleReferenceExtraction {
  sampleId: string;
  filesScanned: number;
  status: MigrationSampleStatus;
  skipReasons: MigrationSampleSkipReason[];
}

export interface MigrationSampleCorpusSummary {
  sampleCount: number;
  fixtureCiCount: number;
  liveEvidenceCount: number;
  skippedCount: number;
  guardrailFailures: string[];
}

export function loadEsriSampleCorpusManifest(manifestPath: string): MigrationSampleCorpusManifest {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  return parseEsriSampleCorpusManifest(parsed, manifestPath);
}

export function parseEsriSampleCorpusManifest(value: unknown, sourceName = "manifest"): MigrationSampleCorpusManifest {
  const record = expectRecord(value, sourceName);
  if (record.schemaVersion !== "honua.esri-sample-corpus.v1") {
    throw new Error(`${sourceName} must use schemaVersion honua.esri-sample-corpus.v1.`);
  }
  if (record.generatedBy !== "honua") {
    throw new Error(`${sourceName} must be generatedBy honua.`);
  }

  const guardrails = expectRecord(
    record.guardrails,
    `${sourceName}.guardrails`,
  ) as unknown as MigrationSampleCorpusGuardrails;
  const samples = expectArray(record.samples, `${sourceName}.samples`).map((sample, index) =>
    parseSample(sample, `${sourceName}.samples[${index}]`),
  );

  return {
    schemaVersion: "honua.esri-sample-corpus.v1",
    generatedBy: "honua",
    guardrails: {
      noVendoredEsriSampleCode: expectBoolean(
        guardrails.noVendoredEsriSampleCode,
        `${sourceName}.guardrails.noVendoredEsriSampleCode`,
      ),
      noCommittedEsriServiceData: expectBoolean(
        guardrails.noCommittedEsriServiceData,
        `${sourceName}.guardrails.noCommittedEsriServiceData`,
      ),
      prCiUsesFixtureOnly: expectBoolean(
        guardrails.prCiUsesFixtureOnly,
        `${sourceName}.guardrails.prCiUsesFixtureOnly`,
      ),
      liveRunsRequireOptIn: expectBoolean(
        guardrails.liveRunsRequireOptIn,
        `${sourceName}.guardrails.liveRunsRequireOptIn`,
      ),
      liveRunLanes: expectStringArray(
        guardrails.liveRunLanes,
        `${sourceName}.guardrails.liveRunLanes`,
      ) as MigrationSampleCorpusLane[],
      notes: expectStringArray(guardrails.notes, `${sourceName}.guardrails.notes`),
    },
    samples,
  };
}

export function summarizeEsriSampleCorpus(manifest: MigrationSampleCorpusManifest): MigrationSampleCorpusSummary {
  const guardrailFailures: string[] = [];
  if (!manifest.guardrails.noVendoredEsriSampleCode) {
    guardrailFailures.push("guardrails.noVendoredEsriSampleCode must remain true");
  }
  if (!manifest.guardrails.noCommittedEsriServiceData) {
    guardrailFailures.push("guardrails.noCommittedEsriServiceData must remain true");
  }
  if (!manifest.guardrails.prCiUsesFixtureOnly) {
    guardrailFailures.push("guardrails.prCiUsesFixtureOnly must remain true");
  }
  if (!manifest.guardrails.liveRunsRequireOptIn) {
    guardrailFailures.push("guardrails.liveRunsRequireOptIn must remain true");
  }

  for (const sample of manifest.samples) {
    if (!sample.source.referenceOnly) {
      guardrailFailures.push(`${sample.id}: source.referenceOnly must remain true`);
    }
    if (sample.fixture.ownership !== "honua") {
      guardrailFailures.push(`${sample.id}: fixture.ownership must be honua`);
    }
    if (sample.status === "skipped" && (!sample.skipReasons || sample.skipReasons.length === 0)) {
      guardrailFailures.push(`${sample.id}: skipped samples must record skipReasons`);
    }
  }

  return {
    sampleCount: manifest.samples.length,
    fixtureCiCount: manifest.samples.filter((sample) => sample.status === "ci-fixture").length,
    liveEvidenceCount: manifest.samples.filter((sample) => sample.status === "live-evidence").length,
    skippedCount: manifest.samples.filter((sample) => sample.status === "skipped").length,
    guardrailFailures,
  };
}

export function analyzeEsriSampleFixture(
  sample: MigrationSample,
  options: { manifestDir: string },
): MigrationSampleFixtureAnalysis {
  const fixtureRoot = path.resolve(options.manifestDir, sample.fixture.root);
  const entrypointFiles = sample.fixture.entrypoints.map((entrypoint) => path.resolve(fixtureRoot, entrypoint));
  const files = entrypointFiles.length > 0 ? entrypointFiles : collectSourceFiles(fixtureRoot);
  const combined: MigrationSampleReferenceExtraction = {
    serviceUrls: [],
    portalItems: [],
    guardrailFlags: [],
  };

  for (const file of files) {
    const extraction = extractEsriSampleReferences(fs.readFileSync(file, "utf8"));
    combined.serviceUrls.push(...extraction.serviceUrls);
    combined.portalItems.push(...extraction.portalItems);
    combined.guardrailFlags.push(...extraction.guardrailFlags);
  }

  const serviceUrls = uniqueBy(combined.serviceUrls, (item) => item.normalizedUrl);
  const portalItems = uniqueBy(combined.portalItems, (item) => item.id);
  const guardrailFlags = Array.from(new Set(combined.guardrailFlags)).sort();

  return {
    sampleId: sample.id,
    filesScanned: files.length,
    status: sample.status,
    skipReasons: sample.skipReasons ?? [],
    serviceUrls,
    portalItems,
    guardrailFlags,
  };
}

export function extractEsriSampleReferences(source: string): MigrationSampleReferenceExtraction {
  const serviceUrls: SourceApiServiceReference[] = [];
  const portalItems: PortalItemReference[] = [];
  const guardrailFlags = new Set<MigrationSampleGuardrailFlag>();

  for (const rawUrl of findArcGisServiceUrls(source)) {
    const service = classifyServiceUrl(rawUrl);
    serviceUrls.push(service);
    if (service.normalizedUrl.startsWith("http://") || service.normalizedUrl.startsWith("https://")) {
      guardrailFlags.add("external-live-service-reference");
    }
    if (service.kind === "RouteServer" || service.kind === "NAServer") {
      guardrailFlags.add("premium-service-reference");
    }
  }

  for (const match of source.matchAll(PORTAL_ITEM_OBJECT_REGEX)) {
    portalItems.push({ id: match[1] });
  }
  for (const match of source.matchAll(PORTAL_ITEM_ID_REGEX)) {
    portalItems.push({ id: match[1] });
  }

  if (API_KEY_REGEX.test(source)) {
    guardrailFlags.add("api-key-reference");
  }
  if (OAUTH_REGEX.test(source)) {
    guardrailFlags.add("oauth-reference");
  }
  if (PREMIUM_REGEX.test(source)) {
    guardrailFlags.add("premium-service-reference");
  }

  return {
    serviceUrls: uniqueBy(serviceUrls, (item) => item.normalizedUrl),
    portalItems: uniqueBy(portalItems, (item) => item.id),
    guardrailFlags: Array.from(guardrailFlags).sort(),
  };
}

export function classifyServiceUrl(url: string): SourceApiServiceReference {
  const cleanedUrl = trimTrailingCharsIn(url, "),.;]");
  const parsed = new URL(cleanedUrl);
  parsed.search = "";
  parsed.hash = "";
  const normalizedUrl = parsed.toString().replace(/\/$/, "");
  const serviceMatch = normalizedUrl.match(
    /\/arcgis\/rest\/services\/(.+?)\/(FeatureServer|MapServer|ImageServer|VectorTileServer|GeometryServer|GPServer|GeocodeServer|RouteServer|NAServer)(?:\/([A-Za-z0-9_-]+))?(?:\/(\d+))?$/i,
  );

  if (!serviceMatch) {
    return {
      url: cleanedUrl,
      normalizedUrl,
      kind: "unknown",
    };
  }

  const kind = serviceMatch[2] as SourceApiServiceKind;
  // For NAServer, the third capture is the network-analyst sub-service name
  // (e.g., Route_World, ClosestFacility_World) — fold it into servicePath so
  // downstream consumers see it. For other kinds it's the numeric layer id.
  let servicePath = serviceMatch[1];
  let layerToken: string | undefined;
  if (kind === "NAServer") {
    if (serviceMatch[3]) {
      servicePath = `${servicePath}/NAServer/${serviceMatch[3]}`;
    }
    layerToken = serviceMatch[4];
  } else {
    layerToken = serviceMatch[3] ?? serviceMatch[4];
  }
  const layerId = layerToken === undefined ? undefined : Number.parseInt(layerToken, 10);
  return {
    url: cleanedUrl,
    normalizedUrl,
    kind,
    servicePath,
    layerId: Number.isFinite(layerId) ? layerId : undefined,
  };
}

function parseSample(value: unknown, sourceName: string): MigrationSample {
  const record = expectRecord(value, sourceName);
  const status = expectString(record.status, `${sourceName}.status`) as MigrationSampleStatus;
  const skipReasons =
    record.skipReasons === undefined
      ? undefined
      : (expectStringArray(record.skipReasons, `${sourceName}.skipReasons`) as MigrationSampleSkipReason[]);

  return {
    id: expectString(record.id, `${sourceName}.id`),
    title: expectString(record.title, `${sourceName}.title`),
    source: expectRecord(record.source, `${sourceName}.source`) as unknown as MigrationSampleSourceReference,
    fixture: expectRecord(record.fixture, `${sourceName}.fixture`) as unknown as MigrationSampleFixtureReference,
    status,
    license: expectRecord(record.license, `${sourceName}.license`) as unknown as MigrationSampleLicenseMetadata,
    terms: expectRecord(record.terms, `${sourceName}.terms`) as unknown as MigrationSampleTermsMetadata,
    skipReasons,
    expected: record.expected as MigrationSampleExpectedReferences | undefined,
  };
}

function collectSourceFiles(rootDir: string): string[] {
  const queue = [rootDir];
  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        result.push(fullPath);
      }
    }
  }
  return result.sort();
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function expectRecord(value: unknown, sourceName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, sourceName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${sourceName} must be an array.`);
  }
  return value;
}

function expectString(value: unknown, sourceName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${sourceName} must be a non-empty string.`);
  }
  return value;
}

function expectBoolean(value: unknown, sourceName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${sourceName} must be a boolean.`);
  }
  return value;
}

function expectStringArray(value: unknown, sourceName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${sourceName} must be an array of non-empty strings.`);
  }
  return value as string[];
}
