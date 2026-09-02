# Studio Package Contracts (`@honua/sdk-js/studio`)

Status: experimental, implemented for ticket `honua-sdk-js#230`.

`@honua/sdk-js/studio` is the single, browser-safe import path for the Studio
package families, their unified validation/preview envelopes, the capability
manifest, and the publish/share/embed contracts. It exists so Console browser
interop, MCP, QGIS, generated apps, and embeds **consume one set of
server-owned contract projections instead of forking their own package
schemas.**

```ts doc-test=compile
import {
  HONUA_QUERY_PACKAGE_FORMAT_V1,
  type HonuaStudioPackage,
  type StudioPackageValidationResponse,
  tagStudioPackage,
  toStudioValidationResponse,
} from "@honua/sdk-js/studio";
```

## MCP / QGIS safety

The barrel exports **only types and pure functions** and never imports from
`operator`, `esri-compat`, `web-components`, `interactions`, or `realtime` —
none of the MapLibre/DOM/Console-coupled modules. MCP servers and QGIS plugins
can import `@honua/sdk-js/studio` without pulling renderer code or triggering a
build error from Console/Esri internals. This boundary is enforced by a source
scan in `test/studio/studio-contracts.test.ts`.

The established `map` and `dashboard`/`app` shapes are re-exported here from
their leaf modules (`runtime/map-package`, `generated-app/manifest`), so a
consumer reaches every family from one path without taking on the MapLibre
runtime.

The `map` family additionally has a published JSON Schema,
[`schemas/honua-map-package.v1.json`](../schemas/honua-map-package.v1.json)
(`https://honua.io/schemas/honua-map-package.v1.json`). It is the canonical
description of the artifact for JS, the CLI, MCP, and Studio alike
(honua-sdk-js#1426), and it is not documentation *about* the validator — it is
what the validator is built from: `npm run map-package-schema:generate`
compiles it into the standalone function `validateMapPackage` runs, and
`test/runtime/map-package-schema-drift.test.ts` fails the build if the schema
and `HonuaMapPackage` stop agreeing. `exportMapPackage` / `importMapPackage`
(`@honua/sdk-js/runtime`) move that artifact between clients without embedded
credentials or unbounded data.

The schema deliberately stops at the artifact. Lifecycle states (ephemeral
preview, mutable draft, immutable saved version, publication proposal, active
publication, superseded), content-hash identity, optimistic concurrency, and
actor/tenant/authorization fields belong to the canonical honua-server
composition contract and are projected into the SDK through honua-sdk-js#1397
and #1398 — never minted client-side.

## Package families and format constants

Each family is gated by a `format` constant — the canonical version string,
exactly as on `MapPackage`. A loader refuses any other value.

| Family | Format constant | Format string | Projection type | Stability |
| --- | --- | --- | --- | --- |
| query | `HONUA_QUERY_PACKAGE_FORMAT_V1` | `honua_query_package.v1` | `HonuaQueryPackage` | experimental (stub) |
| analysis | `HONUA_ANALYSIS_PACKAGE_FORMAT_V1` | `honua_analysis_package.v1` | `HonuaAnalysisPackage` | experimental (stub) |
| map | `HONUA_MAP_PACKAGE_FORMAT_V1` | `honua_map_package.v1` | `HonuaMapPackage` | stable family, re-exported |
| dashboard | `HONUA_GENERATED_APP_MANIFEST_FORMAT_V1` | `honua_generated_app_manifest.v1` | `HonuaGeneratedAppManifest` | re-exported |
| report | `HONUA_REPORT_PACKAGE_FORMAT_V1` | `honua_report_package.v1` | `HonuaReportPackage` | experimental (stub) |
| form | `HONUA_FORM_PACKAGE_FORMAT_V1` | `honua_form_package.v1` | `HonuaFormPackage` | experimental (stub) |
| app | — (uses `HonuaGeneratedAppPackage.version`) | — | `HonuaGeneratedAppPackage` | re-exported |
| workflow | `HONUA_WORKFLOW_PACKAGE_FORMAT_V1` | `honua_workflow_package.v1` | `HonuaWorkflowPackage` | experimental (stub) |
| gp | `HONUA_GP_PACKAGE_FORMAT_V1` | `honua_gp_package.v1` | `HonuaGPPackage` | experimental (stub) |
| etl | `HONUA_ETL_PACKAGE_FORMAT_V1` | `honua_etl_package.v1` | `HonuaETLPackage` | experimental (stub) |

The **stub** families (query, analysis, report, form, workflow, gp, etl) have no
finalized server contract yet. Their interfaces are minimal and open-ended
(every field optional beyond `packageId`/`format`, plus `[extra: string]:
unknown`) so additive server changes never break a client. They expand once the
matching server contract lands. The `map` and generated-app (`dashboard`/`app`)
families are the established, landed shapes.

Lifecycle status is shared across families via `HonuaStudioPackageStatus`
(`"Draft" | "Composing" | "Ready" | "Failed" | "Expired"`), the same union as
`HonuaMapPackageStatus`.

### The `HonuaStudioPackage` discriminated union

`HonuaStudioPackage` is a union tagged by a client-side `packageFamily` field.
**The server wire shape does not carry `packageFamily`** — projection helpers
add it. Build a tagged value with `tagStudioPackage(family, pkg)` rather than
casting a raw wire object, then narrow on `packageFamily`:

```ts doc-test=skip reason="partial excerpt requires application host context"
const tagged = tagStudioPackage("query", rawQueryPackage);
if (tagged.packageFamily === "query") {
  // tagged is narrowed to { packageFamily: "query" } & HonuaQueryPackage
  console.log(tagged.querySpec?.where);
}
```

`STUDIO_PACKAGE_FAMILIES` enumerates every family discriminant and
`isStudioPackageFamily(value)` guards an untrusted string.

## Unified validation response

Every family returns the same `{ valid, diagnostics, pkg? }` shape through
`StudioPackageValidationResponse<T>`, so SDK, Console, MCP, and QGIS clients
consume one contract:

```ts doc-test=skip reason="partial excerpt requires application host context"
interface StudioPackageValidationResponse<T> {
  readonly valid: boolean;
  readonly diagnostics: readonly StudioPackageDiagnostic[];
  readonly pkg?: T;
}
```

The existing map-family `ValidateMapPackageResult` is **not renamed** — it is
structurally bridged:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { validateMapPackage } from "@honua/sdk-js/runtime";
import { fromMapPackageValidation } from "@honua/sdk-js/studio";

const response = fromMapPackageValidation(validateMapPackage(rawMapPackage));
// response: StudioPackageValidationResponse<HonuaMapPackage>
```

For other families, the generic adapter takes the field name holding the
package:

```ts doc-test=skip reason="partial excerpt requires application host context"
toStudioValidationResponse<HonuaQueryPackage>(rawQueryResult, "queryPackage");
```

`HonuaMapPackageDiagnostic` is already a structural subtype of
`StudioPackageDiagnostic` (it only adds `packageId?`), so map diagnostics flow
through unchanged. For convenience, `fromMapPackageValidation` and
`toStudioValidationResponse` are also re-exported from `@honua/sdk-js/runtime`
(tagged `@experimental`) so existing map-package consumers can bridge from the
path they already use.

`StudioPackagePreviewResponse<T>` is the parallel envelope for previewing a
package (composed without publishing), carrying optional `artifacts` and
diagnostics.

## Capability manifest

`StudioCapabilityManifest` lets a client gate UI/tool exposure on what the
connected server actually supports:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { hasCapability, getCapability } from "@honua/sdk-js/studio";

if (hasCapability(manifest, "package.query")) {
  // advertise the query builder
}
```

`hasCapability` is `true` only for an advertised **and available** capability;
`getCapability` returns the entry regardless of enabled state.

Every entry preserves the server-owned `lifecycle` and `optInRequired`
governance fields. Lifecycle remains an open string so future values are not
coerced to GA; missing governance fields raise
`HonuaCapabilityManifestContractError` instead of silently defaulting.

## Publish, share, and embed

`StudioPublishRequest<T>`, `StudioPublishResponse`, and `StudioEmbedConfig`
carry the versioned publication contract for generated artifacts.
`HonuaShareRequest` / `HonuaShareResponse` are **re-exported from
`control-plane/types`** (single source of truth — not re-declared) so Console
and MCP reach the share contract from the one `@honua/sdk-js/studio` path
without taking on the full control-plane client.

`StudioEmbedConfig.token` / `embedUrl` describe an **already-issued** embed
descriptor; the type does not imply a token-minting call inside the SDK.

## Generated apps

Generated apps consume published `map`, `dashboard`, `report`, and `app`
package projections from `@honua/sdk-js/studio` without importing Console or
MapLibre code — the `dashboard` family is `HonuaGeneratedAppManifest` and the
`app` family is `HonuaGeneratedAppPackage`, both re-exported here. For the
preview runtime that hydrates these manifests, see
[`docs/generated-app-runtime.md`](./generated-app-runtime.md).

## Versioning

Every new export is tagged `@experimental` in JSDoc and is subpath-only (not
re-exported from the root barrels), so it is outside the SDK semver contract
until the matching server contracts land. The format constants follow the
`HONUA_X_PACKAGE_FORMAT_V1 = "honua_x_package.v1"` pattern.

## Cross-surface parity (MCP / QGIS)

The parity layer that makes packages portable across Console, MCP, and QGIS —
a shared `provenance` envelope, a family-agnostic `validateStudioPackage`
helper, a documented Vega-Lite chart subset, and cross-surface fixtures — is
documented in [`studio-package-parity.md`](./studio-package-parity.md)
(`honua-sdk-js#226`).

## Open questions (pending server contracts)

These are tracked for follow-up once the server shapes are finalized:

- Whether `dashboard` is exactly `HonuaGeneratedAppManifest` or a distinct
  server `DashboardPackage` wrapper.
- Full ETL/workflow/GP package shapes (currently stub-only).
- Whether embed-token issuance is in scope for the SDK client.
- Whether the MCP server (`/mcp`) should import package/validation types from
  `@honua/sdk-js/studio` in a follow-on.
