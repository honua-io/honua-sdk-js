import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  filterGalleryCards,
  initializeGallery,
  normalizeGalleryFilters,
} from "../../scripts/lib/docs-gallery-client.mjs";
import {
  createGalleryModel,
  renderGalleryContent,
  verifyGalleryProjectionIntegrity,
} from "../../scripts/lib/docs-gallery.mjs";

const projectionBytes = fs.readFileSync("samples/dist/honua-site-samples.v2.json", "utf8");
const projection = JSON.parse(projectionBytes);
const consumerFixture = JSON.parse(
  fs.readFileSync("samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json", "utf8"),
);
const repositorySourceResolver = (sample) => {
  const { docsPath } = sample.source;
  if (docsPath.startsWith("docs/") && docsPath.endsWith(".md")) {
    return {
      href: "guides/" + docsPath.slice("docs/".length).replace(/\.md$/u, ".html"),
      kind: "guide",
    };
  }
  return {
    href: "https://github.com/" + sample.source.repository + "/blob/trunk/" + docsPath,
    kind: "source",
  };
};

function stableBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixtureForProjection(value) {
  const fixture = structuredClone(consumerFixture);
  const bytes = stableBytes(value);
  const sampleIds = value.samples.map((sample) => sample.id);
  const routeIds = value.routes.map((route) => route.id);
  fixture.accepts = {
    projectionFormat: value.format,
    projectionSchemaVersion: value.schemaVersion,
    catalogFormat: value.catalog.format,
    catalogSchemaVersion: value.catalog.schemaVersion,
  };
  fixture.input.sha256 = createHash("sha256").update(bytes).digest("hex");
  fixture.assertions = {
    sampleCount: value.samples.length,
    rootExampleCount: value.samples.filter((sample) => sample.sourceKind === "root-example").length,
    docsExampleCount: value.samples.filter((sample) => sample.sourceKind === "docs-example").length,
    goldenJourneyCount: value.goldenJourneys.length,
    qualifiedGoldenCount: value.goldenJourneys.filter((journey) => journey.status === "qualified").length,
    routeCount: value.routes.length,
    sampleBundleCount: Array.isArray(value.sampleBundles?.sampleIds) ? value.sampleBundles.sampleIds.length : 0,
    sampleIdsUnique: new Set(sampleIds).size === sampleIds.length,
    routeIdsUnique: new Set(routeIds).size === routeIds.length,
    routesEndInHtml: value.routes.every((route) => route.route.endsWith(".html")),
    executableSourceOwner: value.contract.executableSourceOwner,
    presentationOwner: value.contract.presentationOwner,
    credentialValuesForbidden: true,
  };
  return fixture;
}

async function verifiedGallery(value, { bytes = stableBytes(value), fixture = fixtureForProjection(value) } = {}) {
  const integrity = await verifyGalleryProjectionIntegrity({
    projectionBytes: bytes,
    consumerFixture: fixture,
  });
  return createGalleryModel(integrity);
}

function canonicalGallery() {
  return verifiedGallery(projection, { bytes: projectionBytes, fixture: consumerFixture });
}

function renderGallery(gallery, resolveSourceLink = repositorySourceResolver) {
  return renderGalleryContent(gallery, { resolveSourceLink });
}

function sampleById(value, id) {
  return value.samples.find((sample) => sample.id === id);
}

function galleryCards(gallery) {
  return gallery.groups.flatMap((group) => group.cards);
}

function occurrenceCount(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function assertDeepFrozen(root) {
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    assert.equal(Object.isFrozen(value), true);
    pending.push(...Object.values(value));
  }
}

test("binds the canonical schema-valid projection to its v2 consumer fixture", async () => {
  const gallery = await canonicalGallery();

  assert.deepEqual(gallery.integrity, {
    consumerFixtureFormat: consumerFixture.format,
    projectionSha256: consumerFixture.input.sha256,
    publicationQualificationGate: "npm run samples:verify",
    validation: {
      schemaPath: "samples/contract/v2/schemas/site-projection.schema.json",
      schemaValidated: true,
      sensitiveMetadataValidated: true,
    },
  });
  assert.throws(
    () => createGalleryModel({}),
    /gallery model requires a verified integrity token/,
  );
});

test("owns a deeply frozen projection snapshot across the verification and render boundary", async () => {
  const callerProjection = structuredClone(projection);
  const verifiedTitle = sampleById(callerProjection, "maplibre-quickstart").title;
  const integrity = await verifyGalleryProjectionIntegrity({
    projectionBytes: stableBytes(callerProjection),
    consumerFixture: fixtureForProjection(callerProjection),
  });

  assert.equal(Object.isFrozen(integrity), true);
  assert.notStrictEqual(integrity.projection, callerProjection);
  assertDeepFrozen(integrity.projection);
  assert.throws(() => {
    sampleById(integrity.projection, "maplibre-quickstart").title = "Forged frozen title";
  }, TypeError);

  sampleById(callerProjection, "maplibre-quickstart").title = "Forged caller title";
  callerProjection.samples.push({
    ...structuredClone(sampleById(callerProjection, "maplibre-quickstart")),
    id: "forged-after-verification",
  });

  const gallery = createGalleryModel(integrity);
  const html = renderGallery(gallery);
  assert.equal(gallery.cardCount, 30);
  assert.equal(
    galleryCards(gallery).find((card) => card.sample.id === "maplibre-quickstart").sample.title,
    verifiedTitle,
  );
  assert.doesNotMatch(html, /Forged caller title|forged-after-verification/);
});

test("deep-freezes and brands every rendered model claim", async () => {
  const gallery = await canonicalGallery();
  const cards = galleryCards(gallery);
  const endpointCard = cards.find((card) => card.sample.id === "maplibre-quickstart");
  const incidentCard = cards.find((card) => card.sample.id === "realtime-incident-dashboard");
  const replacementCard = cards.find((card) => card.sample.id === "web-components-basic");

  assertDeepFrozen(gallery);
  const mutations = [
    () => {
      gallery.integrity.projectionSha256 = "0".repeat(64);
    },
    () => {
      gallery.integrity.validation.sensitiveMetadataValidated = false;
    },
    () => {
      gallery.provenance.catalog.version = "forged";
    },
    () => {
      gallery.provenance.contract.executableSourceOwner = "foreign/fork";
    },
    () => {
      gallery.cardCount = 0;
    },
    () => {
      gallery.groups[0].title = "Forged group";
    },
    () => {
      endpointCard.sample.title = "Forged title";
    },
    () => {
      endpointCard.sample.summary = "Forged summary";
    },
    () => {
      endpointCard.sample.data.provenance = "Forged provenance";
    },
    () => {
      endpointCard.sample.evidence.fixture.status = "planned";
    },
    () => {
      endpointCard.sample.lifecycle.state = "retire";
    },
    () => {
      endpointCard.sample.source.docsPath = "../forged.md";
    },
    () => {
      endpointCard.sample.sdk.version = "forged";
    },
    () => {
      endpointCard.sample.capabilities[0] = "forged";
    },
    () => {
      endpointCard.sample.protocols[0] = "forged";
    },
    () => {
      endpointCard.sample.renderers[0] = "forged";
    },
    () => {
      endpointCard.sample.expectedDegradation = "Forged degradation";
    },
    () => {
      endpointCard.qualityProfile.description = "Forged profile";
    },
    () => {
      endpointCard.qualification.label = "Forged qualification";
    },
    () => {
      endpointCard.qualification.requiredGates[0] = "forged";
    },
    () => {
      endpointCard.searchText = "forged";
    },
    () => {
      incidentCard.journey.title = "Forged journey";
    },
    () => {
      replacementCard.replacement.url = "https://example.test/forged";
    },
    () => {
      gallery.filters.capabilities.push("forged");
    },
    () => {
      gallery.groups.push({ track: "golden", title: "Forged", cards: [] });
    },
  ];
  for (const mutate of mutations) assert.throws(mutate, TypeError);

  const forgedModel = structuredClone(gallery);
  forgedModel.groups[0].cards[0].sample.title = "Forged HTML with original SHA";
  assert.equal(forgedModel.integrity.projectionSha256, gallery.integrity.projectionSha256);
  assert.throws(
    () => renderGallery(forgedModel),
    /gallery rendering requires a verified gallery model/,
  );
});

test("rejects consumer digest, format, assertion, and stable-byte tampering", async () => {
  const digestMismatch = structuredClone(consumerFixture);
  digestMismatch.input.sha256 = "0".repeat(64);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        consumerFixture: digestMismatch,
      }),
    /consumer projection digest mismatch/,
  );

  const formatMismatch = structuredClone(consumerFixture);
  formatMismatch.accepts.projectionFormat = "honua.site.sdk-sample-projection.v1";
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        consumerFixture: formatMismatch,
      }),
    /accepted formats do not match/,
  );

  const fixtureFormatMismatch = structuredClone(consumerFixture);
  fixtureFormatMismatch.format = "honua.site.sdk-sample-consumer-fixture.v1";
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        consumerFixture: fixtureFormatMismatch,
      }),
    /consumer fixture format is not v2/,
  );

  const assertionMismatch = structuredClone(consumerFixture);
  assertionMismatch.assertions.sampleCount += 1;
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        consumerFixture: assertionMismatch,
      }),
    /consumer assertion sampleCount does not match/,
  );

  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: JSON.stringify(projection),
        consumerFixture,
      }),
    /projection bytes are not canonical stable JSON/,
  );
});

test("cannot mint a token for credential-bearing or schema-invalid canonical bytes", async () => {
  const credentialBearing = structuredClone(projection);
  sampleById(credentialBearing, "maplibre-quickstart").data.provenance =
    "https://data.example.test/features?access_token=actual-secret-value";
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(credentialBearing),
        consumerFixture: fixtureForProjection(credentialBearing),
      }),
    /forbidden credential query parameter access_token/,
  );

  const schemaInvalid = structuredClone(projection);
  delete sampleById(schemaInvalid, "maplibre-quickstart").title;
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(schemaInvalid),
        consumerFixture: fixtureForProjection(schemaInvalid),
      }),
    /JSON Schema validation failed.*title/,
  );

  const foreignRepository = structuredClone(projection);
  sampleById(foreignRepository, "maplibre-quickstart").source.repository = "honua-io/forked-sdk";
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(foreignRepository),
        consumerFixture: fixtureForProjection(foreignRepository),
      }),
    /JSON Schema validation failed.*repository/,
  );
});

test("fails closed on missing quality profiles and forged golden qualification relations", async () => {
  const missingProfile = structuredClone(projection);
  missingProfile.qualityProfiles = missingProfile.qualityProfiles.filter((profile) => profile.id !== "browser-recipe");
  await assert.rejects(
    () => verifiedGallery(missingProfile),
    /references missing quality profile browser-recipe/,
  );

  const forgedQualification = structuredClone(projection);
  const plannedJourney = forgedQualification.goldenJourneys.find((journey) => journey.status === "planned");
  assert.ok(plannedJourney, "the adversary requires a planned journey");
  plannedJourney.status = "qualified";
  await assert.rejects(
    () => verifiedGallery(forgedQualification),
    /qualified candidate is not a golden card/,
  );
});

test("rejects a schema-valid empty public portfolio with the explicit zero-card error", async () => {
  const emptyProjection = structuredClone(projection);
  emptyProjection.samples = [];

  await assert.rejects(() => verifiedGallery(emptyProjection), {
    name: "Error",
    message: "Gallery projection produced zero public cards; refusing to publish an empty gallery.",
  });
});

test("projects one canonical catalog-v2 sample into an honest public gallery card", async () => {
  const gallery = await canonicalGallery();
  const card = galleryCards(gallery).find((candidate) => candidate.sample.id === "maplibre-quickstart");
  assert.deepEqual(card.sample, sampleById(projection, "maplibre-quickstart"));
  assert.equal(card.journey.id, "first-map");
  assert.equal(card.replacement, null);
  assert.deepEqual(gallery.provenance, {
    projection: {
      format: projection.format,
      schemaVersion: projection.schemaVersion,
    },
    catalog: projection.catalog,
    contract: projection.contract,
  });
  assert.ok(gallery.filters.capabilities.includes("direct-connect"));
  assert.ok(gallery.filters.protocols.includes("geoservices"));
});

test("projects the canonical public portfolio without hiding lifecycle or replacement truth", async () => {
  const gallery = await canonicalGallery();
  const counts = Object.fromEntries(gallery.groups.map((group) => [group.track, group.cards.length]));
  const cards = galleryCards(gallery);
  const byId = new Map(cards.map((card) => [card.sample.id, card]));

  assert.equal(gallery.cardCount, 30);
  assert.deepEqual(counts, { golden: 1, recipe: 12, lab: 17 });
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
  const imageryCard = byId.get("imagery-cog-quickstart");
  assert.equal(imageryCard.sample.lifecycle.state, "active");
  assert.equal(imageryCard.qualification.state, "planned-golden-candidate");
  assert.match(imageryCard.qualification.label, /not receipt-qualified/u);
  assert.deepEqual(imageryCard.qualification.requiredGates, [
    "packedBuild",
    "browser",
    "accessibility",
    "console",
    "responsive",
    "screenshot",
    "performance",
    "liveEvidence",
  ]);
  assert.equal(imageryCard.sample.evidence.live.mode, "public-live");
  assert.equal(imageryCard.sample.evidence.live.status, "planned");
  const firstMapCard = byId.get("maplibre-quickstart");
  assert.equal(firstMapCard.qualification.state, "receipt-qualified-golden");
  assert.equal(firstMapCard.qualification.label, "Receipt-qualified golden journey");
  assert.ok(
    cards
      .filter((card) => card.sample.id !== "maplibre-quickstart")
      .every((card) => card.qualification.label.includes("not receipt-qualified")),
  );
  assert.deepEqual(firstMapCard.qualification.requiredGates, [
    "packedBuild",
    "browser",
    "accessibility",
    "console",
    "responsive",
    "screenshot",
    "performance",
    "liveEvidence",
  ]);
});

test("sorts public capability and protocol facets deterministically", async () => {
  const gallery = await canonicalGallery();
  const capabilities = galleryCards(gallery).flatMap((card) => card.sample.capabilities);
  const protocols = galleryCards(gallery).flatMap((card) => card.sample.protocols);

  assert.deepEqual(gallery.filters.capabilities, [...new Set(capabilities)].sort());
  assert.deepEqual(gallery.filters.protocols, [...new Set(protocols)].sort());
  assert.ok(!gallery.filters.capabilities.includes("interaction-state"));
});

test("renders accessible controls, compact essentials, and disclosed catalog truth", async () => {
  const incidentSample = sampleById(projection, "realtime-incident-dashboard");
  const gallery = await canonicalGallery();
  const html = renderGallery(gallery);

  for (const label of [
    "SDK",
    "Data",
    "Evidence state",
    "Qualification",
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
    "Quality profile",
    "Required gates",
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
  assert.ok(html.includes(gallery.provenance.catalog.version));
  assert.match(html, /honua\.sdk\.sample-catalog\.v2/);
  assert.match(html, /honua\.site\.sdk-sample-projection\.v2/);
  assert.match(html, /honua-io\/honua-sdk-js#540/);
  assert.match(html, /Fixture: <strong>executed<\/strong>/);
  assert.match(html, /unavailable<\/code> · <strong>skipped<\/strong>/);
  assert.match(html, /evidence expires <time/);
  assert.ok(html.includes(incidentSample.evidence.live.expiresAt));
  assert.match(html, /Realtime Incident Operations/);
  assert.match(html, /Planned golden candidate · not receipt-qualified/);
  assert.match(html, /Publication runs <code>npm run samples:verify<\/code>/);
  assert.match(html, /validates the complete receipt/);
  assert.match(html, /profile gates alone are only requirements/);
  assert.match(html, /safe-editing/);
  assert.match(html, /maplibre/);
  assert.match(html, /<summary>Evidence, provenance, lifecycle, and degradation<\/summary>/);
  assert.doesNotMatch(html, /<script|\son[a-z]+=/i);
});

test("renders global provenance once and puts every card CTA before its disclosure", async () => {
  const html = renderGallery(await canonicalGallery());
  const cards = [...html.matchAll(/<article class="demo-card[\s\S]*?<\/article>/g)].map((match) => match[0]);

  assert.equal(occurrenceCount(html, /data-gallery-provenance/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Catalog<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Projection<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Contract<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Consumer fixture<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Projection SHA-256<\/dt>/g), 1);
  assert.ok(html.includes(consumerFixture.format));
  assert.ok(html.includes(consumerFixture.input.sha256));
  assert.equal(cards.length, 30);
  for (const card of cards) {
    const ctaIndex = card.indexOf('<a class="demo-link"');
    const detailsIndex = card.indexOf('<details class="demo-card-details">');
    assert.doesNotMatch(card, /<dt>(?:Catalog|Projection|Contract)<\/dt>/);
    assert.ok(ctaIndex >= 0 && detailsIndex > ctaIndex);
    assert.match(card, /<summary>Evidence, provenance, lifecycle, and degradation<\/summary>/);
  }
});

test("requires an ownership-bound source resolver and rejects unsafe or foreign URLs", async () => {
  const gallery = await canonicalGallery();
  assert.throws(
    () => renderGalleryContent(gallery),
    /requires an explicit source-link resolver/,
  );

  const unsafeUrls = [
    "javascript:alert(1)",
    "http://example.test/source",
    "//example.test/source",
    "https://user:password@example.test/source",
    "https://example.test/source?token=secret",
    "https://example.test/source#access-token",
    " https://example.test/source",
    "guides/\u0000bad.html",
    "guides\\bad.html",
    "../secrets.txt",
    "guides/../secrets.txt",
    "guides/%2e%2e/secrets.txt",
    "guides/%252e%252e/secrets.txt",
    "guides/%255csecrets.txt",
    "/absolute/source.html",
    "https://cross-origin.example/source",
    "https://github.com/honua-io/forked-sdk/blob/trunk/examples/ai-spatial-app-builder/README.md",
    "https://github.com/honua-io/honua-sdk-js/blob/trunk/examples/wrong/README.md",
    "https://github.com/honua-io/honua-sdk-js/blob/trunk/examples/./ai-spatial-app-builder/README.md",
    "https://github.com/honua-io/honua-sdk-js/blob/trunk/examples/%2e%2e/secret.md",
  ];
  for (const href of unsafeUrls) {
    assert.throws(
      () => renderGallery(gallery, () => ({ href, kind: "source" })),
      /source resolver does not match canonical source ownership/,
      href,
    );
  }
  assert.throws(
    () => renderGallery(gallery, () => ({ href: "guides/quickstart.html", kind: "unknown" })),
    /source resolver kind is unsupported/,
  );
  assert.throws(
    () => renderGallery(gallery, () => ({ href: "guides/quickstart.html", kind: "guide", extra: true })),
    /source resolver result keys must match/,
  );
  assert.throws(
    () => renderGallery(gallery, () => ({ href: "guides/quickstart.html", kind: "guide" })),
    /classified a non-guide docsPath as a guide/,
  );

  const html = renderGallery(gallery);
  assert.match(
    html,
    /href="https:\/\/github\.com\/honua-io\/honua-sdk-js\/blob\/trunk\/examples\/ai-spatial-app-builder\/README\.md">View source/,
  );
  assert.match(
    html,
    /href="guides\/examples\/cesium-route-playback\/README\.html">Read the walkthrough/,
  );
});

test("rejects unsafe public source paths before minting a model or invoking a resolver", async () => {
  const unsafeSources = [
    { field: "docsPath", value: "../secret.md", expected: /source docsPath is unsafe/ },
    { field: "docsPath", value: "examples/%2e%2e/secret.md", expected: /source docsPath is unsafe/ },
    { field: "docsPath", value: "examples/%255csecret.md", expected: /source docsPath is unsafe/ },
    { field: "path", value: "../examples/ai-spatial-app-builder", expected: /source path is unsafe/ },
  ];
  for (const { field, value, expected } of unsafeSources) {
    const unsafeProjection = structuredClone(projection);
    sampleById(unsafeProjection, "ai-spatial-app-builder").source[field] = value;
    let resolverCallCount = 0;
    await assert.rejects(
      async () => {
        const gallery = await verifiedGallery(unsafeProjection);
        renderGallery(gallery, (sample) => {
          resolverCallCount += 1;
          return repositorySourceResolver(sample);
        });
      },
      expected,
    );
    assert.equal(resolverCallCount, 0);
  }
});

test("escapes projected content and links only credential-free HTTPS replacements", async () => {
  for (const url of ["javascript:alert(1)", "http://example.test/replacement"]) {
    const unsafe = structuredClone(projection);
    const sample = sampleById(unsafe, "web-components-basic");
    sample.title = '<img src=x onerror="alert(1)">';
    sample.data.provenance = '</dd><script>alert("x")</script>';
    unsafe.externalReplacements[0].url = url;
    const html = renderGallery(await verifiedGallery(unsafe));

    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;\/dd&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<img|<script|href="(?:javascript:|http:|https:\/\/user:)/i);
    assert.match(html, /external: @honua\/app-platform \(honua-app-platform\)/);
  }

  const safeHtml = renderGallery(await canonicalGallery());
  assert.match(
    safeHtml,
    /href="https:\/\/www\.npmjs\.com\/package\/@honua\/app-platform" rel="noopener noreferrer"/,
  );
});

test("filters task text with AND semantics and combines exact capability and protocol facets", async () => {
  const records = galleryCards(await canonicalGallery()).map((card) => ({
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

test("initializes accessible DOM filtering, implicit Enter submit, empty, and clear behavior", async () => {
  const dom = new JSDOM(renderGallery(await canonicalGallery()), {
    url: "https://docs.example.test/gallery.html",
  });
  const { document, Event } = dom.window;
  initializeGallery(document);

  const form = document.querySelector("[data-gallery-controls]");
  const search = form.querySelector("[data-gallery-search]");
  const capability = form.querySelector("[data-gallery-capability]");
  const protocol = form.querySelector("[data-gallery-protocol]");
  const clear = form.querySelector("[data-gallery-clear]");
  const count = document.querySelector("[data-gallery-result-count]");
  const empty = document.querySelector("[data-gallery-empty]");
  const groups = [...document.querySelectorAll("[data-gallery-group]")];

  assert.equal(count.textContent, "30");
  assert.equal(clear.disabled, true);
  assert.equal(empty.hidden, true);

  search.value = "realtime guarded";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(count.textContent, "1");
  assert.deepEqual(
    [...document.querySelectorAll("[data-gallery-card]:not([hidden])")].map((card) => card.dataset.sampleId),
    ["realtime-incident-dashboard"],
  );
  assert.equal(document.querySelector("#gallery-recipe").closest("[data-gallery-group]").hidden, true);
  assert.equal(document.querySelector("#gallery-lab").closest("[data-gallery-group]").hidden, false);

  search.value = "";
  capability.value = "safe-editing";
  protocol.value = "sse";
  capability.dispatchEvent(new Event("change", { bubbles: true }));
  protocol.dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(count.textContent, "1");

  protocol.value = "stac";
  protocol.dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(count.textContent, "0");
  assert.equal(empty.hidden, false);
  assert.ok(groups.every((group) => group.hidden));

  capability.value = "";
  protocol.value = "";
  search.value = "maplibre-quickstart endpoint inspected";
  let submitWasPrevented = false;
  form.addEventListener("submit", (event) => {
    submitWasPrevented = event.defaultPrevented;
  });
  // requestSubmit follows the form submit path used by implicit Enter on the
  // search input without depending on JSDOM's incomplete keyboard defaults.
  form.requestSubmit();
  assert.equal(submitWasPrevented, true);
  assert.equal(count.textContent, "1");

  clear.click();
  assert.equal(search.value, "");
  assert.equal(capability.value, "");
  assert.equal(protocol.value, "");
  assert.equal(count.textContent, "30");
  assert.equal(empty.hidden, true);
  assert.ok(groups.every((group) => !group.hidden));
  assert.equal(document.activeElement, search);
  dom.window.close();
});
