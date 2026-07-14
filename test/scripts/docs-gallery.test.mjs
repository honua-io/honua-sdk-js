import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  filterGalleryCards,
  normalizeGalleryFilters,
} from "../../scripts/lib/docs-gallery-client.mjs";
import { createGalleryModel, renderGalleryContent } from "../../scripts/lib/docs-gallery.mjs";
import { validateSiteProjection } from "../../scripts/sample-contract.mjs";

const projection = JSON.parse(fs.readFileSync("samples/dist/honua-site-samples.v2.json", "utf8"));

function projectionWithSamples(...ids) {
  const selected = structuredClone(projection);
  selected.samples = ids.map((id) => projection.samples.find((sample) => sample.id === id));
  return selected;
}

function galleryCards(gallery) {
  return gallery.groups.flatMap((group) => group.cards);
}

function occurrenceCount(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

test("projects one schema-valid catalog-v2 sample into one honest public gallery card", async () => {
  const oneCard = projectionWithSamples("endpoint-to-map");

  await assert.doesNotReject(validateSiteProjection(oneCard));
  const gallery = createGalleryModel(oneCard);
  assert.equal(gallery.cardCount, 1);
  assert.deepEqual(gallery.groups.map(({ track, title }) => ({ track, title })), [
    { track: "recipe", title: "Recipes" },
  ]);
  assert.deepEqual(gallery.groups[0].cards[0].sample, oneCard.samples[0]);
  assert.equal(gallery.groups[0].cards[0].journey, null);
  assert.equal(gallery.groups[0].cards[0].replacement, null);
  assert.deepEqual(gallery.provenance, {
    projection: {
      format: projection.format,
      schemaVersion: projection.schemaVersion,
    },
    catalog: projection.catalog,
    contract: projection.contract,
  });
  assert.deepEqual(gallery.filters, {
    capabilities: ["direct-connect", "map", "query"],
    protocols: ["geoservices"],
  });
});

test("refuses to publish a schema-valid projection with zero public cards", async () => {
  const empty = structuredClone(projection);
  empty.samples = [];

  await assert.doesNotReject(validateSiteProjection(empty));
  assert.throws(
    () => createGalleryModel(empty),
    /Gallery projection produced zero public cards; refusing to publish an empty gallery\./,
  );

  const fixtureOnly = projectionWithSamples("arcgis-source-app");
  await assert.doesNotReject(validateSiteProjection(fixtureOnly));
  assert.throws(
    () => createGalleryModel(fixtureOnly),
    /Gallery projection produced zero public cards; refusing to publish an empty gallery\./,
  );
});

test("projects the canonical public portfolio without hiding lifecycle or replacement truth", () => {
  const gallery = createGalleryModel(projection);
  const counts = Object.fromEntries(gallery.groups.map((group) => [group.track, group.cards.length]));
  const cards = galleryCards(gallery);
  const byId = new Map(cards.map((card) => [card.sample.id, card]));

  assert.equal(gallery.cardCount, 32);
  assert.deepEqual(counts, { recipe: 15, lab: 17 });
  assert.ok(!byId.has("arcgis-source-app"));
  assert.ok(!byId.has("automatic-source-workflow"));
  assert.deepEqual(byId.get("runtime-parity-showcase").replacement, {
    kind: "journey",
    id: "service-explorer",
    title: "Universal Service Explorer",
    status: "planned",
    candidateSampleId: "service-explorer",
    publicSampleId: "service-explorer",
  });
  assert.deepEqual(byId.get("web-components-basic").replacement, {
    kind: "external",
    id: "honua-app-platform",
    title: "@honua/app-platform",
    url: "https://www.npmjs.com/package/@honua/app-platform",
  });
  assert.equal(byId.get("web-components-basic").sample.lifecycle.state, "retire");
  assert.equal(byId.get("realtime-incident-dashboard").journey.title, "Realtime Incident Operations");
});

test("sorts public capability and protocol facets deterministically", () => {
  const gallery = createGalleryModel(projection);
  const capabilities = galleryCards(gallery).flatMap((card) => card.sample.capabilities);
  const protocols = galleryCards(gallery).flatMap((card) => card.sample.protocols);

  assert.deepEqual(gallery.filters.capabilities, [...new Set(capabilities)].sort());
  assert.deepEqual(gallery.filters.protocols, [...new Set(protocols)].sort());
  assert.ok(!gallery.filters.capabilities.includes("interaction-state"));
});

test("renders accessible controls, compact essentials, and disclosed catalog truth", () => {
  const gallery = createGalleryModel(projectionWithSamples("realtime-incident-dashboard"));
  const html = renderGalleryContent(gallery, {
    resolveSourceLink: () => ({ href: "https://github.com/honua-io/honua-sdk-js", kind: "source" }),
  });

  for (const label of [
    "SDK",
    "Data",
    "Evidence state",
    "Replacement",
    "Capabilities",
    "Protocols",
    "Lifecycle",
    "Data provenance",
    "Attribution",
    "Freshness",
    "Evidence details",
    "Expected degradation",
    "Renderers",
    "Golden journey",
    "Validation profile",
    "Catalog",
    "Projection",
    "Contract",
  ]) {
    assert.match(html, new RegExp(`<dt>${label}</dt>`));
  }
  assert.match(html, /<form[^>]+role="search"[^>]+aria-label="Filter demo gallery"/);
  assert.match(html, /<label for="gallery-search">Task or sample<\/label>/);
  assert.match(html, /<label for="gallery-capability">Capability<\/label>/);
  assert.match(html, /<label for="gallery-protocol">Protocol<\/label>/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /data-gallery-empty hidden/);
  assert.match(html, /@honua\/sdk-js/);
  assert.match(html, /0\.1\.0-beta\.0/);
  assert.match(html, /honua\.sdk\.sample-catalog\.v2/);
  assert.match(html, /honua\.site\.sdk-sample-projection\.v2/);
  assert.match(html, /honua-io\/honua-sdk-js#540/);
  assert.match(html, /Fixture: <strong>executed<\/strong>/);
  assert.match(html, /unavailable<\/code> · <strong>skipped<\/strong>/);
  assert.match(html, /evidence expires <time/);
  assert.match(html, /2026-07-26T02:18:02\.730Z/);
  assert.match(html, /Realtime Incident Operations/);
  assert.match(html, /safe-editing/);
  assert.match(html, /maplibre/);
  assert.match(html, /<summary>Evidence, provenance, lifecycle, and degradation<\/summary>/);
  assert.doesNotMatch(html, /<script|\son[a-z]+=/i);
});

test("renders global provenance once and puts every card CTA before its disclosure", () => {
  const html = renderGalleryContent(createGalleryModel(projection));
  const cards = [...html.matchAll(/<article class="demo-card[\s\S]*?<\/article>/g)].map((match) => match[0]);

  assert.equal(occurrenceCount(html, /data-gallery-provenance/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Catalog<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Projection<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Contract<\/dt>/g), 1);
  assert.equal(cards.length, 32);
  for (const card of cards) {
    const ctaIndex = card.indexOf('<a class="demo-link"');
    const detailsIndex = card.indexOf('<details class="demo-card-details">');
    assert.doesNotMatch(card, /<dt>(?:Catalog|Projection|Contract)<\/dt>/);
    assert.ok(ctaIndex >= 0 && detailsIndex > ctaIndex);
    assert.match(card, /<summary>Evidence, provenance, lifecycle, and degradation<\/summary>/);
  }
});

test("escapes projected content and links only credential-free HTTPS replacements", () => {
  const unsafe = projectionWithSamples("web-components-basic");
  unsafe.samples[0].title = '<img src=x onerror="alert(1)">';
  unsafe.samples[0].data.provenance = '</dd><script>alert("x")</script>';
  const unsafeUrls = [
    "javascript:alert(1)",
    "http://example.test/replacement",
    "https://user:password@example.test/replacement",
  ];

  for (const url of unsafeUrls) {
    unsafe.externalReplacements[0].url = url;
    const html = renderGalleryContent(createGalleryModel(unsafe));

    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;\/dd&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<img|<script|href="(?:javascript:|http:|https:\/\/user:)/i);
    assert.match(html, /external: @honua\/app-platform \(honua-app-platform\)/);
  }

  const safeHtml = renderGalleryContent(createGalleryModel(projectionWithSamples("web-components-basic")));
  assert.match(
    safeHtml,
    /href="https:\/\/www\.npmjs\.com\/package\/@honua\/app-platform" rel="noopener noreferrer"/,
  );
});

test("filters task text with AND semantics and combines exact capability and protocol facets", () => {
  const records = galleryCards(createGalleryModel(projection)).map((card) => ({
    id: card.sample.id,
    searchText: card.searchText,
    capabilities: card.sample.capabilities,
    protocols: card.sample.protocols,
  }));

  assert.deepEqual(normalizeGalleryFilters({ text: "  REALTIME\t operations  " }), {
    text: "realtime operations",
    capability: "",
    protocol: "",
  });
  assert.deepEqual(
    filterGalleryCards(records, { text: "realtime guarded" }).map(({ id }) => id),
    ["realtime-incident-dashboard"],
  );
  assert.deepEqual(
    filterGalleryCards(records, { capability: "safe-editing", protocol: "sse" }).map(({ id }) => id),
    ["realtime-incident-dashboard"],
  );
  assert.deepEqual(filterGalleryCards(records, { capability: "safe-editing", protocol: "stac" }), []);
});
