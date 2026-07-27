# Planning and Permitting journey

Deterministic browser journey for a common planning workflow: find a parcel,
inspect authoritative metadata and capability truth, run bounded spatial
analysis, submit or recover an edit with attachments, and export a reviewable
result.

This sample is the maintained candidate for the catalog's `planning-permitting`
journey. The journey remains **planned**, not golden or receipt-qualified. Its
live lane also remains planned. The normal demo commands below use same-origin
fixtures; the separately opt-in evidence command performs three bounded,
anonymous reads against the public Nominatim and Hawaii Statewide GIS services.

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
- The production `<honua-feature-editor>` widget (from
  `@honua/sdk-js/web-components`) creates and updates real fixture-backed
  planning applications over the same metadata-discovered writable `Source`.
  The widget derives its own form from the advertised field metadata and
  domains; the shell contributes only selection, prefill, and the post-commit
  re-read that makes reconciliation visible.
- The fixture service enforces optimistic concurrency on `applyEdits`, so a
  stale concurrency token is rejected rather than silently overwritten, and the
  deterministic conflict, attachment-failure, cancellation, and retry paths are
  proven in a real browser.
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
npm run test:playwright:planning-editing

npm run samples:run -- verify --sample planning-permitting-workbench --sdk-mode source
npm run samples:run -- verify --sample planning-permitting-workbench --sdk-mode packed

HONUA_PLANNING_LIVE_ENABLED=true npm run evidence:planning:live
npm run samples:run -- evidence --sample planning-permitting-workbench --gate live --sdk-mode source --allow-live
npm run samples:run -- evidence --sample planning-permitting-workbench --gate live --sdk-mode packed --allow-live
```

The shared runner verifies that packed mode resolves the extracted package's
published declarations and runtime entrypoints rather than repository source.
The reviewed live producer resolves Honolulu Hale once, inspects the official
Hawaii zoning layer, and issues one point-intersection query capped at three
attribute-only records. It follows no redirects, sends no credentials, allows
three requests total, caps each decoded response at 512 KiB and the aggregate at
1 MiB, and stops within 25 seconds. This public source is query-only, so the
producer records edit, attachment, conflict, and rollback proof as fixture-only
rather than implying that public data was mutated.

## Layout

- `src/journey.ts` — copyable public-SDK search, analysis, edit, attachment,
  failure, and export workflow, plus the writable `Source` and bounded
  application re-reads the feature editor is bound to.
- `mock-server.mjs` — same-origin deterministic GeoServices and geocoding
  fixture with bounded request logging and idempotent shutdown. Its
  `applyEdits` enforces an optimistic-concurrency precondition, and two
  rehearsal seams (`POST /__fixture__/concurrent-edit`,
  `POST /__fixture__/arm-update-fault`) let the browser tests reproduce a
  contested or briefly degraded service without simulating anything client-side.
- `src/main.ts` — accessible browser presentation and fail-closed workflow
  state.
- `src/model.ts`, `src/fixtures.ts`, and `src/types.ts` — linked planning-shell
  context used to present the authoritative public workflow.

## Expected degradation

If metadata discovery fails or required query/edit/attachment capabilities are
absent, search, analysis, export, and mutation controls stay disabled with an
explicit reason. Unsupported edits do not mutate the local shell, and fixture
success is never presented as live-service evidence.

A cancelled draft sends nothing. A conflicting draft is parked until a reviewer
chooses to overwrite, discard, or reload, and a stale token that still reaches
the service is refused there too. A partly applied edit — feature committed,
attachment rejected — is reported as rejected with the attachment named, never
as a success.
