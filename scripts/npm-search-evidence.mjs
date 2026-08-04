#!/usr/bin/env node

/**
 * Generate `docs/listings/npm-search-verification.md` — the measured npm search
 * discoverability page (honua-io/honua-sdk-js#499, REQ-004).
 *
 * Modes:
 *   node scripts/npm-search-evidence.mjs write     # regenerate the page from committed records (offline)
 *   node scripts/npm-search-evidence.mjs check     # fail on drift or an invalid record set (offline)
 *   node scripts/npm-search-evidence.mjs observe   # re-query the live registry, then regenerate (network)
 *
 * `check` is deliberately offline and deterministic: PR CI must not depend on
 * npm's search service being up, and a rank that drifted overnight must not
 * fail an unrelated pull request. Staleness is *reported* by `check` and only
 * fails when HONUA_NPM_SEARCH_STRICT_FRESHNESS is set, which is what a
 * scheduled re-observation run turns on.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  OBSERVATIONS_RELATIVE_PATH,
  OUTPUT_PATH,
  TRACKED_PACKAGES,
  TRACKED_QUERIES,
  generateNpmSearchMarkdown,
  observeQuery,
  resolvePublishedPackages,
} from "./lib/npm-search-observations.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function slugify(query) {
  return query
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function addMonths(isoDate, months) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function writePage(markdown) {
  const output = path.join(ROOT, OUTPUT_PATH);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, markdown, "utf8");
  process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
}

function reportStale(staleIds) {
  if (staleIds.length === 0) return;
  const message = `${staleIds.length} npm search observation(s) are past expiresAt: ${staleIds.join(", ")} — rerun "npm run docs:npm-search:observe".`;
  if (/^(1|true|yes|on)$/i.test(process.env.HONUA_NPM_SEARCH_STRICT_FRESHNESS ?? "")) {
    throw new Error(message);
  }
  process.stdout.write(`warning: ${message}\n`);
}

async function observe() {
  const documentPath = path.join(ROOT, OBSERVATIONS_RELATIVE_PATH);
  const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
  const observedAt = new Date().toISOString().slice(0, 10);
  const expiresAt = addMonths(observedAt, 3);

  // Both the query set and the package set come from code, so an observation
  // run cannot narrow what it looks at. Adding or retiring a query is a reviewed
  // change to TRACKED_QUERIES.
  document.trackedPackages = [...TRACKED_PACKAGES];

  // Resolve publication state once, up front: a package that is not on the
  // registry cannot rank, and reporting it as "not found" would invent a
  // discoverability failure that has not been tested yet.
  const publishedPackages = await resolvePublishedPackages({ trackedPackages: [...TRACKED_PACKAGES] });
  for (const name of TRACKED_PACKAGES) {
    process.stdout.write(`registry state: ${name} ${publishedPackages.includes(name) ? "published" : "unpublished"}\n`);
  }

  const fresh = [];
  for (const entry of TRACKED_QUERIES) {
    const { totalResults, hits } = await observeQuery({
      query: entry.query,
      trackedPackages: [...TRACKED_PACKAGES],
      scanDepth: document.registry.scanDepth,
      publishedPackages,
    });
    const record = {
      id: `${observedAt}-${slugify(entry.query)}`,
      query: entry.query,
      observedAt,
      expiresAt,
      totalResults,
      hits,
    };
    fresh.push(record);
    const summary = hits
      .map((hit) => {
        if (hit.found) return `${hit.package}=#${hit.rank}`;
        return `${hit.package}=${hit.published ? "unranked" : "unpublished"}`;
      })
      .join(" ");
    process.stdout.write(`observed "${entry.query}": ${summary}\n`);
  }

  // Immutability: keep every prior observation, drop only a same-day rerun of
  // the same query so repeating the command is idempotent.
  const kept = document.observations.filter(
    (observation) => !fresh.some((record) => record.id === observation.id),
  );
  document.observations = [...kept, ...fresh];
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${OBSERVATIONS_RELATIVE_PATH.split(path.sep).join("/")}\n`);
}

async function main() {
  const mode = process.argv[2] ?? "write";
  if (!["write", "check", "observe"].includes(mode)) {
    throw new Error(`unknown mode "${mode}" (expected "write", "check", or "observe")`);
  }

  if (mode === "observe") {
    await observe();
  }

  const { markdown, staleIds } = generateNpmSearchMarkdown({ root: ROOT });

  if (mode === "check") {
    const output = path.join(ROOT, OUTPUT_PATH);
    const existing = fs.existsSync(output) ? fs.readFileSync(output, "utf8").replace(/\r\n/g, "\n") : "";
    if (existing !== markdown) {
      throw new Error(`${OUTPUT_PATH} is out of date — run "npm run docs:npm-search".`);
    }
    reportStale(staleIds);
    process.stdout.write(`${OUTPUT_PATH} is up to date\n`);
    return;
  }

  writePage(markdown);
  reportStale(staleIds);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
