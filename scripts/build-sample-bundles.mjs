#!/usr/bin/env node

/**
 * Build reproducible static browser bundles for the browser-embeddable sample
 * gallery entries (issue #642, completing #401 REQ-003's publication leg;
 * eligibility audited across the whole catalog by #656).
 *
 * Every `samples/catalog.v2.json` entry gets exactly one decision. The
 * eligibility audit lives here as data plus a deterministic verifier:
 * `SAMPLE_BUNDLE_AUDIT` records the one dimension that cannot be derived (a
 * sample's `runtimeHosting` — where its default build gets its data) with the
 * source location establishing it, `evaluateSampleBundleEligibility` combines
 * that with the catalog's own lifecycle / support-tier / configuration /
 * browser-secret truth to publish or to emit a machine-readable exclusion
 * category, and `verifySampleBundleAudit` checks every structural consequence
 * against the tree. `INCLUDED_SAMPLES` and `EXCLUDED_SAMPLES` are *derived*
 * from that single decision list, so neither can drift from the other.
 *
 * Each published entry builds through its existing `npm run demo:<x>:build`
 * Vite production build with every `VITE_*` environment variable stripped
 * first, so the emitted bundle only ever reflects the sample's own committed
 * default (no live override, no secret can leak in). The built
 * `examples/<id>/dist/` output is copied into `.artifacts/sample-bundles/<id>/`
 * (gitignored, so nothing this script writes is committed) and a
 * `honua.sdk.sample-bundles.v2` manifest is written describing every sample's
 * entrypoint, per-file SHA-256 / SRI integrity, declared config surface, data
 * mode, support/lifecycle truth, runnability plus any host fixture-route
 * prerequisites, and the exact commit / package version it was built from.
 *
 * Publication (workflow artifact + GitHub Release asset) happens in CI
 * (.github/workflows/ci.yml `sample-bundles-release` job); see
 * docs/sample-bundles.md for the consumer contract.
 *
 * Run with:
 *   npm run samples:bundles:build   # build + write the manifest
 *   npm run samples:bundles:verify  # re-hash an existing manifest + files
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runNpmSync } from "./lib/npm-cli.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
// NOTE: NOT under dist/ — that tree is owned by the prepared-SDK artifact
// snapshot (scripts/lib/prepared-sdk-artifact.mjs); foreign files there break
// its digest verification in every downstream test step.
const OUTPUT_ROOT = path.join(PROJECT_ROOT, ".artifacts", "sample-bundles");
// The manifest filename carries its own format version (the repo convention —
// cf. samples/dist/sample-ci-selection.v2.json), so a v2 cutover publishes a
// distinct asset rather than silently changing v1's shape under consumers.
const MANIFEST_PATH = path.join(OUTPUT_ROOT, "sample-bundles.v2.json");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "samples/contract/v2/schemas/sample-bundles.schema.json");

/**
 * How a sample's *default* build (every `VITE_*` variable stripped) obtains
 * the data it renders — the dimension that actually decides whether a static
 * browser bundle can honestly run (#656 REQ-001). Each value is a
 * hand-audited claim about committed sample source; `SAMPLE_BUNDLE_AUDIT`
 * records the exact source location that establishes it, and
 * `verifySampleBundleAudit` machine-checks every structural consequence.
 *
 *  - `self-contained`: every request the default build issues resolves to a
 *    file inside the built bundle (a bundled module, or a `public/` asset
 *    addressed relative to the document). Opens and runs on any static host.
 *  - `same-origin-fixture-service`: the default build issues same-origin
 *    requests to deterministic fixture routes that are *not* in the bundle
 *    (the sample's `mock-server.mjs` defines them). Fixture-safe and
 *    credential-free, but only runnable where the embedding host serves the
 *    declared `hostFixtureRoutes`.
 *  - `external-live-endpoint`: the default resolves to an off-bundle live
 *    endpoint, so the bundle's behaviour is neither offline nor deterministic.
 *  - `companion-process`: needs its own running server process (e.g. a mock
 *    identity provider) as a participant in the flow, not merely as a data
 *    origin.
 *  - `server-side-app`: not a browser app at all (no Vite config).
 *  - `not-a-runtime-sample`: a docs snippet or codemod test input, not a
 *    Honua-runtime Vite package.
 */
export const RUNTIME_HOSTING_KINDS = [
  "self-contained",
  "same-origin-fixture-service",
  "external-live-endpoint",
  "companion-process",
  "server-side-app",
  "not-a-runtime-sample",
];

/** Hosting kinds that are generically safe for public gallery publication. */
export const PUBLISHABLE_RUNTIME_HOSTING = new Set(["self-contained", "same-origin-fixture-service"]);

/**
 * The published bundle's runnability truth, derived 1:1 from
 * `runtimeHosting` and carried in the manifest + site projection so a gallery
 * card can never imply a bundle runs standalone when it does not (#656
 * REQ-005, acceptance criterion 3).
 */
export const RUNNABILITY_BY_HOSTING = new Map([
  ["self-contained", "standalone"],
  ["same-origin-fixture-service", "requires-host-fixture-service"],
  ["external-live-endpoint", "requires-live-endpoint"],
]);

/**
 * The only live-backed bundles admitted to publication. This is deliberately
 * keyed by literal sample id rather than by hosting kind: every other
 * `external-live-endpoint` remains excluded. Each exception binds the browser
 * allowlist and the semantic live smoke to one exact HTTPS origin.
 */
export const PUBLISHED_LIVE_SAMPLE_POLICY = new Map([
  [
    "maplibre-quickstart",
    {
      allowedOrigins: ["https://demo.honua.io"],
      semanticProbe: {
        url: "https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1/query?where=id%20%3C%3D%2025&outFields=*&returnGeometry=true&f=geojson",
        kind: "geojson-feature-collection",
        minimumFeatures: 1,
      },
    },
  ],
  [
    "service-explorer",
    {
      allowedOrigins: ["https://demo.pygeoapi.io"],
      semanticProbe: {
        url: "https://demo.pygeoapi.io/master/collections/lakes/items?limit=1&f=json",
        kind: "geojson-feature-collection",
        minimumFeatures: 1,
      },
    },
  ],
]);

/**
 * Hosting kinds that are structural (there is no browser bundle to build at
 * all) and are therefore evaluated *before* the catalog's support-tier and
 * configuration gates: "this is not an embeddable browser app" is the more
 * fundamental truth than "its support tier is internal".
 */
const STRUCTURAL_HOSTING_KINDS = new Set(["server-side-app", "not-a-runtime-sample"]);

/** `runtimeHosting` -> exclusion category, for every non-publishable kind. */
const HOSTING_EXCLUSION = new Map([
  ["server-side-app", { category: "non-browser-app", detail: "Not a browser app: no Vite config and no browser renderer." }],
  [
    "not-a-runtime-sample",
    {
      category: "non-runtime-sample",
      detail: "Not a Honua-runtime Vite package: a documentation snippet or migration-codemod test input.",
    },
  ],
  [
    "external-live-endpoint",
    {
      category: "requires-live-backend",
      detail: "The default build resolves to an off-bundle live endpoint, so a published bundle would be neither offline nor deterministic.",
    },
  ],
  [
    "companion-process",
    {
      category: "requires-companion-server",
      detail: "The default flow needs its own running companion server process at runtime, not just a data origin.",
    },
  ],
]);

/**
 * Catalog support tiers a public gallery bundle may never claim (#656
 * REQ-001): `internal` is repository-facing plumbing and `deprecated` is on
 * its way out, so neither should gain a new public runnable surface.
 */
export const INELIGIBLE_SUPPORT_TIERS = new Set(["internal", "deprecated"]);

/**
 * Machine-readable exclusion reason categories (#656 REQ-004). Kept in sync
 * with `samples/contract/v2/schemas/sample-bundles.schema.json`'s
 * `excludedSample.category` enum and `site-projection.schema.json`'s mirror —
 * `test/scripts/build-sample-bundles.test.mjs` asserts the three never drift
 * apart.
 *
 * `needs-prepare-step`, `replay-mode-undecided`, `agent-shaped`, and
 * `audit-pending` are retained but currently unused: the first three were
 * superseded by an audited `runtimeHosting` verdict, and `audit-pending` is
 * the deliberate escape hatch for a newly-promoted active sample whose audit
 * has not been performed yet.
 */
export const EXCLUDED_SAMPLE_CATEGORIES = [
  "needs-prepare-step",
  "requires-api-key",
  "requires-live-backend",
  "requires-companion-server",
  "replay-mode-undecided",
  "agent-shaped",
  "non-browser-app",
  "non-runtime-sample",
  "lifecycle-not-active",
  "legacy-unsafe-configuration",
  "unsupported-support-tier",
  "audit-pending",
];

/**
 * The REQ-001 eligibility audit, encoded as data (#656). One record per
 * `lifecycle.state: "active"` catalog entry — every *non*-active entry is
 * mechanically excluded from the catalog's own lifecycle truth by
 * `deriveSampleBundleDecisions` and deliberately has no record here, so a
 * catalog promotion forces a new audited decision rather than inheriting a
 * guess.
 *
 * A record declares only what cannot be derived from
 * `samples/catalog.v2.json` or from disk:
 *  - `runtimeHosting` — the audited data-origin verdict (see above);
 *  - `hostFixtureRoutes` — for `same-origin-fixture-service` only, the
 *    same-origin path prefixes the embedding host must serve;
 *  - `buildScript` — the existing `npm run demo:<x>:build` entry to reuse;
 *  - `auditedVia` — the committed source location that establishes
 *    `runtimeHosting`, so a reviewer can re-derive the claim and a reader of
 *    the projected reason is told *why*, not just *that*.
 *
 * Everything else the audit covers is read from the catalog and enforced by
 * `evaluateSampleBundleEligibility`: lifecycle state, support tier,
 * configuration classification (`configurationStatus`), the browser-secret
 * policy (`configClassifications` exposure/valueKind), and data mode.
 */
export const SAMPLE_BUNDLE_AUDIT = [
  {
    id: "coverages-wcs-basic",
    runtimeHosting: "self-contained",
    buildScript: "demo:coverages-wcs:build",
    auditedVia:
      "examples/coverages-wcs-basic/src/main.ts injects ./pinned-fixtures.js as HonuaClient.fetchFn; that bundled module answers OGC API Coverages and WCS metadata plus coverage requests from in-memory JSON/XML/PNG fixtures, so the default build issues no network request.",
  },
  {
    id: "ai-spatial-app-builder",
    runtimeHosting: "self-contained",
    buildScript: "demo:ai-spatial-builder:build",
    auditedVia:
      "examples/ai-spatial-app-builder/src/main.ts imports only ./safe-agent.js and issues no fetch/EventSource/WebSocket; both declared config names are catalog-classified server-only, so no host-model lane can be enabled from a browser bundle and the deterministic fixture proposal is the only reachable path.",
  },
  {
    id: "arcgis-source-app",
    runtimeHosting: "not-a-runtime-sample",
    auditedVia:
      "examples/arcgis-source-app has no vite.config.ts; it is the pre-migration ArcGIS input consumed by npm run test:migration:real-samples (catalog validationProfile internal-fixture).",
  },
  {
    id: "automatic-source-workflow",
    runtimeHosting: "not-a-runtime-sample",
    auditedVia:
      "docs/examples/automatic-source-workflow has no vite.config.ts; it is a documentation snippet (plain script/CDN pattern) exercised by a Playwright spec.",
  },
  {
    id: "geocoding-quickstart",
    runtimeHosting: "self-contained",
    buildScript: "demo:geocoding:build",
    auditedVia:
      "examples/geocoding-quickstart/src/config.ts fixes the default SDK baseUrl to the bundle-relative '.' origin, and examples/geocoding-quickstart/public/rest/services/World/GeocodeServer/findAddressCandidates ships the exact extensionless response path requested by HonuaGeocodingClient.forwardGeocode; the catalog exposes no browser configuration or credential lane.",
  },
  {
    id: "imagery-cog-quickstart",
    runtimeHosting: "same-origin-fixture-service",
    buildScript: "demo:imagery-cog:build",
    hostFixtureRoutes: [
      "/api/v1/terrain/OahuTerrain/elevation/value",
      // The whole `/fixtures/cog/` prefix, not just `item.json`: the item's
      // STAC assets carry relative hrefs (`./assets/<key>`) that the SDK's
      // stac-static inspection resolves against the item URL, so the bundle
      // then requests `/fixtures/cog/assets/<key>`. Declaring only the item
      // route left a host provisioning exactly the stated prerequisites
      // 404ing on every asset read.
      "/fixtures/cog/",
      "/fixtures/imagery/cog/",
      "/rest/services/OahuCog/ImageServer",
      "/rest/services/OahuImagery/MapServer/WMS",
      "/rest/services/OahuTerrain/ImageServer",
      "/stac/search",
    ],
    auditedVia:
      "examples/imagery-cog-quickstart/src/config.ts resolveImageryCogConfig: with VITE_HONUA_IMAGERY_BASE_URL unset it resolves mode \"fixture-safe\" against the document origin, and normalizeBaseUrl rejects any cross-origin, query-bearing, or credential-bearing override, so the bundle can only ever address the same-origin fixture routes in examples/imagery-cog-quickstart/mock-server.mjs.",
  },
  {
    id: "maplibre-quickstart",
    runtimeHosting: "external-live-endpoint",
    buildScript: "demo:quickstart:build",
    auditedVia:
      "scripts/build-sample-bundles.mjs sampleBuildEnv and PUBLISHED_LIVE_SAMPLE_POLICY: the published bundle receives the exact https://demo.honua.io FeatureServer endpoint and a same-bundle basemap while ambient browser configuration remains stripped; the source app keeps its deterministic same-origin fixture default.",
  },
  {
    id: "migration-workbench",
    runtimeHosting: "self-contained",
    buildScript: "demo:migration-workbench:build",
    auditedVia:
      "examples/migration-workbench/src/artifacts.ts addresses only bundle-relative public/artifacts/v1/*.json, which Vite's publicDir passthrough copies into dist (and examples/_kit/vite.config.ts's closeBundle hashes as declared bundle output).",
  },
  {
    id: "nl-map-control",
    runtimeHosting: "self-contained",
    buildScript: "demo:nl-map-control:build",
    auditedVia:
      "examples/nl-map-control/src/main.ts imports test/fixtures/nl-map-control/recorded-completions.json as a bundled module and mounts an inline MapLibre style; the sample issues no fetch.",
  },
  {
    id: "columnar-query-quickstart",
    runtimeHosting: "self-contained",
    buildScript: "demo:columnar-query:build",
    auditedVia:
      "examples/columnar-query-quickstart/src/fixture.ts embeds the exact 1,336-byte Honua Server Arrow response as base64; src/workflow.ts feeds those bytes through its injected fetchFn into createApacheArrowResponseDecoder with apache-arrow bundled by Vite, so session.stream() executes entirely in memory and issues no off-origin request.",
  },
  {
    id: "node-backend-quickstart",
    runtimeHosting: "server-side-app",
    auditedVia:
      "examples/node-backend-quickstart has no vite.config.ts; the catalog declares renderers [none], validationProfile headless-recipe, and an entirely server-only config surface including API-key and service-account credentials.",
  },
  {
    id: "oauth-signin",
    runtimeHosting: "companion-process",
    buildScript: "demo:oauth-signin:build",
    auditedVia:
      "examples/oauth-signin/mock-server.mjs is a mock OAuth identity provider the sample redirects to and exchanges codes against at runtime (catalog data.authMode oauth); the flow needs a live participant process, not a static data origin.",
  },
  {
    id: "offline-region-reference",
    runtimeHosting: "not-a-runtime-sample",
    auditedVia:
      "docs/examples/offline-region-reference has no vite.config.ts; it is a bounded documentation reference exercised by test/playwright/offline-indexeddb.spec.mjs with an isolated loopback fixture origin.",
  },
  {
    id: "overture-geoparquet",
    runtimeHosting: "self-contained",
    // `demo:overture:build` orchestrates the pinned-extension prepare step
    // (`prepare-duckdb-extension.mjs`: cache-hit when warm, otherwise fetched
    // and validated against `PARQUET_EXTENSION_PROVENANCE` by SHA-256, byte
    // length, and WebAssembly magic) ahead of the Vite build, so reusing the
    // existing npm script chain needs no bespoke orchestration here. The
    // emitted bundle is far larger than every other published sample (it
    // self-hosts the duckdb-wasm main module, worker, and the ~3 MB pinned
    // Parquet extension under `duckdb/`); see docs/sample-bundles.md.
    buildScript: "demo:overture:build",
    auditedVia:
      "examples/overture-geoparquet/src/main.ts fetches only distributionUrl(\"overture-places.parquet\"), resolved bundle-relative from import.meta.url; the Overture S3 and STAC URLs in src/source-manifests.ts are displayed provenance strings that are never fetched.",
  },
  {
    id: "planning-permitting-workbench",
    runtimeHosting: "same-origin-fixture-service",
    buildScript: "demo:planning-workbench:build",
    hostFixtureRoutes: ["/rest/services/Maui/Planning/FeatureServer"],
    auditedVia:
      "examples/planning-permitting-workbench/src/main.ts passes baseUrl: window.location.origin into the journey, which addresses `${baseUrl}/rest/services/Maui/Planning/FeatureServer/{0,1}` (src/journey.ts PLANNING_SERVICE_PATH); normalizeFixtureOrigin rejects any non-origin or credential-bearing base, and the catalog declares no config surface at all (configurationStatus not-required, authMode none).",
  },
  {
    id: "pmtiles-static",
    runtimeHosting: "self-contained",
    buildScript: "demo:pmtiles-static:build",
    auditedVia:
      "examples/pmtiles-static/src/main.ts resolves basemap.pmtiles relative to window.location.href from the sample's committed public/ asset; the HonuaClient it constructs over the document origin issues no request in the default lane.",
  },
  {
    id: "react-quickstart",
    runtimeHosting: "same-origin-fixture-service",
    buildScript: "demo:react-quickstart:build",
    hostFixtureRoutes: ["/api/v1/admin/capabilities", "/rest/services/natural-earth/FeatureServer/0"],
    auditedVia:
      "examples/react-quickstart/src/config.ts defaults baseUrl to \"\" (the document origin) with serviceId natural-earth and layerId 0; no VITE_HONUA_REACT_* name is catalog-classified as a credential and examples/react-quickstart/mock-server.mjs asserts no authorization header, so the catalog's api-key authMode describes the live lane a bundle cannot reach rather than a browser secret.",
  },
  {
    id: "realtime-incident-dashboard",
    runtimeHosting: "self-contained",
    buildScript: "demo:incident:build",
    auditedVia:
      "examples/realtime-incident-dashboard/src/realtime-transport.ts readIncidentTransportConfig: on hosted (non-localhost) origins `transport=replay` defaults when no explicit override exists, so the sample uses the built-in fixture transport by default and does not require a same-origin mock service for the gallery bundle.",
  },
  {
    id: "service-explorer",
    runtimeHosting: "external-live-endpoint",
    buildScript: "demo:service-explorer:build",
    auditedVia:
      "examples/service-explorer/src/main.ts and PUBLISHED_LIVE_SAMPLE_POLICY: hosted (non-localhost) origins default endpoint/source to the exact https://demo.pygeoapi.io origin plus master/lakes; localhost remains fixture-relative for deterministic source tests.",
  },
  {
    id: "shared-renderer-state",
    runtimeHosting: "not-a-runtime-sample",
    auditedVia:
      "docs/examples/shared-renderer-state has no vite.config.ts; it is a documentation snippet exercised by test/playwright/shared-renderer-state.spec.mjs.",
  },
  {
    id: "sketch-editing",
    runtimeHosting: "self-contained",
    buildScript: "demo:sketch-editing:build",
    auditedVia:
      "examples/sketch-editing/src/main.ts mounts an inline MapLibre style over FIXTURE_PARCELS from the bundled ./fixture-source.js module; the sample issues no fetch.",
  },
  {
    id: "stac-imagery-browser",
    runtimeHosting: "self-contained",
    buildScript: "demo:stac-browser:build",
    auditedVia:
      "examples/stac-imagery-browser/src/** issues no fetch/EventSource/WebSocket; its STAC fixtures are imported as bundled modules.",
  },
  {
    id: "temporal-playback",
    runtimeHosting: "self-contained",
    buildScript: "demo:temporal-playback:build",
    auditedVia:
      "examples/temporal-playback/src/main.ts mounts an inline MapLibre style over in-module fixture frames; the sample issues no fetch.",
  },
];

/**
 * Product assertions that the pure-static published bundle smoke must prove.
 * These are kept beside the hosting audit so a self-contained verdict cannot
 * outlive the map/data behavior that made the sample publishable.
 */
export const SAMPLE_BUNDLE_STATIC_SMOKE_JOURNEYS = new Map([
  [
    "columnar-query-quickstart",
    {
      state: "__HONUA_COLUMNAR_QUERY_QUICKSTART__",
      readyField: "ready",
      resultSelector: "#map-state",
      resultAttribute: "data-state",
      resultValue: "ready",
      canvasSelector: ".maplibregl-canvas",
      sourceFeatureCountMethod: "sourceFeatureCount",
      markerSelector: ".maplibregl-marker",
    },
  ],
]);

/**
 * Whether a same-origin request path is satisfied by a bundle's declared
 * `hostFixtureRoutes`. A declared route matches its own exact path and
 * everything beneath it as a path-segment prefix, so `/fixtures/cog/` covers
 * `/fixtures/cog/assets/x` and `/rest/services/OahuCog/ImageServer` covers
 * `.../ImageServer/exportImage`, while `/fixtures/cog` never covers an
 * unrelated `/fixtures/cognition`. This is the semantics an embedding host has
 * to implement, so it is part of the contract rather than a test detail.
 */
export function routeCoveredByHostFixtureRoutes(requestPath, routes) {
  return routes.some((route) => {
    if (requestPath === route) return true;
    const prefix = route.endsWith("/") ? route : `${route}/`;
    return requestPath.startsWith(prefix);
  });
}

/**
 * The config names that actually reach a browser build, which is the only
 * surface a published bundle's `configDefaults` may describe.
 *
 * `data.config` is the sample's *whole* declared configuration surface and
 * mixes in server-only settings (`ai-spatial-app-builder`'s
 * `HONUA_AGENT_HOST_URL` / `HONUA_LIVE_DATA_URL`, `service-explorer`'s live
 * toggle). Deriving `configDefaults` from it published those names in a field
 * the schema and docs define as the browser-public surface, overstating what a
 * consumer can influence and leaking backend topology into a public artifact.
 * `configClassifications` is the catalog's authoritative exposure verdict, so
 * filter on it and fail closed on anything unclassified.
 */
export function browserPublicConfigNames(catalogEntry) {
  const classifications = catalogEntry.data.configClassifications ?? [];
  const classified = new Set(classifications.map((entry) => entry.name));
  for (const name of catalogEntry.data.config ?? []) {
    invariant(
      classified.has(name),
      `${catalogEntry.id}: declared config name "${name}" has no configClassifications entry, so its browser exposure is unknown`,
    );
  }
  return classifications
    .filter((entry) => entry.exposure === "browser-public")
    .map((entry) => entry.name)
    .sort();
}

/**
 * Config names the catalog classifies as reaching the browser *and* holding a
 * credential — the browser-secret policy leg of the REQ-001 audit. A sample
 * with any of these can never publish a static bundle, because the bundle
 * either embeds the secret or silently fails.
 */
export function browserExposedCredentials(catalogEntry) {
  return (catalogEntry.data.configClassifications ?? [])
    .filter((entry) => entry.exposure === "browser-public" && entry.valueKind === "credential")
    .map((entry) => entry.name)
    .sort();
}

/**
 * The publication policy (#656 REQ-002/REQ-003): a pure function from an
 * *active* catalog entry plus its audit record to a publish decision or an
 * ordered list of blockers. The first blocker supplies the machine-readable
 * exclusion `category`; every blocker's detail plus the audit record's
 * `auditedVia` compose the projected `reason`, so the reason can never drift
 * from the decision that produced it.
 */
export function evaluateSampleBundleEligibility(catalogEntry, auditRecord) {
  invariant(catalogEntry, "evaluateSampleBundleEligibility requires a catalog entry");
  invariant(auditRecord, `${catalogEntry.id}: evaluateSampleBundleEligibility requires an audit record`);
  invariant(
    RUNTIME_HOSTING_KINDS.includes(auditRecord.runtimeHosting),
    `${catalogEntry.id}: unknown runtimeHosting "${auditRecord.runtimeHosting}"`,
  );
  invariant(
    typeof auditRecord.auditedVia === "string" && auditRecord.auditedVia.length > 0,
    `${catalogEntry.id}: audit record must record auditedVia (the source location establishing runtimeHosting)`,
  );
  invariant(
    catalogEntry.lifecycle.state === "active",
    `${catalogEntry.id}: SAMPLE_BUNDLE_AUDIT records are only for active catalog entries but lifecycle.state is "${catalogEntry.lifecycle.state}" -- drop the record so the mechanical lifecycle-not-active exclusion applies`,
  );

  const blockers = [];
  const hosting = auditRecord.runtimeHosting;
  const publishedLivePolicy =
    hosting === "external-live-endpoint" ? PUBLISHED_LIVE_SAMPLE_POLICY.get(catalogEntry.id) : undefined;

  if (STRUCTURAL_HOSTING_KINDS.has(hosting)) blockers.push(HOSTING_EXCLUSION.get(hosting));
  if (INELIGIBLE_SUPPORT_TIERS.has(catalogEntry.supportTier)) {
    blockers.push({
      category: "unsupported-support-tier",
      detail: `Catalog supportTier is "${catalogEntry.supportTier}", which may not gain a new public runnable surface.`,
    });
  }
  if (catalogEntry.data.configurationStatus === "legacy-unsafe") {
    blockers.push({
      category: "legacy-unsafe-configuration",
      detail:
        'Catalog data.configurationStatus is "legacy-unsafe": the sample\'s browser configuration surface has not been brought up to the current policy.',
    });
  }
  const credentials = browserExposedCredentials(catalogEntry);
  if (credentials.length > 0) {
    // Deliberately a count, not the names: this detail is projected into the
    // public site projection, which must never carry a config variable name
    // (test/sample-contract.test.ts asserts the projection contains no
    // "VITE_"). The names stay available on the decision's `blockers` for
    // local debugging via `browserExposedCredentials`.
    blockers.push({
      category: "requires-api-key",
      detail: `Catalog classifies ${credentials.length} declared config name${credentials.length > 1 ? "s" : ""} as a browser-public credential; a static gallery bundle may not embed one.`,
    });
  }
  if (!STRUCTURAL_HOSTING_KINDS.has(hosting) && !PUBLISHABLE_RUNTIME_HOSTING.has(hosting) && !publishedLivePolicy) {
    blockers.push(HOSTING_EXCLUSION.get(hosting));
  }

  const base = {
    id: catalogEntry.id,
    runtimeHosting: hosting,
    supportTier: catalogEntry.supportTier,
    dataMode: catalogEntry.data.mode,
    audit: auditRecord,
  };
  if (blockers.length === 0) {
    return { ...base, decision: "publish", runnability: RUNNABILITY_BY_HOSTING.get(hosting), blockers: [] };
  }
  return {
    ...base,
    decision: "exclude",
    category: blockers[0].category,
    reason: [...blockers.map((blocker) => blocker.detail), auditRecord.auditedVia].join(" "),
    blockers,
  };
}

/**
 * The single decision generator for all of `samples/catalog.v2.json` (#656
 * REQ-001/REQ-004): every catalog entry gets exactly one decision, either
 * from its `SAMPLE_BUNDLE_AUDIT` record via the policy above, or — for every
 * `lifecycle.state !== "active"` entry — mechanically as
 * `lifecycle-not-active` with a reason generated straight from the catalog's
 * own `lifecycle.reason` (plus `targetRelease` / `replacement` when present),
 * so there is no hand-maintained duplicate to drift from the catalog.
 *
 * Throws if an audit record names an id the catalog doesn't have, if an id is
 * audited twice, if an audit record covers a non-active entry, or if an
 * *active* catalog entry has no audit record at all (a newly-added or
 * newly-promoted active sample must get an explicit audited decision, never a
 * guessed category).
 */
export function deriveSampleBundleDecisions(catalog, { audit = SAMPLE_BUNDLE_AUDIT } = {}) {
  invariant(catalog && Array.isArray(catalog.samples), "catalog.samples is required");
  const byId = new Map(catalog.samples.map((sample) => [sample.id, sample]));
  const auditById = new Map();
  for (const record of audit) {
    invariant(!auditById.has(record.id), `${record.id}: duplicate id in SAMPLE_BUNDLE_AUDIT`);
    invariant(byId.has(record.id), `${record.id}: not found in samples/catalog.v2.json`);
    auditById.set(record.id, record);
  }

  const decisions = [];
  for (const sample of catalog.samples) {
    const record = auditById.get(sample.id);
    if (record) {
      decisions.push(evaluateSampleBundleEligibility(sample, record));
      continue;
    }
    invariant(
      sample.lifecycle.state !== "active",
      `${sample.id}: active catalog sample has no SAMPLE_BUNDLE_AUDIT record in scripts/build-sample-bundles.mjs -- add one with an audited runtimeHosting`,
    );
    const targetRelease = sample.lifecycle.targetRelease ? ` (target ${sample.lifecycle.targetRelease})` : "";
    const replacement = sample.lifecycle.replacement
      ? ` Replacement: ${sample.lifecycle.replacement.kind} "${sample.lifecycle.replacement.id}".`
      : "";
    decisions.push({
      id: sample.id,
      decision: "exclude",
      category: "lifecycle-not-active",
      reason: `Catalog lifecycle.state is "${sample.lifecycle.state}"${targetRelease}: ${sample.lifecycle.reason}${replacement}`,
      supportTier: sample.supportTier,
      dataMode: sample.data.mode,
      blockers: [{ category: "lifecycle-not-active", detail: `Catalog lifecycle.state is "${sample.lifecycle.state}".` }],
    });
  }

  for (const decision of decisions) {
    invariant(
      EXCLUDED_SAMPLE_CATEGORIES.includes(decision.category ?? "requires-api-key"),
      `${decision.id}: computed exclusion category "${decision.category}" is not in EXCLUDED_SAMPLE_CATEGORIES`,
    );
  }
  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Structural checks the audit table's declarations imply, verified against
 * the tree rather than trusted (#656 REQ-001). This is what keeps
 * `runtimeHosting` — the one genuinely hand-audited field — from going stale
 * as samples change shape.
 */
export function verifySampleBundleAudit(catalog, { audit = SAMPLE_BUNDLE_AUDIT, root = PROJECT_ROOT } = {}) {
  const byId = new Map(catalog.samples.map((sample) => [sample.id, sample]));
  const auditById = new Map(audit.map((record) => [record.id, record]));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const record of audit) {
    const catalogEntry = byId.get(record.id);
    invariant(catalogEntry, `${record.id}: not found in samples/catalog.v2.json`);
    const sourcePath = catalogEntry.sourcePath;
    invariant(typeof sourcePath === "string" && sourcePath.length > 0, `${record.id}: catalog sourcePath is required`);
    const hasViteConfig = fs.existsSync(path.join(root, sourcePath, "vite.config.ts"));
    const structural = STRUCTURAL_HOSTING_KINDS.has(record.runtimeHosting);

    invariant(
      structural !== hasViteConfig,
      structural
        ? `${record.id}: runtimeHosting "${record.runtimeHosting}" claims there is no browser app, but ${sourcePath}/vite.config.ts exists`
        : `${record.id}: runtimeHosting "${record.runtimeHosting}" implies a Vite browser app, but ${sourcePath}/vite.config.ts is missing`,
    );

    if (structural) {
      invariant(!record.buildScript, `${record.id}: a non-browser sample must not declare a buildScript`);
    } else {
      invariant(record.buildScript, `${record.id}: a browser sample must declare its existing buildScript`);
      const script = packageJson.scripts[record.buildScript];
      invariant(script, `${record.id}: package.json has no "${record.buildScript}" script`);
      invariant(
        script.includes(`${sourcePath}/vite.config.ts`),
        `${record.id}: "${record.buildScript}" does not build ${sourcePath}/vite.config.ts`,
      );
    }

    const routes = record.hostFixtureRoutes ?? [];
    if (record.runtimeHosting === "same-origin-fixture-service") {
      invariant(routes.length > 0, `${record.id}: same-origin-fixture-service must declare hostFixtureRoutes`);
      for (const route of routes) {
        invariant(route.startsWith("/"), `${record.id}: hostFixtureRoutes entry "${route}" must be an absolute path`);
      }
      invariant(
        routes.every((route, index) => index === 0 || routes[index - 1] <= route),
        `${record.id}: hostFixtureRoutes must be sorted for a stable manifest`,
      );
      invariant(
        fs.existsSync(path.join(root, sourcePath, "mock-server.mjs")),
        `${record.id}: same-origin-fixture-service requires ${sourcePath}/mock-server.mjs to define the declared routes`,
      );
    } else {
      invariant(routes.length === 0, `${record.id}: only same-origin-fixture-service may declare hostFixtureRoutes`);
    }
  }
  for (const [id, policy] of PUBLISHED_LIVE_SAMPLE_POLICY) {
    const record = auditById.get(id);
    if (!record) continue;
    invariant(
      record.runtimeHosting === "external-live-endpoint",
      `${id}: live publication policy requires external-live-endpoint hosting`,
    );
    invariant(Array.isArray(policy.allowedOrigins) && policy.allowedOrigins.length > 0, `${id}: live policy requires allowedOrigins`);
    for (const origin of policy.allowedOrigins) {
      const parsed = new URL(origin);
      invariant(parsed.protocol === "https:" && parsed.origin === origin, `${id}: allowed live origin must be an exact HTTPS origin`);
    }
    const probeUrl = new URL(policy.semanticProbe?.url ?? "");
    invariant(policy.allowedOrigins.includes(probeUrl.origin), `${id}: semantic probe must use an allowed live origin`);
    invariant(
      policy.semanticProbe.kind === "geojson-feature-collection" &&
        Number.isSafeInteger(policy.semanticProbe.minimumFeatures) &&
        policy.semanticProbe.minimumFeatures > 0,
      `${id}: live policy requires a bounded semantic GeoJSON probe`,
    );
  }
  return audit;
}

function readCatalogSync() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "samples/catalog.v2.json"), "utf8"));
}

/**
 * The publication decisions for the real catalog, computed once at module
 * load so `scripts/sample-contract.mjs` can import the authoritative
 * inclusion list and exclusion reasons as plain values without a second
 * hand-maintained copy.
 */
export const SAMPLE_BUNDLE_DECISIONS = deriveSampleBundleDecisions(readCatalogSync());

/** Catalog entries published as browser bundles, sorted by id. */
export const INCLUDED_SAMPLES = SAMPLE_BUNDLE_DECISIONS.filter((decision) => decision.decision === "publish").map(
  (decision) => ({
    id: decision.id,
    buildScript: decision.audit.buildScript,
    runtimeHosting: decision.runtimeHosting,
    runnability: decision.runnability,
    hostFixtureRoutes: [...(decision.audit.hostFixtureRoutes ?? [])],
  }),
);

export const INCLUDED_SAMPLE_IDS = INCLUDED_SAMPLES.map((sample) => sample.id);

export const EXCLUDED_SAMPLES = SAMPLE_BUNDLE_DECISIONS.filter((decision) => decision.decision === "exclude").map(
  ({ id, category, reason }) => ({ id, category, reason }),
);

/**
 * Every catalog entry that isn't bundled, as the `{ id, category, reason }`
 * shape both `sample-bundles.schema.json` and the site projection consume
 * (#656 REQ-004).
 */
export function deriveExcludedSamples(catalog, options = {}) {
  return deriveSampleBundleDecisions(catalog, options)
    .filter((decision) => decision.decision === "exclude")
    .map(({ id, category, reason }) => ({ id, category, reason }));
}

/**
 * The per-bundle publication truth the site projection carries so a gallery
 * card can state a bundle's prerequisites without fetching the bundle
 * manifest itself (#656 REQ-004/REQ-005).
 */
export function derivePublishedSamples(catalog, options = {}) {
  return deriveSampleBundleDecisions(catalog, options)
    .filter((decision) => decision.decision === "publish")
    .map((decision) => ({
      id: decision.id,
      runnability: decision.runnability,
      hostFixtureRoutes: [...(decision.audit.hostFixtureRoutes ?? [])],
    }));
}

const MEDIA_TYPES = new Map([
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".wasm", "application/wasm"],
  [".pmtiles", "application/octet-stream"],
  [".txt", "text/plain"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

function mediaTypeFor(filePath) {
  return MEDIA_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

async function walkFiles(root, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

async function hashDirectory(root) {
  const files = [];
  for (const relativePath of await walkFiles(root)) {
    const bytes = await readFile(path.join(root, relativePath));
    files.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      integrity: `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
      mediaType: mediaTypeFor(relativePath),
    });
  }
  return files;
}

/** Strip every `VITE_*` variable so each build only ever sees the sample's
 * own committed fixture-mode default — never an ambient live override. */
function sampleBuildEnv(sampleId) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITE_")) delete env[key];
  }
  if (sampleId === "maplibre-quickstart") {
    env.VITE_HONUA_QUICKSTART_ENDPOINT =
      "https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1";
    env.VITE_HONUA_QUICKSTART_WHERE = "id <= 25";
    env.VITE_HONUA_QUICKSTART_BASEMAP_STYLE = "./__honua-quickstart__/basemap-style.json";
  }
  if (sampleId === "realtime-incident-dashboard") {
    env.VITE_HONUA_INCIDENT_TRANSPORT = "replay";
  }
  return env;
}

/**
 * The support / lifecycle / replacement truth a published bundle carries so a
 * consumer never has to infer a sample's maturity from the fact that a bundle
 * exists (#656 REQ-005).
 */
function publicationTruth(catalogEntry) {
  const { lifecycle } = catalogEntry;
  return {
    support: {
      tier: catalogEntry.supportTier,
      track: catalogEntry.track,
      validationProfile: catalogEntry.validationProfile,
    },
    lifecycle: {
      state: lifecycle.state,
      reason: lifecycle.reason,
      ...(lifecycle.targetRelease ? { targetRelease: lifecycle.targetRelease } : {}),
      ...(lifecycle.replacement ? { replacement: { ...lifecycle.replacement } } : {}),
    },
  };
}

async function buildSample(
  { id, buildScript, runtimeHosting, runnability, hostFixtureRoutes },
  { catalog, gitCommit, packageVersion },
) {
  const catalogEntry = catalog.samples.find((sample) => sample.id === id);
  invariant(catalogEntry, `${id}: not found in samples/catalog.v2.json`);
  invariant(catalogEntry.lifecycle.state === "active", `${id}: lifecycle.state must be active to bundle`);

  const exampleDist = path.join(PROJECT_ROOT, "examples", id, "dist");
  await rm(exampleDist, { recursive: true, force: true });

  // "--base ./" makes Vite emit relative asset URLs so bundles work when
  // served under per-sample subpaths (samples.honua.io/sdk/<id>/app/).
  const result = runNpmSync(["run", buildScript, "--silent", "--", "--base", "./"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: sampleBuildEnv(id),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${id}: ${buildScript} exited ${result.status}`);
  }
  invariant(fs.existsSync(path.join(exampleDist, "index.html")), `${id}: build did not emit index.html`);

  const bundleDir = path.join(OUTPUT_ROOT, id);
  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });
  await cp(exampleDist, bundleDir, { recursive: true });

  const files = await hashDirectory(bundleDir);
  invariant(
    files.some((file) => file.path === "index.html"),
    `${id}: copied bundle is missing index.html`,
  );

  const configDefaults = Object.fromEntries(browserPublicConfigNames(catalogEntry).map((name) => [name, null]));

  return {
    id,
    entrypoint: "index.html",
    dataMode: catalogEntry.data.mode,
    configDefaults,
    runtimeHosting,
    runnability,
    hostFixtureRoutes: [...hostFixtureRoutes],
    ...publicationTruth(catalogEntry),
    builtFrom: { commit: gitCommit, packageVersion },
    files,
  };
}

export async function buildSampleBundleManifest({ gitCommit = gitSha() } = {}) {
  invariant(/^[a-f0-9]{40}$/.test(gitCommit), "gitCommit must be a 40-character SHA");
  const packageJson = await readJson("package.json");
  const catalog = await readJson("samples/catalog.v2.json");
  verifySampleBundleAudit(catalog);
  const packageLock = await readFile(path.join(PROJECT_ROOT, "package-lock.json"));

  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });

  const samples = [];
  for (const sample of INCLUDED_SAMPLES) {
    process.stdout.write(`Building ${sample.id} (${sample.buildScript})...\n`);
    samples.push(
      await buildSample(sample, { catalog, gitCommit, packageVersion: packageJson.version }),
    );
  }

  const excluded = deriveExcludedSamples(catalog);

  return {
    format: "honua.sdk.sample-bundles.v2",
    schemaVersion: 2,
    build: {
      node: packageJson.engines.node,
      lockfileSha256: sha256(packageLock),
    },
    samples,
    excluded,
  };
}

async function loadSchema() {
  return JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
}

export async function validateSampleBundleManifest(manifest, { catalog } = {}) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(await loadSchema());
  if (!validate(manifest)) {
    throw new Error(`sample bundle manifest is invalid: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
  invariant(manifest.samples.length === INCLUDED_SAMPLES.length, "manifest sample count drift");
  const expectedById = new Map(INCLUDED_SAMPLES.map((sample) => [sample.id, sample]));
  const seen = new Set();
  for (const sample of manifest.samples) {
    invariant(!seen.has(sample.id), `duplicate sample id in manifest: ${sample.id}`);
    seen.add(sample.id);
    const expected = expectedById.get(sample.id);
    invariant(expected, `${sample.id}: bundled but not an audited published sample`);
    invariant(
      sample.runtimeHosting === expected.runtimeHosting && sample.runnability === expected.runnability,
      `${sample.id}: manifest runnability truth drifted from the audited decision`,
    );
    invariant(
      (sample.hostFixtureRoutes ?? []).join(" ") === expected.hostFixtureRoutes.join(" "),
      `${sample.id}: manifest hostFixtureRoutes drifted from the audited decision`,
    );
    const paths = new Set();
    for (const file of sample.files) {
      invariant(!paths.has(file.path), `${sample.id}: duplicate file path ${file.path}`);
      paths.add(file.path);
    }
    invariant(paths.has(sample.entrypoint), `${sample.id}: entrypoint ${sample.entrypoint} is not one of its files`);
  }
  const excludedSeen = new Set();
  for (const excludedSample of manifest.excluded) {
    invariant(!seen.has(excludedSample.id), `${excludedSample.id}: listed in both samples and excluded`);
    invariant(!excludedSeen.has(excludedSample.id), `duplicate excluded sample id in manifest: ${excludedSample.id}`);
    excludedSeen.add(excludedSample.id);
  }
  if (catalog) {
    invariant(
      manifest.samples.length + manifest.excluded.length === catalog.samples.length,
      `manifest accounts for ${manifest.samples.length + manifest.excluded.length} of ${catalog.samples.length} catalog samples`,
    );
    for (const catalogSample of catalog.samples) {
      invariant(
        seen.has(catalogSample.id) || excludedSeen.has(catalogSample.id),
        `${catalogSample.id}: catalog sample is neither bundled nor excluded in the manifest`,
      );
    }
  }
  return manifest;
}

async function verifyOnDisk() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const catalog = await readJson("samples/catalog.v2.json");
  await validateSampleBundleManifest(manifest, { catalog });
  for (const sample of manifest.samples) {
    const bundleDir = path.join(OUTPUT_ROOT, sample.id);
    for (const file of sample.files) {
      const bytes = await readFile(path.join(bundleDir, file.path));
      invariant(bytes.byteLength === file.bytes, `${sample.id}/${file.path}: byte length drift`);
      invariant(sha256(bytes) === file.sha256, `${sample.id}/${file.path}: SHA-256 drift`);
      invariant(
        `sha256-${createHash("sha256").update(bytes).digest("base64")}` === file.integrity,
        `${sample.id}/${file.path}: SRI drift`,
      );
    }
  }
  process.stdout.write(
    `Verified ${manifest.samples.length} sample bundles (${manifest.samples.reduce((total, sample) => total + sample.files.length, 0)} files) against ${path.relative(PROJECT_ROOT, MANIFEST_PATH)}\n`,
  );
}

async function main(argv) {
  const [command = "build"] = argv;
  if (command === "build") {
    const catalog = await readJson("samples/catalog.v2.json");
    const manifest = await buildSampleBundleManifest();
    await validateSampleBundleManifest(manifest, { catalog });
    await writeFile(MANIFEST_PATH, stableJson(manifest), "utf8");
    const totalFiles = manifest.samples.reduce((total, sample) => total + sample.files.length, 0);
    const totalBytes = manifest.samples.reduce(
      (total, sample) => total + sample.files.reduce((sum, file) => sum + file.bytes, 0),
      0,
    );
    for (const sample of manifest.samples) {
      const bytes = sample.files.reduce((sum, file) => sum + file.bytes, 0);
      process.stdout.write(`  ${sample.id}: ${sample.files.length} files, ${(bytes / 1024).toFixed(1)} KiB\n`);
    }
    process.stdout.write(
      `Wrote ${path.relative(PROJECT_ROOT, MANIFEST_PATH)} (${manifest.samples.length} samples, ${totalFiles} files, ${(totalBytes / 1024).toFixed(1)} KiB; ${manifest.excluded.length} excluded)\n`,
    );
    return;
  }
  if (command === "check") {
    await verifyOnDisk();
    return;
  }
  throw new Error(`Unknown command: ${command} (expected build|check)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-sample-bundles failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
