/**
 * npm registry search observations (honua-io/honua-sdk-js#499, REQ-004).
 *
 * REQ-004 does not stop at "declare good keywords" — it requires the keywords
 * be *verified against npm search results*. That verification was impossible
 * while the packages were unpublished; it is possible now, and this module is
 * what keeps it honest once taken:
 *
 *   - every reported rank is a dated record in
 *     `docs/data/npm-search-observations.v1.json`, never prose in the page;
 *   - every observation reports ALL tracked packages, found or not, so a query
 *     where Honua does not rank cannot be quietly dropped from the page;
 *   - a "not found" claim is bounded by the recorded `scanDepth`, and a
 *     "page one" claim by the recorded `resultsPerPage`, because neither means
 *     anything without them;
 *   - observations are immutable per observation: re-observing a query ADDS a
 *     record and the page projects the newest one per query, so an unflattering
 *     rank stays in the file as provenance instead of being edited away.
 *
 * Structural validation is JSON Schema
 * (`schemas/npm-search-observations.v1.json`); the rules a schema cannot
 * express are applied on top of it here.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");

export const OBSERVATIONS_FORMAT = "honua.sdk.npm-search-observations.v1";
export const OBSERVATIONS_RELATIVE_PATH = path.join("docs", "data", "npm-search-observations.v1.json");
export const OBSERVATIONS_SCHEMA_RELATIVE_PATH = path.join("schemas", "npm-search-observations.v1.json");
export const OUTPUT_PATH = "docs/listings/npm-search-verification.md";

/** The one registry endpoint an observation may be taken from. */
export const REGISTRY_SEARCH_ENDPOINT = "https://registry.npmjs.org/-/v1/search";

/**
 * Every package this repository publishes to npm. Kept in CODE, not in the
 * records file: if the data could declare its own tracked set, a package could
 * be dropped from the list on the day its rank got embarrassing.
 */
export const TRACKED_PACKAGES = Object.freeze([
  "@honua/sdk-js",
  "@honua/mcp-server",
  "create-honua-app",
]);

/**
 * The queries under observation, and why each one is tracked.
 *
 * In code for the same reason as the package list — and because `intent` is
 * interpretation, not measurement. A records file that could restate its own
 * purpose could reframe a bad result as a different question.
 */
export const TRACKED_QUERIES = Object.freeze([
  {
    query: "maplibre arcgis migration",
    intent:
      "the exact success-metric query declared on #499 (\"npm search for 'maplibre arcgis migration' surfaces @honua/sdk-js on page one\").",
    trackedMetric: true,
    targetPackage: "@honua/sdk-js",
  },
  {
    query: "arcgis migration",
    intent: "the `arcgis-migration` keyword's primary discovery term (REQ-004).",
  },
  {
    query: "maplibre gis sdk",
    intent: "the `maplibre` discovery term as a MapLibre developer shopping for a data client would type it (REQ-004).",
  },
  {
    query: "ogc api features client",
    intent: "the `ogc-api` discovery term (REQ-004).",
  },
  {
    query: "stac client typescript",
    intent: "the `stac` discovery term (REQ-004).",
  },
  {
    query: "geocoding maplibre",
    intent: "the `geocoding` discovery term (REQ-004).",
  },
  {
    query: "mcp server geospatial",
    intent: "the discovery path to `@honua/mcp-server` for an agent developer.",
  },
]);

for (const entry of TRACKED_QUERIES) {
  if (entry.trackedMetric && !TRACKED_PACKAGES.includes(entry.targetPackage)) {
    throw new Error(`tracked-metric query "${entry.query}" must name a tracked target package`);
  }
}

function queryDeclaration(query) {
  return TRACKED_QUERIES.find((entry) => entry.query === query);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertValidDate(value, label) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`${label} is not a real calendar date: ${value}`);
  return parsed;
}

/**
 * Load and validate the observation set.
 *
 * `now` is injected so freshness is testable rather than wall-clock-dependent.
 */
export function loadNpmSearchObservations({ root = DEFAULT_ROOT, now = new Date() } = {}) {
  const documentPath = path.join(root, OBSERVATIONS_RELATIVE_PATH);
  const schemaPath = path.join(root, OBSERVATIONS_SCHEMA_RELATIVE_PATH);
  const document = readJson(documentPath);
  const schema = readJson(schemaPath);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(document)) {
    const detail = (validate.errors ?? [])
      .map((error) => `- ${error.instancePath || "/"} ${error.message}`)
      .join("\n");
    throw new Error(`${OBSERVATIONS_RELATIVE_PATH} failed schema validation:\n${detail}`);
  }
  if (document.format !== OBSERVATIONS_FORMAT) {
    throw new Error(`${OBSERVATIONS_RELATIVE_PATH} declares format ${document.format}`);
  }

  if (document.registry.endpoint !== REGISTRY_SEARCH_ENDPOINT) {
    throw new Error(`observations must come from ${REGISTRY_SEARCH_ENDPOINT}`);
  }

  const tracked = document.trackedPackages;
  const undeclaredPackages = tracked.filter((name) => !TRACKED_PACKAGES.includes(name));
  const unrecordedPackages = TRACKED_PACKAGES.filter((name) => !tracked.includes(name));
  if (undeclaredPackages.length > 0 || unrecordedPackages.length > 0) {
    throw new Error(
      `trackedPackages must match TRACKED_PACKAGES exactly (extra: ${undeclaredPackages.join(", ") || "none"}; missing: ${unrecordedPackages.join(", ") || "none"})`,
    );
  }

  const seenIds = new Set();
  for (const observation of document.observations) {
    if (!queryDeclaration(observation.query)) {
      throw new Error(`${observation.id} observes query "${observation.query}", which is not declared in TRACKED_QUERIES`);
    }
    if (seenIds.has(observation.id)) {
      throw new Error(`duplicate observation id ${observation.id}`);
    }
    seenIds.add(observation.id);

    const observedAt = assertValidDate(observation.observedAt, `${observation.id} observedAt`);
    const expiresAt = assertValidDate(observation.expiresAt, `${observation.id} expiresAt`);
    if (expiresAt <= observedAt) {
      throw new Error(`${observation.id} expires on or before it was observed`);
    }

    // Report-everything rule: the page can only be as honest as the record, so
    // a record that covers a subset of the tracked packages is rejected outright.
    const covered = observation.hits.map((hit) => hit.package);
    const missing = tracked.filter((name) => !covered.includes(name));
    if (missing.length > 0) {
      throw new Error(`${observation.id} does not report tracked package(s): ${missing.join(", ")}`);
    }
    const untracked = covered.filter((name) => !tracked.includes(name));
    if (untracked.length > 0) {
      throw new Error(`${observation.id} reports untracked package(s): ${untracked.join(", ")}`);
    }
    if (new Set(covered).size !== covered.length) {
      throw new Error(`${observation.id} reports the same package twice`);
    }

    for (const hit of observation.hits) {
      if (hit.found && typeof hit.rank !== "number") {
        throw new Error(`${observation.id} marks ${hit.package} found without a rank`);
      }
      if (hit.found && !hit.published) {
        throw new Error(`${observation.id} ranks ${hit.package} but marks it unpublished`);
      }
      if (!hit.found && hit.rank !== undefined) {
        throw new Error(`${observation.id} marks ${hit.package} not found but carries a rank`);
      }
      if (hit.found && hit.rank > document.registry.scanDepth) {
        throw new Error(
          `${observation.id} reports ${hit.package} at rank ${hit.rank}, beyond the recorded scan depth ${document.registry.scanDepth}`,
        );
      }
    }
  }

  // A declared query with no record is a silently dropped question, so it fails
  // generation the same way a missing evidence record does on the comparison page.
  const observedQueries = new Set(document.observations.map((observation) => observation.query));
  const unobserved = TRACKED_QUERIES.filter((entry) => !observedQueries.has(entry.query)).map((entry) => entry.query);
  if (unobserved.length > 0) {
    throw new Error(`declared query/queries have no observation: ${unobserved.join(", ")}`);
  }

  return { document, staleIds: staleObservationIds(document, now) };
}

/** Observations whose `expiresAt` has passed — reported, never silently reused. */
export function staleObservationIds(document, now = new Date()) {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return latestObservations(document)
    .filter((observation) => Date.parse(`${observation.expiresAt}T00:00:00Z`) < today)
    .map((observation) => observation.id);
}

/**
 * Newest observation per query, in the order the queries are declared in code.
 *
 * This is what makes immutability usable: superseded observations stay in the
 * file as provenance and simply stop being projected. Ordering comes from the
 * code declaration so the page cannot be reordered by editing the data.
 */
export function latestObservations(document) {
  const byQuery = new Map();
  for (const observation of document.observations) {
    const current = byQuery.get(observation.query);
    if (!current || observation.observedAt >= current.observedAt) {
      byQuery.set(observation.query, observation);
    }
  }
  return TRACKED_QUERIES.map((entry) => byQuery.get(entry.query)).filter(Boolean);
}

/** Where a rank lands for a human browsing npmjs.com. */
export function pageOf(rank, resultsPerPage) {
  return Math.ceil(rank / resultsPerPage);
}

function statusOf(hit, registry) {
  // An unpublished package cannot rank. Calling that "not found" would report a
  // discoverability failure for something that was never on the registry to find.
  if (!hit.published) return "not published at observation time";
  if (!hit.found) return `not in the top ${registry.scanDepth}`;
  const page = pageOf(hit.rank, registry.resultsPerPage);
  return page === 1 ? `**page 1** (rank ${hit.rank})` : `page ${page} (rank ${hit.rank})`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

/** Render the generated verification page from the committed observations. */
export function renderNpmSearchMarkdown(document) {
  const registry = document.registry;
  const projected = latestObservations(document);
  const lines = [];

  lines.push("<!-- GENERATED FILE — do not edit by hand. -->");
  lines.push("<!-- Regenerate with: npm run docs:npm-search -->");
  lines.push(`<!-- Inputs: ${OBSERVATIONS_RELATIVE_PATH.split(path.sep).join("/")}. -->`);
  lines.push("<!-- Re-observe against the live registry with: npm run docs:npm-search:observe -->");
  lines.push("<!-- Freshness and drift are enforced by npm run docs:npm-search:check. -->");
  lines.push("");
  lines.push("# npm search discoverability, as measured");
  lines.push("");
  lines.push(
    "Declaring keywords is not discoverability. This page records where the packages this",
    "repository publishes **actually rank** in npm registry search for the discovery terms the",
    "package metadata claims — including the queries where they do not rank at all, which is the",
    "half a keyword list can never tell you.",
    "",
  );
  lines.push(
    `Every row below is projected from a dated record in [\`${OBSERVATIONS_RELATIVE_PATH.split(path.sep).join("/")}\`](../data/npm-search-observations.v1.json),`,
    "validated against",
    `[\`${OBSERVATIONS_SCHEMA_RELATIVE_PATH.split(path.sep).join("/")}\`](../../schemas/npm-search-observations.v1.json).`,
    "Each observation must report **every** tracked package, found or not, so a query where Honua",
    "does not appear cannot be dropped from the page. Records are immutable per observation:",
    "re-observing a query adds a record and the page projects the newest one, so a rank that got",
    "worse stays in the file as provenance.",
    "",
  );

  lines.push("## How the numbers were taken");
  lines.push("");
  lines.push(`- **Endpoint:** \`${registry.endpoint}\` — the registry itself, not a mirror or a third-party rank tracker.`);
  lines.push(
    `- **Page size:** ${registry.resultsPerPage} results, matching npmjs.com's own paging. "Page 1" below means the first ${registry.resultsPerPage} ranked results.`,
  );
  lines.push(
    `- **Scan depth:** ${registry.scanDepth} ranked results per query. A package reported as "not in the top ${registry.scanDepth}" is exactly that claim and no stronger.`,
  );
  lines.push("- **Reproduce:**");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run docs:npm-search:observe   # re-query the live registry and rewrite the records");
  lines.push("npm run docs:npm-search           # regenerate this page from the committed records");
  lines.push("```");
  lines.push("");
  lines.push(
    "Search ranking is a moving, unowned target: it depends on npm's own scoring, on download",
    "counts, and on what else was published that week. Treat every row as an observation with a",
    "date on it, not as a property of the package.",
    "",
  );
  lines.push(
    "One consequence worth stating plainly: these ranks reflect the metadata **as published**, not",
    "the metadata in the working tree. Improving a package's keywords cannot move its rank until",
    "the next release carries them to the registry, so a row here can lag a merged fix by a whole",
    "release cycle.",
    "",
  );

  lines.push("## Tracked packages");
  lines.push("");
  const newest = projected[projected.length - 1];
  for (const name of document.trackedPackages) {
    const hit = newest?.hits.find((entry) => entry.package === name);
    const suffix = hit && !hit.published ? " — not published to npm at the latest observation, so it cannot rank yet" : "";
    lines.push(`- \`${name}\`${suffix}`);
  }
  lines.push("");

  lines.push("## Observed rankings");
  lines.push("");
  lines.push(`| Query | Package | Result | Observed | Registry matches |`);
  lines.push(`| --- | --- | --- | --- | ---: |`);
  for (const observation of projected) {
    // Ranked packages first (best rank first), then the rest in the order they
    // are declared — never sorted away or omitted.
    const hits = [...observation.hits].sort((a, b) => {
      if (a.found !== b.found) return a.found ? -1 : 1;
      if (a.found && b.found) return a.rank - b.rank;
      return TRACKED_PACKAGES.indexOf(a.package) - TRACKED_PACKAGES.indexOf(b.package);
    });
    for (const [index, hit] of hits.entries()) {
      const queryCell = index === 0 ? `\`${escapeCell(observation.query)}\`` : "";
      const observedCell = index === 0 ? observation.observedAt : "";
      const totalCell = index === 0 ? observation.totalResults.toLocaleString("en-US") : "";
      lines.push(
        `| ${queryCell} | \`${escapeCell(hit.package)}\` | ${statusOf(hit, registry)} | ${observedCell} | ${totalCell} |`,
      );
    }
  }
  lines.push("");

  lines.push("## What each query is for");
  lines.push("");
  for (const observation of projected) {
    const declaration = queryDeclaration(observation.query);
    const marker = declaration.trackedMetric ? " **(tracked target)**" : "";
    lines.push(`- \`${observation.query}\`${marker} — ${declaration.intent} Re-observe by ${observation.expiresAt}.`);
  }
  lines.push("");

  const metricObservations = projected.filter((observation) => queryDeclaration(observation.query).trackedMetric);
  if (metricObservations.length > 0) {
    lines.push("## Tracked targets");
    lines.push("");
    for (const observation of metricObservations) {
      const declaration = queryDeclaration(observation.query);
      const hit = observation.hits.find((entry) => entry.package === declaration.targetPackage);
      const met = hit.found && pageOf(hit.rank, registry.resultsPerPage) === 1;
      const verdict = met ? "**met**" : "**not met**";
      lines.push(
        `- \`${observation.query}\` → \`${hit.package}\` on page 1: ${verdict} — ${statusOf(hit, registry)} as observed ${observation.observedAt}.`,
      );
    }
    lines.push("");
    lines.push(
      "A target that is not met is reported here rather than removed. These are tracked,",
      "non-gating metrics on [#499](https://github.com/honua-io/honua-sdk-js/issues/499): CI fails",
      "when this page drifts from its records, never because a rank is disappointing — the SDK does",
      "not own npm's ranking function.",
      "",
    );
  }

  lines.push("## What this page does not claim");
  lines.push("");
  lines.push(
    "- **Not a download count.** Rank is not adoption; the download baseline is tracked separately on #499.",
    "- **Not a competitor comparison.** Which packages outrank Honua for a term is not a product claim; that comparison lives in [`docs/comparison.md`](../comparison.md) under its own evidence contract.",
    "- **Not stable.** Nothing here is a guarantee about the next query you run; rerun the observe command.",
    "",
  );
  lines.push(
    "The declared keywords and descriptions these queries test are gated separately by",
    "`npm run verify:discoverability`, which covers every package this repository publishes.",
    "",
  );
  lines.push("Ecosystem directory entries and the external submission ledger live in");
  lines.push("[`maplibre-plugin-directory.md`](./maplibre-plugin-directory.md).");

  return `${lines.join("\n")}\n`;
}

/** Convenience: validate + render in one call. */
export function generateNpmSearchMarkdown({ root = DEFAULT_ROOT, now = new Date() } = {}) {
  const { document, staleIds } = loadNpmSearchObservations({ root, now });
  return { markdown: renderNpmSearchMarkdown(document), staleIds, document };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one page of registry search results, backing off on the rate limiting a
 * deep scan reliably provokes. A 429 is a throttle, not a measurement, so it
 * must never be recorded as "not found".
 */
async function fetchSearchPage({ url, fetchImpl, attempts = 5, baseDelayMs = 2000, sleepImpl = sleep }) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (response.ok) return response.json();
    lastStatus = response.status;
    if (response.status !== 429 && response.status < 500) break;
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
    await sleepImpl(delay);
  }
  throw new Error(`registry search failed: HTTP ${lastStatus} for ${url}`);
}

/**
 * Query the live registry for one search term and return the tracked packages'
 * ranks. Network-only; never called by `check`.
 */
export async function observeQuery({
  query,
  trackedPackages,
  scanDepth,
  publishedPackages,
  fetchImpl = fetch,
  pacingMs = 1500,
  sleepImpl = sleep,
}) {
  const pageSize = 50;
  const seen = new Map();
  let totalResults = 0;
  for (let from = 0; from < scanDepth; from += pageSize) {
    const size = Math.min(pageSize, scanDepth - from);
    const url = `${REGISTRY_SEARCH_ENDPOINT}?text=${encodeURIComponent(query)}&size=${size}&from=${from}`;
    if (from > 0 && pacingMs > 0) await sleepImpl(pacingMs);
    const body = await fetchSearchPage({ url, fetchImpl, sleepImpl });
    totalResults = typeof body.total === "number" ? body.total : totalResults;
    const objects = Array.isArray(body.objects) ? body.objects : [];
    objects.forEach((object, index) => {
      const name = object?.package?.name;
      if (trackedPackages.includes(name) && !seen.has(name)) {
        seen.set(name, { rank: from + index + 1, version: object?.package?.version });
      }
    });
    if (objects.length < size) break;
  }

  const hits = trackedPackages.map((name) => {
    const published = publishedPackages ? publishedPackages.includes(name) : true;
    const hit = seen.get(name);
    if (!hit) return { package: name, found: false, published };
    return { package: name, found: true, published: true, rank: hit.rank, ...(hit.version ? { version: hit.version } : {}) };
  });
  return { totalResults, hits };
}

/**
 * Which of the tracked packages actually exist on the registry right now.
 *
 * Taken alongside the ranks so the page can tell "published but not ranking"
 * apart from "not published yet" instead of reporting both as a miss.
 */
export async function resolvePublishedPackages({ trackedPackages, fetchImpl = fetch }) {
  const published = [];
  for (const name of trackedPackages) {
    const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
      headers: { accept: "application/json" },
    });
    if (response.ok) {
      published.push(name);
      continue;
    }
    if (response.status !== 404) {
      throw new Error(`could not resolve registry state for ${name}: HTTP ${response.status}`);
    }
  }
  return published;
}
