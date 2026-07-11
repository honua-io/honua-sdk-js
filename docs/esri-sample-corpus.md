# Esri Sample Migration Corpus

This corpus is the first bounded slice for paired Esri sample app and referenced
service migration evidence. It is intentionally fixture-first.

## PR CI Guardrails

- PR CI must not contact live Esri services.
- PR CI must not vendor Esri sample source code.
- PR CI must not commit Esri-hosted service data, basemaps, screenshots, or
  Portal exports.
- Sample source URLs are metadata references only.
- Samples that require API keys, OAuth, private content, premium services, or
  unclear content terms stay skipped unless credentials, permission, and terms
  review are explicitly configured.

The committed manifest lives at
`test/fixtures/esri-sample-corpus/manifest.json`. Its fixtures are tiny
Honua-owned snippets that mimic common ArcGIS Maps SDK for JavaScript patterns:
service URL references, Portal item references, API-key routing references, and
OAuth/private Portal references.

## Manifest Shape

The manifest uses `schemaVersion: "honua.esri-sample-corpus.v1"` and records:

- global guardrails for no vendored Esri code, no committed Esri service data,
  fixture-only PR CI, and opt-in live evidence lanes
- one entry per curated sample with `id`, `title`, source URL metadata,
  fixture location, status, license metadata, terms notes, skip reasons, and
  expected references
- status values: `ci-fixture`, `live-evidence`, and `skipped`
- skip reasons: `requires-api-key`, `requires-oauth`, `premium-service`,
  `private-content`, `unclear-content-terms`, and `unsupported-sample-family`

The migration entrypoint exports helpers to load and inspect the corpus:

```ts doc-test=compile
import {
  analyzeEsriSampleFixture,
  loadEsriSampleCorpusManifest,
  summarizeEsriSampleCorpus,
} from "@honua/sdk-js/migration";

const manifest = loadEsriSampleCorpusManifest("test/fixtures/esri-sample-corpus/manifest.json");
const summary = summarizeEsriSampleCorpus(manifest);
const analysis = analyzeEsriSampleFixture(manifest.samples[0], {
  manifestDir: "test/fixtures/esri-sample-corpus",
});

void summary;
void analysis;
```

## Per-sample evidence

For each curated sample, the migration entrypoint can run the existing codemod
against the local fixture and emit a structured evidence record:

```ts doc-test=compile
import { emitEsriSampleCorpusEvidence } from "@honua/sdk-js/migration";

const evidence = emitEsriSampleCorpusEvidence({
  manifestPath: "test/fixtures/esri-sample-corpus/manifest.json",
  // Defaults to "honua-maplibre". Other codemod targets are also accepted.
});

for (const sample of evidence.samples) {
  // sample.status === "migrated" | "skipped" | "error"
  // sample.classification.auto / manual / unsupported
  // sample.manualTodos.reasons (deduped by reason, includes affected kinds)
  // sample.referencedServices / sample.portalItems / sample.guardrailFlags
  // sample.urlRewriteSummary.byKind / sample.unsupportedApis
}

// Aggregate across the corpus — per-status counts always sum to the manifest
// length, and unsupported APIs are deduplicated.
const { statusCounts, totals, uniqueUnsupportedApis } = evidence.aggregate;
void statusCounts;
void totals;
void uniqueUnsupportedApis;
```

Samples whose manifest entry is `status: "skipped"` (private-portal, routing
API-key, premium-service, etc.) appear in the evidence record with
`status: "skipped"` and the manifest skip reason — they always count toward the
aggregate, but never as `migrated`. No live Esri services are contacted; the
helper operates entirely on the committed fixture corpus.

The same evidence can be persisted to disk via the migration CLI subcommand
`corpus-evidence`. It writes one JSON artifact per sample to
`<out>/samples/<sampleId>.json` and a single aggregate document to
`<out>/corpus-evidence.json`. `--corpus` defaults to
`test/fixtures/esri-sample-corpus`, and `--target` defaults to
`honua-maplibre`:

```bash
node dist/src/migration/cli.js corpus-evidence \
  --corpus test/fixtures/esri-sample-corpus \
  --out ./corpus-evidence
```

## Live Evidence Lanes

Live Esri sample/service evidence is reserved for scheduled or manual runs. A
live lane should:

- require an explicit environment flag and any needed credentials
- rate-limit requests and avoid load/performance testing against Esri services
- record source sample URL, retrieved date, service URLs, Portal item ids,
  service import result, app migration result, unsupported/manual-review items,
  and browser smoke result
- skip samples requiring credentials, premium services, private content, or
  unclear content terms unless the lane has explicit permission
- emit artifacts for review rather than committing Esri source or service data

Follow-on issue #206 work can layer service import, app codemod, URL rewriting,
and Playwright smoke evidence on top of this manifest and extraction helper.

## Related: `honua-maplibre` migration target

The codemod's MapLibre-native migration target is documented in
[`docs/migration-honua-maplibre.md`](./migration-honua-maplibre.md). That
page covers the `--target honua-maplibre` flag, the rewritten kinds, the
migration report fields, and the manual gaps that remain open on issue
#205. The bundled MapLibre fixture
`test/fixtures/esri-maplibre-simple-app/` is the canonical example
for that target and is referenced from the doc.
