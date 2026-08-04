#!/usr/bin/env node
// Re-records the NON-GeoServices (OGC API Features) fixtures from a live PUBLIC
// endpoint, then regenerates the committed `src/certification/ogc-data.ts` source
// module that the offline `standalone-ogc` certification lane and the `ogc` eval
// corpus replay against (issue #1005).
//
// CI never runs this and never touches the network — the committed data module is
// what the fixture client replays. Run it by hand to refresh the recording:
//
//   node mcp/scripts/record-ogc-fixtures.mjs
//
// The recorder hits the public pygeoapi demo (demo.pygeoapi.io), which is the
// `ogc-features` target already pinned in config/live-conformance-endpoints.v1.json
// — anonymous, read-only, open sample data. It records the raw upstream OGC JSON
// under test/fixtures/pygeoapi/ (audit trail) AND rewrites the typed data module.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(mcpRoot, "test", "fixtures", "pygeoapi");
const dataModule = path.join(mcpRoot, "src", "certification", "ogc-data.ts");

const ENDPOINT = process.env.STANDALONE_OGC_URL ?? "https://demo.pygeoapi.io/master";
const COLLECTIONS = ["obs", "utah_city_locations"];
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function writeRaw(name, value) {
  await fs.writeFile(path.join(fixtureDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Drain every page of a collection's items (pygeoapi caps a page at 10). */
async function drainItems(collectionId) {
  const features = [];
  let numberMatched;
  for (let offset = 0; offset < 1000; offset += 10) {
    const page = await fetchJson(
      `${ENDPOINT}/collections/${collectionId}/items?f=json&limit=10&offset=${offset}`,
    );
    numberMatched = page.numberMatched ?? numberMatched;
    features.push(...(page.features ?? []));
    if ((page.features ?? []).length < 10) break;
    if (numberMatched !== undefined && features.length >= numberMatched) break;
  }
  return { features, numberMatched: numberMatched ?? features.length };
}

function trimCollection(collection) {
  // Keep the identity + description + extent the tools read; drop the link farm.
  return {
    id: collection.id,
    title: collection.title ?? null,
    description: collection.description ?? null,
    extent: collection.extent ?? null,
    crs: collection.crs ?? null,
    itemType: collection.itemType ?? "feature",
  };
}

async function main() {
  await fs.mkdir(fixtureDir, { recursive: true });
  process.stdout.write(`Recording OGC API Features fixtures from ${ENDPOINT}\n`);

  const recorded = [];
  for (const collectionId of COLLECTIONS) {
    const collection = await fetchJson(`${ENDPOINT}/collections/${collectionId}?f=json`);
    let queryables = null;
    try {
      queryables = await fetchJson(`${ENDPOINT}/collections/${collectionId}/queryables?f=json`);
    } catch {
      queryables = null;
    }
    const items = await drainItems(collectionId);

    await writeRaw(`${collectionId}-collection.json`, collection);
    await writeRaw(`${collectionId}-items.json`, items);
    if (queryables) await writeRaw(`${collectionId}-queryables.json`, queryables);

    recorded.push({
      collection: trimCollection(collection),
      queryables: queryables?.properties ?? null,
      features: items.features,
      numberMatched: items.numberMatched,
    });
    process.stdout.write(`  ${collectionId}: ${items.features.length} features\n`);
  }

  const banner = `// AUTO-RECORDED FIXTURE DATA — do not hand-edit.
//
// Recorded from the public pygeoapi demo (an OGC API Features implementation with
// no Esri/GeoServices surface at all):
//   ${ENDPOINT}
// This is the pinned \`ogc-features\` conformance target in
// config/live-conformance-endpoints.v1.json — anonymous, read-only, open sample
// data. Re-record with mcp/scripts/record-ogc-fixtures.mjs.
//
// It is the NON-GeoServices proof corpus for the protocol-neutral tool contract
// (issue #1005): the same MCP tools that certify against a plain Esri
// FeatureServer must certify against this endpoint too, addressing sources as
// \`ogc-features:<collectionId>\` and degrading honestly where OGC API Features
// has no server-side equivalent (aggregation, extent-of-a-filtered-set).
`;

  const module = `${banner}
/** A recorded OGC API Features collection: metadata, queryables, and every item. */
export interface OgcFixtureCollection {
  readonly collection: {
    readonly id: string;
    readonly title: string | null;
    readonly description: string | null;
    readonly extent: unknown;
    readonly crs: readonly string[] | null;
    readonly itemType: string;
  };
  readonly queryables: Record<string, { type?: string; title?: string; [key: string]: unknown }> | null;
  readonly features: ReadonlyArray<{
    readonly type: "Feature";
    readonly id?: string | number;
    readonly geometry: Record<string, unknown> | null;
    readonly properties: Record<string, unknown> | null;
  }>;
  readonly numberMatched: number;
}

/** The public OGC API Features endpoint these fixtures were recorded from. */
export const OGC_ENDPOINT = ${JSON.stringify(ENDPOINT)};

/** Recorded collections, keyed by collection id. */
export const OGC_COLLECTIONS: Readonly<Record<string, OgcFixtureCollection>> = ${JSON.stringify(
    Object.fromEntries(recorded.map((entry) => [entry.collection.id, entry])),
    null,
    2,
  )} as const;

/** Collection ids in advertised order. */
export const OGC_COLLECTION_IDS: readonly string[] = ${JSON.stringify(COLLECTIONS)};
`;

  await fs.writeFile(dataModule, module, "utf8");
  process.stdout.write(`Done. Recorded ${recorded.length} collections -> src/certification/ogc-data.ts\n`);
}

main().catch((error) => {
  process.stderr.write(`Fixture recording failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
