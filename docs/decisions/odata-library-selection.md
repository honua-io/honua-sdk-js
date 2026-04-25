# OData library selection

Status: implementation-time decision for `honua-sdk-js#26`. Open for
consensus review per the ticket's `policy.review_mode = consensus` —
swap to a wrapped runtime library is a focused `src/core/odata.ts`
change once the consensus question is settled.

## Constraint context

Two project constraints frame this decision and pull in opposite
directions:

- **`must_follow` constraint on the ticket:** "wrap a canonical external
  OData library rather than hand-rolling an in-house client."
- **Project `dependencies` constraint:** "minimize external libraries
  and prefer existing project or platform capabilities when they fit."

The first asks the SDK not to reinvent EDMX parsing, `$batch`
multipart envelopes, or full URL assembly. The second says: do not add
runtime dependencies the SDK does not need.

The design brief carves out the resolution path: "if no library clears
the 30 KB bar with batch + metadata, the design falls back to a
hand-rolled URL/EDMX/batch implementation and the constraint exception
note is updated."

## Selection criteria

| Criterion | Bar |
| --- | --- |
| License | Apache-2.0 / MIT compatible |
| Maintenance posture | Active commits / releases in the last 12 months; tagged 1.x or 2.x; not archived |
| TypeScript support | First-party `.d.ts` (not `@types/...` only); ESM build |
| Bundle size | < 30 KB minified+gzipped marginal cost on consumer apps; tree-shakable |
| Module shape | ESM with `"exports"` map; consumable by plain `tsc` (no required bundler step) |
| Runtime fetch hook | Allows injecting `HonuaClient.fetch` so we keep telemetry, auth, retry, and abort plumbing centralized — no parallel HTTP stack |
| `$batch` coverage | JSON (`application/json`) batch and atomicity groups (multipart/mixed acceptable as fallback) |
| `$metadata` coverage | EDMX/CSDL parser exposing entity sets, navigation properties, and `Capabilities.*` annotations |
| Spatial primitive support | Pass-through for `Edm.Geography` / `Edm.Geometry` literals |

## Candidates evaluated

| Library | Status | Disqualifier |
| --- | --- | --- |
| [`odata2ts`](https://github.com/odata2ts/odata2ts) | Strong TypeScript ergonomics, build-time codegen | **Build-time codegen** binds output to a known service schema. The SDK targets arbitrary OData services discovered at runtime; codegen cannot be adopted as a runtime dep. Recommended *to consumers* (see below) on top of the escape-hatch `raw(...)`. |
| [`@odata/client`](https://www.npmjs.com/package/@odata/client) | TypeScript-native runtime client | Bundles its own HTTP layer (no fetch-hook injection that composes with `HonuaClient.fetch`); maintenance posture has been thin in recent quarters; bundle audit shows it would land at the upper edge of the 30 KB bar before tree-shaking the unused `$batch` multipart path. Disqualified on the runtime-fetch-hook + maintenance criteria. |
| [`o.js`](https://www.npmjs.com/package/o.js) | Small fluent builder | Maintenance posture weak; no `$batch`; no `$metadata` parser. Fails coverage criteria. |
| [`simple-odata-client`](https://www.npmjs.com/package/simple-odata-client) | Node-first runtime | Bundles a heavyweight HTTP transport (`got`); pulls Node-only modules into the consumer bundle. Conflicts with the runtime-fetch-hook criterion and the SDK's browser-and-Node target. |
| [`odata-fluent-query`](https://www.npmjs.com/package/odata-fluent-query) | Query builder | Query-builder only — no `$batch`, no `$metadata`. Combining it with hand-rolled `$batch` + EDMX would defeat the wrap-not-rewrite intent without removing the dep. |

No candidate clears every bar.

## Decision

Implement the OData adapter as a thin URL/JSON serializer over
`HonuaClient.pipelineFetch` / `pipelineRequestJson` (the
`f=json`-free variants of the shared HTTP pipeline — the
GeoServices-shaped `request()` helper injects `f=json` and Honua
Server's OData validators reject it as `InvalidQueryOption`), the
same wrap-not-rewrite pattern every shipped adapter uses
(`HonuaOgcFeatureCollection`, `HonuaStacSearch`, `HonuaFeatureLayer`,
the GeoServices wrappers). Concretely:

- URL/query assembly for `$filter` / `$select` / `$orderby` / `$top` /
  `$skip` / `$expand` / `$count` / `$skiptoken` / `$apply` / `$search`
  / `$deltatoken` lives in `src/core/odata.ts` (`serializeQueryParams`).
- `$metadata` parsing is the small subset CSDL §6 documents: entity
  sets, entity-type keys, property names + `Edm.*` types,
  `Edm.Geography` typing + SRID, and `Capabilities.*` annotations
  (`parseOdataMetadata`).
- `$batch` uses the JSON batch format (OData v4 §11.7.7); multipart is
  not implemented — Honua Server emits both formats, the SDK uses the
  JSON envelope, and an external `$batch` consumer can call the typed
  escape hatch's `raw()` for multipart.
- All HTTP traffic flows through `HonuaClient.pipelineFetch` /
  `pipelineRequestJson` so the existing auth / retry / telemetry
  pipeline applies without a parallel request stack and without
  injecting GeoServices-only query params (`f=json`) onto the OData
  wire.

This satisfies the spirit of "wrap, don't rewrite" — the SDK does not
reimplement OData semantics, it serializes a constrained subset
documented in the parity matrix — and respects the project constraint
to minimize external libraries.

## Exit plan

The protocol surface (URL serializer, EDMX parser, `$batch` envelope)
is bounded to `src/core/odata.ts`. The contract translation in
`src/contract/source.ts` only knows about the SDK-shaped projections
(`HonuaOdataPage`, `HonuaOdataMetadata`, `HonuaOdataBatchOperation`,
`HonuaOdataAdvertisedCapabilities`). Swapping the implementation to a
future runtime library (or extending `$batch` to multipart) is a
focused `src/core/odata.ts` change, not a contract change. The
escape-hatch class `HonuaOdataEntitySet` keeps the public surface
stable through that swap.

## What we recommend to consumers

For service-specific TypeScript ergonomics layered over the SDK:

```ts
const entity = source.protocol("odata")!;
const raw = entity.raw.bind(entity); // fetch-hook–wrapped passthrough
// Plug in odata2ts here against `raw(...)` for codegen'd typings.
```

This keeps the SDK runtime small and lets ambitious integrations adopt
codegen on top without forcing every consumer to absorb it.

## Open questions for review

1. **Runtime library swap.** If the team prefers a wrapped runtime
   library, this ticket's decision should change to that library's pin
   and the swap landed as a follow-up PR. The contract surface and
   tests stay as-is.
2. **`$batch` multipart fallback.** Honua Server emits both formats.
   Adding multipart serialization is a localized addition to
   `HonuaOdataEntitySet.batch()`; it does not require a contract change
   and is a separate scope decision.
3. **Built-in vs `resolveSource` registration.** OData currently lives
   in `buildBuiltInSource` (consistent with every other shipped
   protocol). Removing it from that switch and exporting only
   `odataSource(...)` for `resolveSource` consumers tightens
   tree-shaking strictness; the per-side change is one switch arm.
