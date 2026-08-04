import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OBSERVATIONS_RELATIVE_PATH,
  OBSERVATIONS_SCHEMA_RELATIVE_PATH,
  REGISTRY_SEARCH_ENDPOINT,
  TRACKED_PACKAGES,
  TRACKED_QUERIES,
  latestObservations,
  loadNpmSearchObservations,
  observeQuery,
  pageOf,
  renderNpmSearchMarkdown,
  resolvePublishedPackages,
} from "../../scripts/lib/npm-search-observations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function committedDocument() {
  return JSON.parse(fs.readFileSync(path.join(root, OBSERVATIONS_RELATIVE_PATH), "utf8"));
}

/**
 * Materialise a throwaway project whose records file is `document` but whose
 * schema is the real one, so schema-level negatives are exercised against the
 * committed schema rather than a copy that could drift.
 */
function withDocument(document) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "npm-search-"));
  const recordsPath = path.join(projectRoot, OBSERVATIONS_RELATIVE_PATH);
  const schemaPath = path.join(projectRoot, OBSERVATIONS_SCHEMA_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(recordsPath, JSON.stringify(document), "utf8");
  fs.copyFileSync(path.join(root, OBSERVATIONS_SCHEMA_RELATIVE_PATH), schemaPath);
  return projectRoot;
}

function assertRejects(document, pattern) {
  assert.throws(() => loadNpmSearchObservations({ root: withDocument(document) }), pattern);
}

test("the committed observation set validates", () => {
  const { document } = loadNpmSearchObservations({ root });
  assert.equal(document.registry.endpoint, REGISTRY_SEARCH_ENDPOINT);
  assert.ok(document.observations.length > 0);
});

test("every declared query is observed, and every declared package is reported", () => {
  const { document } = loadNpmSearchObservations({ root });
  for (const entry of TRACKED_QUERIES) {
    const observation = document.observations.find((record) => record.query === entry.query);
    assert.ok(observation, `no observation for declared query "${entry.query}"`);
  }
  for (const observation of document.observations) {
    assert.deepEqual(
      [...observation.hits.map((hit) => hit.package)].sort(),
      [...TRACKED_PACKAGES].sort(),
      `${observation.id} must report every tracked package`,
    );
  }
});

test("a declared query with no observation is rejected", () => {
  const document = committedDocument();
  document.observations = document.observations.filter((record) => record.query !== TRACKED_QUERIES[0].query);
  assertRejects(document, /have no observation/);
});

test("an observation that drops a tracked package is rejected", () => {
  const document = committedDocument();
  document.observations[0].hits = document.observations[0].hits.filter(
    (hit) => hit.package !== TRACKED_PACKAGES[1],
  );
  assertRejects(document, /does not report tracked package/);
});

test("a narrowed tracked-package list is rejected", () => {
  const document = committedDocument();
  document.trackedPackages = [TRACKED_PACKAGES[0]];
  for (const observation of document.observations) {
    observation.hits = observation.hits.filter((hit) => hit.package === TRACKED_PACKAGES[0]);
  }
  assertRejects(document, /trackedPackages must match TRACKED_PACKAGES/);
});

test("an undeclared query cannot smuggle itself onto the page", () => {
  const document = committedDocument();
  document.observations.push({
    ...document.observations[0],
    id: "2026-01-01-invented",
    query: "a query nobody declared",
  });
  assertRejects(document, /not declared in TRACKED_QUERIES/);
});

test("a found hit with no rank, and an unfound hit with one, are both rejected", () => {
  const missingRank = committedDocument();
  const hit = missingRank.observations.find((record) => record.hits.some((entry) => entry.found));
  const found = hit.hits.find((entry) => entry.found);
  delete found.rank;
  assertRejects(missingRank, /found without a rank/);

  const phantomRank = committedDocument();
  const unfound = phantomRank.observations
    .flatMap((record) => record.hits)
    .find((entry) => !entry.found);
  unfound.rank = 3;
  assertRejects(phantomRank, /not found but carries a rank/);
});

test("a package that ranks cannot also be marked unpublished", () => {
  const document = committedDocument();
  const observation = document.observations.find((record) => record.hits.some((entry) => entry.found));
  observation.hits.find((entry) => entry.found).published = false;
  assertRejects(document, /ranks .* but marks it unpublished/);
});

test("an unpublished package is reported as unpublished, not as a discoverability miss", () => {
  const { document } = loadNpmSearchObservations({ root });
  const unpublished = latestObservations(document)
    .flatMap((observation) => observation.hits)
    .filter((hit) => !hit.published);
  if (unpublished.length === 0) {
    return; // every tracked package is published; nothing to distinguish
  }
  const markdown = renderNpmSearchMarkdown(document);
  assert.match(markdown, /not published at observation time/);
  assert.match(markdown, /cannot rank yet/);
});

test("a rank beyond the recorded scan depth is rejected", () => {
  const document = committedDocument();
  const observation = document.observations.find((record) => record.hits.some((entry) => entry.found));
  observation.hits.find((entry) => entry.found).rank = document.registry.scanDepth + 1;
  assertRejects(document, /beyond the recorded scan depth/);
});

test("a non-registry endpoint is rejected", () => {
  const document = committedDocument();
  document.registry.endpoint = "https://example.com/-/v1/search";
  assertRejects(document, /schema validation|must come from/);
});

test("duplicate observation ids are rejected", () => {
  const document = committedDocument();
  document.observations.push({ ...document.observations[0] });
  assertRejects(document, /duplicate observation id/);
});

test("an expiry on or before the observation date is rejected", () => {
  const document = committedDocument();
  document.observations[0].expiresAt = document.observations[0].observedAt;
  assertRejects(document, /expires on or before/);
});

test("staleness is reported rather than thrown", () => {
  const { staleIds } = loadNpmSearchObservations({ root, now: new Date("2099-01-01T00:00:00Z") });
  assert.ok(staleIds.length > 0, "far-future clock must mark projected observations stale");
  const fresh = loadNpmSearchObservations({ root, now: new Date("2000-01-01T00:00:00Z") });
  assert.deepEqual(fresh.staleIds, []);
});

test("the newest observation per query is the one projected", () => {
  const document = committedDocument();
  const base = document.observations[0];
  const newer = {
    ...structuredClone(base),
    id: `${base.id}-newer`,
    observedAt: "2099-01-01",
    expiresAt: "2099-04-01",
  };
  newer.hits = newer.hits.map((hit) => ({ package: hit.package, found: true, rank: 7 }));
  document.observations.push(newer);
  const projected = latestObservations(document);
  const forQuery = projected.find((observation) => observation.query === base.query);
  assert.equal(forQuery.id, newer.id);
  assert.equal(projected.length, TRACKED_QUERIES.length);
});

test("projected order follows the code declaration, not the file order", () => {
  const document = committedDocument();
  document.observations.reverse();
  assert.deepEqual(
    latestObservations(document).map((observation) => observation.query),
    TRACKED_QUERIES.map((entry) => entry.query),
  );
});

test("table cells survive pipes and backslashes without breaking the row", () => {
  const document = committedDocument();
  // A query is rendered into a table cell; escaping that handles "|" but not
  // "\" would let `\|` through as a bare cell terminator.
  document.registry.resultsPerPage = 20;
  const rendered = renderNpmSearchMarkdown({
    ...document,
    observations: document.observations,
  });
  for (const row of rendered.split("\n").filter((line) => line.startsWith("| `"))) {
    const cells = row.split(/(?<!\\)\|/);
    assert.equal(cells.length, 7, `row must have five cells: ${row}`);
  }
});

test("a scoped package name is fully encoded in the registry URL", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, status: 200 };
  };
  await resolvePublishedPackages({ trackedPackages: ["@scope/with/slashes"], fetchImpl });
  assert.equal(seen[0], "https://registry.npmjs.org/@scope%2Fwith%2Fslashes");
  assert.ok(!seen[0].includes("/with"), "every slash in the package name must be encoded");
});

test("pageOf converts a rank into the page a human sees", () => {
  assert.equal(pageOf(1, 20), 1);
  assert.equal(pageOf(20, 20), 1);
  assert.equal(pageOf(21, 20), 2);
  assert.equal(pageOf(53, 20), 3);
});

test("the rendered page reports unranked packages and an unmet target", () => {
  const { document } = loadNpmSearchObservations({ root });
  const markdown = renderNpmSearchMarkdown(document);

  for (const name of TRACKED_PACKAGES) {
    assert.ok(markdown.includes(`\`${name}\``), `page must name ${name}`);
  }
  for (const entry of TRACKED_QUERIES) {
    assert.ok(markdown.includes(`\`${entry.query}\``), `page must show query ${entry.query}`);
  }

  const projected = latestObservations(document);
  const unranked = projected.flatMap((observation) => observation.hits).filter((hit) => !hit.found);
  if (unranked.length > 0) {
    assert.match(markdown, /not in the top \d+/, "unranked packages must be rendered, not dropped");
  }

  const metric = TRACKED_QUERIES.find((entry) => entry.trackedMetric);
  const observation = projected.find((entry) => entry.query === metric.query);
  const hit = observation.hits.find((entry) => entry.package === metric.targetPackage);
  const met = hit.found && pageOf(hit.rank, document.registry.resultsPerPage) === 1;
  assert.match(markdown, met ? /on page 1: \*\*met\*\*/ : /on page 1: \*\*not met\*\*/);
});

test("the rendered page states the scan depth behind every not-found claim", () => {
  const { document } = loadNpmSearchObservations({ root });
  const markdown = renderNpmSearchMarkdown(document);
  assert.ok(markdown.includes(`Scan depth:** ${document.registry.scanDepth}`));
  assert.ok(markdown.includes(`Page size:** ${document.registry.resultsPerPage}`));
});

test("observeQuery reports an unfound tracked package instead of omitting it", async () => {
  const pages = [
    {
      total: 42,
      objects: [{ package: { name: "somebody-else", version: "1.0.0" } }, { package: { name: TRACKED_PACKAGES[0], version: "9.9.9" } }],
    },
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => pages.shift() ?? { total: 42, objects: [] } });
  const result = await observeQuery({
    query: "anything",
    trackedPackages: [...TRACKED_PACKAGES],
    scanDepth: 50,
    publishedPackages: [TRACKED_PACKAGES[0], TRACKED_PACKAGES[1]],
    fetchImpl,
    pacingMs: 0,
  });
  assert.equal(result.totalResults, 42);
  assert.deepEqual(result.hits.map((hit) => hit.package), [...TRACKED_PACKAGES]);
  assert.deepEqual(result.hits[0], {
    package: TRACKED_PACKAGES[0],
    found: true,
    published: true,
    rank: 2,
    version: "9.9.9",
  });
  for (const hit of result.hits.slice(1)) assert.equal(hit.found, false);
  // The unpublished package is carried through as unpublished, not as a miss.
  assert.equal(result.hits[2].published, false);
  assert.equal(result.hits[1].published, true);
});

test("resolvePublishedPackages treats 404 as unpublished and anything else as an error", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("create-honua-app")) return { ok: false, status: 404 };
    return { ok: true, status: 200 };
  };
  const published = await resolvePublishedPackages({ trackedPackages: [...TRACKED_PACKAGES], fetchImpl });
  assert.deepEqual(published, TRACKED_PACKAGES.filter((name) => name !== "create-honua-app"));

  await assert.rejects(
    resolvePublishedPackages({
      trackedPackages: [TRACKED_PACKAGES[0]],
      fetchImpl: async () => ({ ok: false, status: 500 }),
    }),
    /could not resolve registry state/,
  );
});

test("observeQuery retries a throttled page rather than recording a false negative", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => null } };
    return { ok: true, json: async () => ({ total: 1, objects: [{ package: { name: TRACKED_PACKAGES[0], version: "1.2.3" } }] }) };
  };
  const result = await observeQuery({
    query: "throttled",
    trackedPackages: [...TRACKED_PACKAGES],
    scanDepth: 50,
    fetchImpl,
    pacingMs: 0,
    sleepImpl: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(result.hits[0].found, true);
  assert.equal(result.hits[0].rank, 1);
});

test("observeQuery gives up rather than reporting a throttled scan as a measurement", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, headers: { get: () => null } });
  await assert.rejects(
    observeQuery({
      query: "always throttled",
      trackedPackages: [...TRACKED_PACKAGES],
      scanDepth: 50,
      fetchImpl,
      pacingMs: 0,
      sleepImpl: async () => {},
    }),
    /HTTP 429/,
  );
});
