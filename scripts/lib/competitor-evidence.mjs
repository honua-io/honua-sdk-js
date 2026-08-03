/**
 * Competitor evidence loader + validator (honua-io/honua-sdk-js#499).
 *
 * Every external claim rendered on `docs/comparison.md` must come from a
 * structured record in `docs/data/competitor-evidence.v1.json`, never from
 * prose or an inline constant. This module is the gate that makes that
 * enforceable rather than aspirational:
 *
 *   - REQ-005: a record without product/package/version, a primary source URL,
 *     `observedAt`/`expiresAt`, methodology, per-metric unit + compression, or
 *     comparability notes is rejected.
 *   - REQ-006: a record describing a superseded release line is `historical`.
 *     `requireCurrentEvidence()` refuses to hand it to a current headline,
 *     ratio, or superiority claim, so the generator *cannot* emit one.
 *   - NFR-002: generation fails when a projected claim is missing evidence, has
 *     expired, cites a non-primary source, or combines metrics whose unit or
 *     compression differ without an explicit caveat.
 *
 * Structural validation is JSON Schema (`schemas/competitor-evidence.v1.json`);
 * the rules a schema cannot express are applied on top of it here.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");

export const EVIDENCE_FORMAT = "honua.sdk.competitor-evidence.v1";
export const EVIDENCE_RELATIVE_PATH = path.join("docs", "data", "competitor-evidence.v1.json");
export const EVIDENCE_SCHEMA_RELATIVE_PATH = path.join("schemas", "competitor-evidence.v1.json");

/**
 * Trusted primary-source origins, keyed by the exact package a record claims to
 * describe. This lives in CODE, not in the evidence file, on purpose: if a
 * record could declare its own allowed origins, the primary-source rule would
 * be self-certifying and a blog restating a vendor number could whitelist
 * itself. A record naming a package that is absent here cannot be projected at
 * all, so adding a new competitor is a reviewed change to this list.
 */
export const TRUSTED_PRIMARY_SOURCE_PREFIXES = Object.freeze({
  "@arcgis/core": Object.freeze([
    "https://github.com/Esri/",
    "https://developers.arcgis.com/",
    "https://registry.npmjs.org/@arcgis/core",
    "https://www.npmjs.com/package/@arcgis/core",
  ]),
  "@esri/arcgis-rest-request": Object.freeze([
    "https://github.com/Esri/",
    "https://developers.arcgis.com/",
    "https://registry.npmjs.org/@esri/arcgis-rest-request",
    "https://www.npmjs.com/package/@esri/arcgis-rest-request",
  ]),
  ol: Object.freeze([
    "https://openlayers.org/",
    "https://github.com/openlayers/",
    "https://registry.npmjs.org/ol",
    "https://www.npmjs.com/package/ol",
  ]),
  "maplibre-gl": Object.freeze([
    "https://maplibre.org/",
    "https://github.com/maplibre/",
    "https://registry.npmjs.org/maplibre-gl",
    "https://www.npmjs.com/package/maplibre-gl",
  ]),
});

/** Operation axis rendered by the comparison page (#499 REQ-003). */
export const OPERATION_KEYS = Object.freeze([
  "discovery",
  "paging",
  "edits",
  "crs",
  "capabilityNegotiation",
  "planning",
  "rendering",
  "lifecycle",
]);

/** Thrown for every evidence-contract violation so callers can distinguish it from an I/O error. */
export class CompetitorEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompetitorEvidenceError";
  }
}

const fail = (message) => {
  throw new CompetitorEvidenceError(
    `${message}\n  → fix docs/data/competitor-evidence.v1.json (see docs/comparison.md "Evidence contract").`,
  );
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value, field, recordId) {
  if (!DATE_PATTERN.test(value)) fail(`evidence record "${recordId}": ${field} must be an ISO YYYY-MM-DD date (got ${JSON.stringify(value)})`);
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) fail(`evidence record "${recordId}": ${field} is not a real calendar date (${value})`);
  return parsed;
}

/** Resolve the validation instant. Callers pass one explicitly so tests are deterministic. */
function resolveNow(now) {
  if (now === undefined) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  if (typeof now === "string") {
    const parsed = Date.parse(DATE_PATTERN.test(now) ? `${now}T00:00:00Z` : now);
    if (Number.isNaN(parsed)) throw new TypeError(`unparseable validation instant: ${now}`);
    return parsed;
  }
  throw new TypeError(`unsupported validation instant: ${String(now)}`);
}

export function loadEvidenceSchema(rootDir = DEFAULT_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, EVIDENCE_SCHEMA_RELATIVE_PATH), "utf8"));
}

/**
 * Validate an evidence document. Returns `{ records, byId, categories }`.
 * Throws `CompetitorEvidenceError` on the first violation.
 */
export function validateCompetitorEvidence(document, { now, schema, rootDir = DEFAULT_ROOT } = {}) {
  const instant = resolveNow(now);
  const evidenceSchema = schema ?? loadEvidenceSchema(rootDir);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(evidenceSchema);
  if (!validate(document)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    fail(`competitor evidence failed schema validation: ${detail}`);
  }

  if (document.format !== EVIDENCE_FORMAT) {
    fail(`competitor evidence format must be ${EVIDENCE_FORMAT} (got ${document.format})`);
  }

  const byId = new Map();
  for (const record of document.records) {
    if (byId.has(record.id)) fail(`duplicate evidence record id "${record.id}"`);

    if (!document.categories[record.category]) {
      fail(`evidence record "${record.id}": unknown category "${record.category}" — declare it in the document's categories block (REQ-002)`);
    }

    // REQ-005: primary-source enforcement, against the TRUSTED list in this
    // module rather than anything the record itself declares.
    if (record.sourceType !== "primary") {
      fail(`evidence record "${record.id}": sourceType is "${record.sourceType}" — only primary sources may be projected (REQ-005)`);
    }
    const trusted = TRUSTED_PRIMARY_SOURCE_PREFIXES[record.package];
    if (!trusted) {
      fail(
        `evidence record "${record.id}": package "${record.package}" has no trusted primary-source origins — ` +
          `add them to TRUSTED_PRIMARY_SOURCE_PREFIXES in scripts/lib/competitor-evidence.mjs (a reviewed code change), ` +
          `so evidence cannot whitelist its own source (REQ-005)`,
      );
    }
    if (!trusted.some((prefix) => record.sourceUrl.startsWith(prefix))) {
      fail(
        `evidence record "${record.id}": sourceUrl ${record.sourceUrl} is not under a trusted primary-source origin for ` +
          `${record.package} (${trusted.join(", ")}) — a restatement of a vendor claim is not primary evidence (REQ-005)`,
      );
    }

    const observedAt = parseDate(record.observedAt, "observedAt", record.id);
    const retrievedAt = parseDate(record.retrievedAt, "retrievedAt", record.id);
    const expiresAt = parseDate(record.expiresAt, "expiresAt", record.id);
    if (retrievedAt < observedAt) {
      fail(`evidence record "${record.id}": retrievedAt (${record.retrievedAt}) precedes observedAt (${record.observedAt})`);
    }
    if (expiresAt <= observedAt) {
      fail(`evidence record "${record.id}": expiresAt (${record.expiresAt}) must be after observedAt (${record.observedAt})`);
    }

    // NFR-002 freshness is deliberately NOT enforced here. Records are
    // immutable per observation, so an archived observation is *expected* to
    // age past its expiry and must be allowed to stay in the file — otherwise
    // the documented recovery ("add a new observation, never rewrite the old
    // one") could never work and the whole document would be permanently
    // rejected. Freshness is enforced where the requirement actually places it:
    // on the record a page PROJECTS. See requireFreshEvidence().
    record.expired = expiresAt < instant;

    if (record.historical && !record.historicalReason) {
      fail(`evidence record "${record.id}": historical records must explain why the release line is superseded (REQ-006)`);
    }
    if (record.supersededBy && !document.records.some((other) => other.id === record.supersededBy)) {
      fail(`evidence record "${record.id}": supersededBy references unknown record "${record.supersededBy}"`);
    }

    byId.set(record.id, record);
  }

  return { records: document.records, byId, categories: document.categories, now: instant };
}

export function loadCompetitorEvidence({ rootDir = DEFAULT_ROOT, now } = {}) {
  const file = path.join(rootDir, EVIDENCE_RELATIVE_PATH);
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  return validateCompetitorEvidence(document, { now, rootDir });
}

/**
 * NFR-002 freshness gate, applied at the moment a record is projected onto the
 * page. Archived observations may sit expired in the evidence file forever;
 * what CI refuses is *publishing* one.
 */
export function requireFreshEvidence(record, { context = "projected claim" } = {}) {
  if (!record) fail(`a ${context} was requested with no evidence record (NFR-002)`);
  if (record.expired) {
    fail(
      `evidence record "${record.id}" expired on ${record.expiresAt} and cannot back a ${context} — ` +
        `re-observe the claim from ${record.sourceUrl}, ADD a new record (records are immutable per observation), ` +
        `and point the generator at the new id. Leave this record in place as archived provenance (NFR-002)`,
    );
  }
  return record;
}

/**
 * Fetch a record by id and enforce freshness in one step. The generator uses
 * this for every external figure it renders, so an unprojected/archived record
 * is never freshness-checked and a projected one always is.
 */
export function projectEvidence(evidence, id, { context } = {}) {
  const record = evidence.byId.get(id);
  if (!record) fail(`docs/data/competitor-evidence.v1.json is missing required record "${id}"`);
  return requireFreshEvidence(record, { context: context ?? `projection of "${id}"` });
}

/**
 * Read a competitor's operation-level cell from its evidence record, so a
 * published behaviour claim is bound to that product's version, primary source
 * and expiry rather than living as an inline constant in the generator
 * (#499 REQ-003/REQ-005).
 */
export function operationCell(record, operationKey) {
  if (!OPERATION_KEYS.includes(operationKey)) {
    throw new TypeError(`unknown operation key: ${operationKey}`);
  }
  const cell = record.operations?.[operationKey];
  if (!cell) {
    fail(
      `evidence record "${record.id}" does not state operation "${operationKey}", but the comparison page renders that row — ` +
        `add it to the record (with the product version and source it was read from) or stop rendering the row (REQ-003)`,
    );
  }
  return cell.note ? `${cell.support} ${cell.note}` : cell.support;
}

/**
 * REQ-006 gate. Returns the record only when it may back a *current* claim —
 * a headline, ratio, or superiority statement about products as they ship
 * today. A historical observation is refused at generation time, which is why
 * the generated page cannot contain "N× smaller than <old version>" phrasing.
 */
export function requireCurrentEvidence(record, { claimKind = "current headline" } = {}) {
  if (!record) fail(`a ${claimKind} was requested with no evidence record (NFR-002)`);
  if (record.historical) {
    fail(
      `evidence record "${record.id}" is historical (${record.product} ${record.versionLine}, observed ${record.observedAt}) ` +
        `and may not support a ${claimKind}. REQ-006 requires the same committed harness to measure the CURRENT products ` +
        `under equivalent workloads and units before any such claim is rendered.`,
    );
  }
  return record;
}

/**
 * NFR-002 gate for metric arithmetic. Two figures may only be combined or
 * ranked when their unit AND compression agree; anything else needs an
 * explicit caveat that is rendered alongside the number.
 */
export function assertComparableMetrics(metrics, { caveat, context = "comparison" } = {}) {
  if (!Array.isArray(metrics) || metrics.length < 2) {
    throw new TypeError("assertComparableMetrics expects at least two metrics");
  }
  const units = new Set(metrics.map((metric) => metric.unit));
  const compressions = new Set(metrics.map((metric) => metric.compression));
  if (units.size > 1 || compressions.size > 1) {
    if (!caveat || caveat.trim().length === 0) {
      fail(
        `${context}: refusing to combine non-comparable metrics ` +
          `(units: ${[...units].join(", ")}; compression: ${[...compressions].join(", ")}) without an explicit caveat (NFR-002)`,
      );
    }
    return { comparable: false, caveat };
  }
  return { comparable: true, caveat: undefined };
}

/** Render the provenance footer shared by every projected external claim. */
export function formatProvenance(record) {
  const historical = record.historical ? "**Historical evidence.** " : "";
  return (
    `${historical}${record.product} \`${record.package}\` ${record.versionLine} · ` +
    `observed ${record.observedAt}, retrieved ${record.retrievedAt}, expires ${record.expiresAt} · ` +
    `primary source: <${record.sourceUrl}>`
  );
}
