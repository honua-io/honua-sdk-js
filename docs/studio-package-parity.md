# Studio package parity: MCP, QGIS, and Console (`honua-sdk-js#226`)

Status: experimental, implemented for ticket `honua-sdk-js#226` (parity layer on
top of the package contracts from `honua-sdk-js#225`, see
[`studio-package-contracts.md`](./studio-package-contracts.md)).

The goal is that an AI-generated spatial output — a map, dashboard, report, or
app package — is **portable across Honua Studio/Console, MCP clients, and the
QGIS plugin** because all three use the same package contracts and the same
provenance shape, rather than surface-specific output formats. A package
produced through MCP or QGIS is validated by the SDK with one envelope and can
be opened in Console once Console supports the route.

```ts doc-test=compile
import {
  validateStudioPackage,
  validatePackageProvenance,
  getPackageProvenance,
  chartWidgetToVegaLiteSpec,
} from "@honua/sdk-js/studio";
```

## Provenance carried consistently

Every generated package may carry a `provenance` envelope
(`honua_package_provenance.v1`) under its open `[extra]` index signature. The
envelope records the same fields regardless of which surface generated it:

| Field | Meaning |
| --- | --- |
| `origin` | `console` / `studio` / `mcp` / `qgis` / `sdk` — the producing surface. |
| `prompt` | The natural-language prompt + model + capturing surface. |
| `plan` | The ordered generation steps and rationale the agent followed. |
| `dataBindings` | Which sources (and optionally query/layer) the output reads. |
| `permissions` | Capabilities required, each flagged `clientSide` true/false. |

`getPackageProvenance(pkg)` reads it off any package value (returns `undefined`
when absent or malformed); `validatePackageProvenance(pkg, { required })`
validates just the envelope. MCP- and QGIS-origin packages must satisfy the
same provenance shape as Console — there is no surface-specific variant.

## One validation envelope for packages produced outside Console

`validateStudioPackage(family, pkg, options)` validates a package of any family
produced by an MCP client, the QGIS plugin, or the SDK, returning the unified
`StudioPackageValidationResponse<T>` from `#225`. For the `map` family it
delegates to the established structural `validateMapPackage`; for the other
families it runs the shared base checks (identity field, `format`, lifecycle)
plus provenance checks when an envelope is present. Pass
`{ requireProvenance: true }` to make provenance mandatory.

```ts doc-test=skip reason="partial excerpt requires application host context"
const response = validateStudioPackage("dashboard", mcpDashboardPackage);
if (!response.valid) {
  for (const d of response.diagnostics) console.warn(d.code, d.message);
}
```

Fixtures for all four package variants — map-only, dashboard, report, app — live
in [`test/fixtures/studio-packages/`](../test/fixtures/studio-packages/) and are
shaped exactly as MCP/QGIS would emit them (`provenance.origin` of `mcp`/`qgis`).
They are openable by Console and exercised by
`test/studio/studio-package-parity.test.ts`.

## Charts use a documented Vega-Lite subset

Dashboard and report charts use a documented, compatible subset of Vega-Lite v5
(`HonuaVegaLiteChartSpec`) so a chart renders identically across surfaces. The
subset is `bar` / `line` / `point` / `arc` marks over a single positional
encoding pair plus an optional color channel — a structural subset of a real
Vega-Lite `TopLevelSpec`, consumable directly by `vega-embed` without
translation. `chartWidgetToVegaLiteSpec(widget, rows?)` derives a spec from a
generated-app chart widget:

| Generated-app `chartKind` | Vega-Lite mark | Encoding |
| --- | --- | --- |
| `categories` | `bar` | `x`: nominal group field, `y`: count |
| `histogram` | `bar` | `x`: binned quantitative field, `y`: count |
| `time-series` | `line` | `x`: temporal field, `y`: count or metric aggregate |

Anything outside the subset is not silently downgraded: when a widget lacks the
field its chart kind needs, `chartWidgetToVegaLiteSpec` returns `undefined` so a
host degrades cleanly instead of emitting a broken spec.

## Client-side preview vs. server execution

The SDK can preview the client-renderable parts of a package in a browser
without a server. Capabilities that need server execution are flagged on each
permission (`clientSide: false`) so a host reports an unsupported state cleanly
rather than rendering a silent partial.

| Capability | Client-side preview (SDK) | Requires server execution |
| --- | --- | --- |
| Validate any package (`validateStudioPackage`) | ✅ | — |
| Read/validate provenance | ✅ | — |
| Render a `map` package (MapLibre runtime) | ✅ | — |
| Derive a chart spec (`chartWidgetToVegaLiteSpec`) | ✅ | — |
| Hydrate a dashboard/app manifest preview | ✅ (with a feature loader) | — |
| Run live queries against a hosted/protected source | — | ✅ (auth, hosting) |
| Render a report to PDF / static artifact | — | ✅ (`report:render`) |
| Execute a GP / ETL / workflow package | — | ✅ |
| Publish / share / embed a package | — | ✅ (control-plane) |

A host should gate UI on this matrix together with the server's
`StudioCapabilityManifest` (`hasCapability` / `getCapability`): the manifest says
what the connected server supports; this table says what the SDK can do without
one.

## Versioning

Every new export is tagged `@experimental` and is subpath-only under
`@honua/sdk-js/studio`, outside the SDK semver contract until the matching
server contracts land. The provenance format follows the established
`HONUA_X_PACKAGE_FORMAT_V1 = "honua_x_package.v1"` pattern
(`HONUA_PACKAGE_PROVENANCE_FORMAT_V1 = "honua_package_provenance.v1"`).
