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

    // REQ-005: primary-source enforcement. A vendor number restated by a blog
    // or an aggregator is not admissible, so the URL must sit under one of the
    // product's own declared official prefixes.
    if (record.sourceType !== "primary") {
      fail(`evidence record "${record.id}": sourceType is "${record.sourceType}" — only primary sources may be projected (REQ-005)`);
    }
    const primary = record.primarySourcePrefixes.some((prefix) => record.sourceUrl.startsWith(prefix));
    if (!primary) {
      fail(
        `evidence record "${record.id}": sourceUrl ${record.sourceUrl} is not under a declared primary-source prefix ` +
          `(${record.primarySourcePrefixes.join(", ")}) — a restatement of a vendor claim is not primary evidence (REQ-005)`,
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

    // NFR-002: freshness. An expired claim fails generation rather than
    // silently ageing on a published page.
    if (expiresAt < instant) {
      fail(
        `evidence record "${record.id}" expired on ${record.expiresAt} — re-observe the claim from ${record.sourceUrl} ` +
          `and ADD a new record (immutable per observation); do not edit this one's provenance (NFR-002)`,
      );
    }

    if (record.historical && !record.historicalReason) {
      fail(`evidence record "${record.id}": historical records must explain why the release line is superseded (REQ-006)`);
    }
    if (record.supersededBy && !document.records.some((other) => other.id === record.supersededBy)) {
      fail(`evidence record "${record.id}": supersededBy references unknown record "${record.supersededBy}"`);
    }

    byId.set(record.id, record);
  }

  return { records: document.records, byId, categories: document.categories };
}

export function loadCompetitorEvidence({ rootDir = DEFAULT_ROOT, now } = {}) {
  const file = path.join(rootDir, EVIDENCE_RELATIVE_PATH);
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  return validateCompetitorEvidence(document, { now, rootDir });
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
