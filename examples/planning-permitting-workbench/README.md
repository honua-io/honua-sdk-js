# Planning and Permitting journey

Deterministic browser journey for a common planning workflow: find a parcel,
inspect authoritative metadata and capability truth, run bounded spatial
analysis, submit or recover an edit with attachments, and export a reviewable
result.

This sample is the maintained candidate for the catalog's `planning-permitting`
journey. The journey remains **planned**, not golden or receipt-qualified. Its
live lane also remains planned; the commands below use same-origin fixtures and
make no external requests.

## What it proves

- `HonuaGeocodingClient` resolves an address before a metadata-discovered
  `Source` performs the parcel query.
- The source candidate query is capped before exact client geometry computes
  proposal area and flood-hazard intersection.
- Metadata-coded domains drive the permit form. Missing metadata or mutation
  capabilities disable the workflow instead of enabling a local-success
  fallback.
- `createEditSession` exposes successful attachment commit, invalid-domain,
  version-conflict, attachment-failure, and unsupported-source outcomes with
  optimistic commit or rollback transitions and explicit recovery guidance.
- The exported `honua.planning-permitting-review` model carries deterministic
  provenance and fidelity notes from the same public workflow.
- The browser shell exercises keyboard tabs, mobile layouts, accessibility,
  console closure, and idempotent resource cleanup in both source and extracted
  packed-SDK modes.

The linked planning shell is currently DOM-based; this slice does not claim a
MapLibre renderer qualification. Fixture hazard output is synthetic and is not
a current regulatory determination.

## Portfolio boundary

- `geocoding-quickstart` remains the focused forward/reverse/suggestion recipe.
- `sketch-editing` remains the focused terra-draw drawing and snapping recipe.
- `edit-workflow-demo` is the legacy overlapping edit application and is being
  replaced by this end-to-end journey.

## Commands

```bash
npm run demo:planning-workbench
npm run demo:planning-workbench:typecheck
npm run demo:planning-workbench:build
npm run test:playwright:planning-workbench

npm run samples:run -- verify --sample planning-permitting-workbench --sdk-mode source
npm run samples:run -- verify --sample planning-permitting-workbench --sdk-mode packed
```

The shared runner verifies that packed mode resolves the extracted package's
published declarations and runtime entrypoints rather than repository source.

## Layout

- `src/journey.ts` — copyable public-SDK search, analysis, edit, attachment,
  failure, and export workflow.
- `mock-server.mjs` — same-origin deterministic GeoServices and geocoding
  fixture with bounded request logging and idempotent shutdown.
- `src/main.ts` — accessible browser presentation and fail-closed workflow
  state.
- `src/model.ts`, `src/fixtures.ts`, and `src/types.ts` — linked planning-shell
  context used to present the authoritative public workflow.

## Expected degradation

If metadata discovery fails or required query/edit/attachment capabilities are
absent, search, analysis, export, and mutation controls stay disabled with an
explicit reason. Unsupported edits do not mutate the local shell, and fixture
success is never presented as live-service evidence.
