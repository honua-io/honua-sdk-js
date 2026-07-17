# Planning & Permitting golden journey

The deterministic golden-journey candidate for `#545`: address search, parcel and regulatory
context, a bounded proposal-footprint check, metadata-backed editing, explicit
failure recovery, and a portable review artifact.

The headless workflow in `src/model.ts` has no application-shell dependency.
It connects through `createHonua()`, selects a discovered `Source`, and uses the
public query, geocoding, geometry, edit-session, attachment, and normalized
error contracts directly. The browser is a thin accessible adapter over that
same workflow.

## Run it

```sh
npm run demo:planning-workbench:mock
npm run demo:planning-workbench:typecheck
npm run demo:planning-workbench:build
npx vitest run test/planning-permitting-workbench.test.ts
npm run test:playwright:planning-workbench
```

`demo:planning-workbench:mock` builds the packed app and starts a resettable,
same-origin raw GeoServices/GeocodeServer fixture. It does not silently replace
the service with an in-memory `Source` implementation.

## One executable workflow

1. `HonuaGeocodingClient.forwardGeocode()` resolves `300 Hana Hwy` and preserves
   its parcel identifier in provider attributes.
2. `createHonua().connect()` discovers an editable FeatureServer layer;
   `Source.query()` retrieves the selected parcel/application.
3. A second, capped spatial query retrieves at most 25 candidates. Curated
   `@honua/geometry` operations compute area, perimeter, and hazard intersection.
4. `createEditSession()` validates the metadata-backed form, applies optimistic
   hooks, submits edits, and stages the site-plan attachment.
5. `reviewArtifact()` exports the exact query/analysis/edit evidence and recovery
   receipts as `honua.planning-permitting-review` JSON.

The analysis receipt distinguishes source execution from client execution. Its
`exact-client-geometry` fidelity applies only to the checked-in fixture polygon;
the artifact says explicitly that it is not a current regulatory determination.

## Deterministic outcome matrix

| Scenario | Contract result | Recovery shown to the user |
| --- | --- | --- |
| Valid create + site plan | `succeeded` | None; feature and attachment commit |
| Invalid permit domain | `validation-failed` | Select a coded metadata value and resubmit |
| Stale version | `failed`, normalized `conflict`/409 | Refresh version, review, and explicitly reapply |
| Oversized site plan | `partial`, normalized attachment/413 | Keep the committed feature and retry only the attachment |
| Read-only layer | `unsupported`, capability failures | Select a source advertising edits and attachments |

Conflict and attachment failures execute optimistic apply/rollback hooks. Domain
and capability failures stop in preflight and do not issue a mutation request.

## Requirement traceability

| Specifica requirement | Evidence |
| --- | --- |
| REQ-001 complete planning workbench | One `search → analyze → submit → export` workflow and browser route |
| REQ-002 public contracts | Direct imports from `honua`, `contract`, `geocoding`, and `geometry` subpaths |
| REQ-003 edit semantics | Metadata domains plus success, rollback, partial, conflict, and unsupported receipts |
| REQ-004 bounded analysis | 25-record cap, execution plan, discovery provenance, fidelity, and caveat |
| REQ-005 deterministic failures | Raw fixture routes and assertions for all five scenarios |

Source-level evidence comes from the Vitest test that imports `src/model.ts`.
Packed evidence comes from Playwright against the Vite output served by the same
raw fixture service. Both assert the same `search-analyze-edit-export` semantic
contract. Playwright also checks keyboard focus, a 390 px viewport, browser
console cleanliness, fixture request evidence, and server cleanup.

## Focused companion recipes

- `geocoding-quickstart` remains the provider/suggest/reverse-geocode recipe.
- `sketch-editing` remains the terra-draw and snapping binding recipe.
- `edit-workflow-demo` remains the isolated edit-session mechanics recipe.

Those recipes teach individual surfaces. This route owns the complete planning
outcome and is the only route that should be presented as the Planning &
Permitting golden journey.

## Fixture boundaries

Metadata and coded domains are cacheable. Every edit result invalidates feature
state; the deterministic fixture stores mutations only for the life of its
server and exposes `/__fixture__/reset`, `/__fixture__/state`, and
`/__fixture__/requests` for validation. Planning state is not realtime.
