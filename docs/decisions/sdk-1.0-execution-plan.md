# SDK 1.0 execution plan

Status: Proposed execution baseline

Owner: `honua-io/honua-sdk-js`

Parent workstream: [Universal geospatial application kernel](https://github.com/honua-io/honua-sdk-js/issues/384)

Last reviewed: 2026-07-13

## Decision

Honua SDK JS will compete as the most trustworthy open geospatial application
kernel, not as another renderer or a class-for-class ArcGIS clone. The 1.0
program therefore optimizes for semantic correctness, capability honesty,
explainable execution, conformance, and a short first-use workflow before it
adds more protocols, render effects, application shells, or agent APIs.

The product front door is one lifecycle-owned workflow:

```ts
const honua = createHonua();
const connection = await honua.connect(url);
const source = await connection.source();
const plan = await connection.explain(source.query({ where }));
const result = await connection.query(plan);
const mounted = await connection.mount(result, map);

await mounted.dispose();
await connection.dispose();
await honua.dispose();
```

The exact fluent syntax is owned by the child API issue. The invariant is that
connect, inspect, explain, query, mount, cancellation, diagnostics, and cleanup
form one coherent path. Focused subpaths remain available for advanced use.

## Product boundary

Honua owns:

- protocol and format discovery;
- vendor-neutral schema, query, result, capability, and error contracts;
- deterministic planning and fidelity diagnostics;
- bounded object, streaming, tiled, and columnar execution;
- renderer adapters and shared interaction state;
- ArcGIS migration into native Honua contracts;
- conformance and certification evidence.

Honua does not own:

- a proprietary 2D renderer, globe, or GPU layer framework;
- a general-purpose frontend application framework;
- silent emulation of unsupported GIS behavior;
- a permanently Esri-shaped canonical model;
- an AI-only execution path that bypasses normal planning and authorization.

## Target architecture

```text
createHonua() lifecycle and policy owner
  |
  +-- connect(url) -> inspect -> SourceDescriptor
  |                    |
  |                    +-- claimed / observed / effective capabilities
  |
  +-- typed semantic query -> deterministic plan -> execute
  |                              |
  |                              +-- protocol pushdown
  |                              +-- bounded worker/columnar residuals
  |                              +-- cache, cost, fidelity, provenance
  |
  +-- Result | AsyncIterable<ResultBatch> | tiles
  |                              |
  |                              +-- MapLibre adapter (default)
  |                              +-- deck.gl adapter (large data)
  |                              +-- Cesium adapter (optional 3D)
  |
  +-- migration, CLI, MCP, React, and app packages consume the same contracts
```

### Layer invariants

1. `contract`, `expr`, planner, and protocol descriptors remain DOM- and
   renderer-free.
2. Canonical schema and geometry types do not import Esri types. Esri JSON and
   SQL remain supported dialects at adapter boundaries.
3. A query never changes meaning because its source protocol changes. Dialect
   strings are named escape hatches, not the common `where` contract.
4. Unsupported and degraded behavior is explicit. Unknown geometry, CRS,
   capability, or fidelity never receives a plausible invented default.
5. Descriptors and plans serialize deterministically using JSON-safe values.
6. First-party protocols use the same versioned module seam offered to
   third-party plugins.
7. Heavy peers and workers remain lazy, optional, abortable, and disposable.

## Canonical contracts to settle before 1.0

### Schema, geometry, and CRS

- Logical field kinds are vendor-neutral and preserve original protocol type
  metadata separately.
- Geometry is a discriminated union with explicit empty/unknown handling and
  GeoJSON/JSON-FG conversion.
- CRS identity includes authority/code or WKT, axis order, dimensionality, and
  provenance. Reprojection is never inferred merely from a `wkid`-shaped
  object.
- Source locators are protocol-discriminated unions rather than one object of
  unrelated optional fields.

### Typed query and CQL2 interchange

- `Query<T>` uses `T` for field paths, projection, ordering, grouping, and
  aggregate result typing.
- The predicate tree covers comparison, null, list, spatial, temporal, and
  bounded composition operations.
- CQL2 JSON is either the canonical representation or a lossless interchange
  representation. Text SQL/CQL/FES/OData inputs are explicit dialect nodes.
- Deterministic serialization and hashing include schema, CRS, authorization
  scope, policy, and SDK contract version.

### Capability truth and planning

- `claimed` records protocol defaults or service claims.
- `observed` records metadata and probe evidence with timestamps/provenance.
- `effective` intersects claimed, observed, application policy, environment,
  and authorization.
- `explain` reports stages, pushdown, residual work, requests, transfer/memory
  bounds, cache decisions, estimated cost signals, fidelity loss, warnings,
  and provenance.
- Unsafe materialization or lossy execution requires explicit policy approval.

### Errors and diagnostics

Every public error participates in one tagged SDK error contract containing:

- stable domain and code;
- retryability and capability/degradation classification;
- operation and request identifiers;
- redacted structured context;
- cause preservation;
- a common type guard.

## Execution rules for agent-sized issues

Leaf issues must be executable without reconstructing product intent.

- `XS`: one localized correction, normally no more than five touched files.
- `S`: one contract or one implementation slice with focused tests.
- `M`: one subpath or protocol family, normally no more than twelve source
  files plus tests and docs.
- `L` and `XL` are allowed only for epics. They must be split before assignment.
- A leaf issue names allowed paths, files to read first, non-goals, dependencies,
  validation commands, and the evidence required to close it.
- One issue must not combine contract design, every adapter migration, a demo,
  and publication. Those are dependent issues.
- An issue closes only when every acceptance checkbox is checked and evidence is
  linked. Narrowed scope requires a named residual issue before closure.

## Execution waves

### Wave 0 — restore truth

Work in this wave may run in parallel and is the only work eligible for
`roadmap:now` until trunk and release gates are green.

1. Restore the integration package-resolution lane and add installed-package
   regression coverage.
2. Correct fail-open spatial behavior and ambiguous approximation naming.
3. Reconcile stable, experimental, deprecated, and removed surfaces for the
   next published beta.
4. Establish one generated capability/support manifest for package docs,
   protocol docs, examples, and the public site.
5. Groom completed epics: attach evidence, create residual issues, and reopen
   any epic whose gating acceptance remains unmet.

Exit gate: trunk and release PR checks are green; npm and hosted docs describe
the same supported package; no `roadmap:now` issue is larger than `M`.

### Wave 1 — settle semantic foundations

1. Vendor-neutral schema, geometry, CRS, locator, and serializable descriptor
   contracts.
2. Typed predicate/query AST with CQL2 JSON interchange.
3. Claimed/observed/effective capability negotiation.
4. Deterministic explain plan with cost, fidelity, cache, and provenance.
5. Unified SDK error and diagnostic envelope.
6. Schema inspection and TypeScript type generation.

Exit gate: the same typed fixture query has equivalent meaning through
GeoServices, OGC/CQL2, WFS/FES, and OData compilers, with explicit unsupported
results where a dialect cannot preserve it.

### Wave 2 — make the kernel and adapters dogfood the design

1. Implement `createHonua()` lifecycle ownership and `connect(url, options?)`.
2. Add connection-level inspect, query, explain, mount, cancellation, and
   disposal.
3. Define the first-party protocol module seam and migrate one adapter as the
   reference implementation.
4. Migrate remaining adapters in protocol-family issues.
5. Replace raw-fetch live smoke with real SDK connect/inspect/query journeys and
   official conformance-class evidence.

Exit gate: every first-party adapter uses the module seam or has a documented
and dated exception; the golden workflow runs from a packed installation in
Node and a browser.

### Wave 3 — scale without losing semantics

1. Arrow/GeoArrow-compatible result batches and bounded object conversion.
2. Worker-safe filtering, projection, reprojection, aggregation, cancellation,
   backpressure, progress, and disposal.
3. A zero-copy or bounded-copy deck.gl route.
4. Direct STAC/COG, PMTiles, and GeoParquet execution without mandatory GeoJSON
   materialization.
5. Realtime snapshot-plus-delta production hardening when the incident workflow
   is a committed design-partner path.

Exit gate: published point, line, and polygon benchmarks at 100k and one million
features meet explicit transfer, memory, startup, and frame-rate budgets.

### Wave 4 — adoption and conditional depth

1. Complete the canonical sample portfolio below.
2. Measure ArcGIS migration exact/assisted/manual outcomes over a representative
   application corpus.
3. Complete external package/listing distribution after the published beta is
   coherent.
4. Advance offline editing only after server cursor/conflict contracts exist.
5. Advance Cesium beyond Beta only with a real 3D adopter and vertical/temporal
   correctness evidence.
6. Keep MCP/NL execution experimental until it consumes the stable planner and
   passes end-to-end certification.

## Canonical demo and sample portfolio

The current catalog is valuable but too broad for a coherent learning path: 31
executables include 11 flagships, ten advanced apps, six recipes, and four
references. Only five are recognized by the separate flagship-evidence index.
The existing disposition data already marks only 14 as `keep`, with the rest
marked `merge`, `rework`, `replace`, or `retire`. The repository also maintains
many sample-specific Vite configurations, TypeScript configurations, mock
servers, stylesheets, and more than one hundred demo scripts.

The catalog will use four unambiguous tracks:

- `golden`: a supported end-to-end outcome with fixture and current live
  evidence;
- `recipe`: one copyable SDK concept with a small workflow module;
- `lab`: an experimental provider, renderer, or product integration;
- `fixture`: internal conformance or migration input, not a public app.

Public navigation will emphasize seven golden workflows:

| Golden workflow | Existing sources to consolidate | Product proof |
| --- | --- | --- |
| First map in five minutes | `maplibre-quickstart`, `standalone-quickstart`, `endpoint-to-map` | URL discovery, query, explain, MapLibre mount, diagnostics |
| Universal service explorer | `service-explorer`, `runtime-parity-showcase` | Protocol detection, capability truth, supported/degraded controls |
| Planning and permitting | `planning-permitting-workbench`, `edit-workflow-demo`, `sketch-editing`, `geocoding-quickstart` | Task-oriented query, forms, editing, attachments, spatial analysis |
| Realtime incident operations | `realtime-incident-dashboard` | Live snapshot/delta, reconnect, ordering, cache/render reconciliation |
| Imagery, catalog, and terrain | `imagery-cog-quickstart`, `stac-imagery-browser`, `terrain-rgb-elevation`, `storytelling-25d-map` | STAC discovery, COG/raster, terrain and explicit fidelity |
| Large-data spatial analytics | `spatial-analytics-workbench`, `overture-geoparquet`, `kepler-analytics` | Planner, GeoParquet/GeoArrow, aggregation, deck.gl-scale rendering |
| ArcGIS migration workbench | `migration-workbench`, `arcgis-source-app`, migration fixtures | Scan, transform, report, exact/assisted/manual outcome |

Focused recipes remain for Node, React, OAuth, PMTiles, geocoding, sketching,
process execution, and temporal playback. AI/MCP, offline, and Cesium samples are
clearly labeled labs until the underlying capability graduates.

### Sample quality contract

Every supported public sample must:

1. demonstrate one primary user outcome and no more than three secondary
   capabilities;
2. consume the public SDK workflow instead of reimplementing it with raw fetch;
3. have a deterministic credential-free fixture lane;
4. have a live lane when it makes a live-data claim, with provenance, freshness,
   latency, and an honest skip/degradation reason;
5. display data mode, endpoint identity, support tier, and degradation status;
6. cover the happy path and one unsupported/failure path in browser smoke;
7. produce zero unexpected console errors and pass accessibility, CSP, responsive
   layout, attribution, and secret-scanning gates;
8. compile every published snippet against the advertised package version;
9. build against both repository source and the packed SDK artifact;
10. keep the SDK call being taught in a small, inspectable `src/workflow.ts`;
11. reuse SDK-owned sample infrastructure without making that infrastructure a
   public application framework;
12. publish a machine-readable evidence record usable by the SDK docs and
    `honua.io/samples`.

### Shared sample infrastructure

An internal `examples/_kit` layer may own only sample concerns:

- fixture/live configuration parsing and redacted diagnostics;
- a consistent loading/empty/error/degraded status panel;
- local evidence capture and browser-test selectors;
- attribution, accessibility, and responsive shell primitives;
- Vite/test configuration helpers.

It must not own GIS contracts, application state semantics, a public component
library, or runtime behavior that belongs in the SDK.

A single runner replaces most sample-specific package scripts:

```text
npm run sample -- list
npm run sample -- <sample-id> dev
npm run sample -- <sample-id> verify
npm run sample -- golden verify
npm run sample -- <sample-id> evidence
```

Fixture packs carry stable dataset identity, schema, CRS, extent, counts,
checksums, license, attribution, provenance, a frozen clock, seeded identifiers,
and a reviewable refresh procedure. A modular fixture server supplies named
happy, empty, unsupported, pagination, retry, disconnect, stale-cursor,
duplicate-event, conflict, schema-drift, and range-request scenarios. Fixture
mode blocks non-local network access.

## Backlog operating policy

- `roadmap:now`: green-CI, contract, or unblocked sample-foundation work only.
- `roadmap:next`: depends only on contracts actively in `roadmap:now`.
- `roadmap:later`: offline editing, exhaustive Cesium depth, broad agent/app
  surfaces, and unvalidated protocol additions.
- At most two implementation epics are active. Each may have at most four
  in-progress leaf issues.
- The GA milestone owns the kernel contract and graduation matrix. The Beta
  milestone owns sample consolidation and adoption evidence.
- Native GitHub sub-issues and dependency links are authoritative. Markdown
  checklists are summaries, not the only relationship record.
- Adoption metrics remain scorecards, not engineering closure criteria.

## Required closure evidence

Each implementation issue ends with a comment containing:

```md
## Closure evidence

- Commit/PR:
- Acceptance criteria checked:
- Focused tests:
- Required full gates:
- Docs/examples updated:
- Capability or API manifest impact:
- Performance/bundle impact:
- Residual issues: None | <links>
```

An agent that cannot provide this evidence leaves the issue open and reports the
blocking condition. Passing a narrower test slice is not evidence that an epic
is complete.

## Program success measures

- Under five minutes from a supported URL to a meaningful query and map.
- Zero silent capability or query degradation.
- Published conformance by operation and conformance class for each adapter.
- Package, API report, support manifest, docs, and samples agree per release.
- p50/p95 time-to-first-feature/tile, peak memory, transferred bytes, and frame
  rate stay within published scenario budgets.
- Representative migration corpus reports exact, assisted, and manual results.
- Supported samples pass fixture CI and scheduled live semantic validation.
- At least three independent applications complete an eight-week beta soak
  before 1.0.
