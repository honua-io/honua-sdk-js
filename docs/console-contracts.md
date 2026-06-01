# Console SDK contracts: ownership and parity (`honua-sdk-js#225`)

Status: experimental. The `@honua/sdk-js/console` subpath exposes browser-safe
contracts so [`honua-console`](https://github.com/honua-io/honua-console) can
consume the shared metadata / content / package model without copying server
DTOs or Portal-only types. The decision source is
`honua-console/docs/adr/0001-unified-honua-console-runtime.md`; the server
baseline is `honua-server#1162` (Console metadata v2 content + RBAC API).

```ts
import {
  // content + metadata v2
  type HonuaConsoleContentItem,
  type HonuaConsoleMetadata,
  type HonuaConsoleSharing,
  type HonuaConsoleEmbed,
  type HonuaConsoleProvenance,
  isKnownConsoleContentKind,
  // dashboards / reports + Vega-Lite
  projectDashboardPackage,
  projectReportPackage,
  chartWidgetToVegaLiteSpec,
  normalizeVegaLiteSpec,
  assertVegaLiteSpec,
  // map / app package catalog projections
  projectMapPackage,
  projectAppPackage,
  // typed Console errors
  HonuaConsoleError,
  toConsoleDiagnostic,
} from "@honua/sdk-js/console";
```

There is **no Console-specific copy** of these protocol types: Console imports
the SDK projection directly, and the SDK reuses the runtime
(`@honua/sdk-js/runtime`) and generated-app (`@honua/sdk-js/generated-app`) wire
types rather than redefining them.

## Contract ownership

Every Console contract is exactly one of three kinds. This is the load-bearing
distinction Console UI must respect: it never mutates a server-owned shape, it
trusts SDK-projected helpers to validate and narrow, and it owns only the render
state derived from a projection.

| Contract | Owner | Where |
| --- | --- | --- |
| Metadata v2 wire shape | **server-owned** | `honua-server` (`honua_metadata.v2`) |
| Content item wire shape | **server-owned** | `honua-server` |
| Sharing / embed / provenance wire shapes | **server-owned** | `honua-server`, RBAC API (`#1162`) |
| MapPackage (`honua_map_package.v1`) | **server-owned** | `honua-server`; typed in SDK `@honua/sdk-js/runtime` (`HonuaMapPackage`) |
| Generated AppPackage + manifest artifact | **server-owned** | `honua-server` builder; typed in `@honua/sdk-js/generated-app` |
| Dashboard / report package wire shape | **server-owned** | `honua-server` |
| `HonuaConsoleContentItem` / `HonuaConsoleMetadata` / `HonuaConsoleSharing` / `HonuaConsoleEmbed` / `HonuaConsoleProvenance` | **SDK-projected** | `src/console/content.ts` |
| `HonuaVegaLiteSpec` subset + `assert`/`is`/`normalize` | **SDK-projected** | `src/console/vega-lite.ts` |
| `projectDashboardPackage` / `projectReportPackage` / `chartWidgetToVegaLiteSpec` | **SDK-projected** | `src/console/dashboard.ts` |
| `projectMapPackage` / `projectAppPackage` catalog summaries | **SDK-projected** | `src/console/packages.ts` |
| `HonuaConsoleError` + diagnostics | **SDK-projected** | `src/console/errors.ts` |
| `*RenderModel`, `*Projection` UI state | **Console-rendered** | `honua-console` (derived from the above) |

- **server-owned** contracts are the canonical wire shapes. The SDK never
  invents fields; every projection interface keeps an open index signature
  (`[extra: string]: unknown`) so additive server fields survive a round-trip
  without a contract bump or a Console-side copy.
- **SDK-projected** contracts are the browser-safe, validated subset plus the
  projection helpers. They are the only place that decides "supported vs
  unsupported" and emit a typed {@link HonuaConsoleError} for the gaps Console
  needs to render (`unsupported-package-format`, `unsupported-chart-spec`,
  `missing-binding`, `missing-chart-spec`, `unsupported-content-kind`, …).
- **Console-rendered** state is owned by `honua-console`. The SDK ships the
  render *models* (`HonuaConsoleDashboardRenderModel`, the `*Projection`
  summaries) that Console hydrates; it does not own layout or routing.

## Packages: full runtime vs catalog projection

The package projections in `src/console/packages.ts` are deliberately **slim
catalog summaries** for content-browser and detail surfaces — they do not
replace the runtimes:

- To actually render a map, use `loadMapPackage` from `@honua/sdk-js/runtime`.
- To actually run a generated app, use `loadGeneratedAppRuntime` from
  `@honua/sdk-js/generated-app`.
- To list / inspect a package in the Console catalog (identity, status, source
  and layer counts, widget and chart-kind inventory, sharing, provenance), use
  `projectMapPackage` / `projectAppPackage`. Both gate on the package `format`
  and throw a typed `HonuaConsoleError` for an unsupported version or a missing
  manifest, so Console flags the broken entry instead of rendering a partial
  view.

## Vega-Lite chart specs

The SDK does not bundle Vega; it owns the **portable, validated chart-spec
shape** (`HonuaVegaLiteSpec`, a narrow single-view subset) so dashboard / report
packages can carry chart specs that round-trip cleanly between server, SDK
projection, and the Console renderer. `normalizeVegaLiteSpec` pins the SDK
`$schema` and the result re-validates through `assertVegaLiteSpec`.

`chartWidgetToVegaLiteSpec` bridges the generated-app chart-kind vocabulary
(`categories` / `histogram` / `time-series`) into a Vega-Lite spec, so a chart
defined for a generated app and a chart defined on a Console dashboard render
identically.

## MCP / QGIS / Console parity

These contracts describe the **same package artifacts** the MCP server and the
QGIS plugin consume. The chart-kind vocabulary and the package provenance
envelope are shared across all surfaces (see
[`studio-package-parity.md`](./studio-package-parity.md)). A package produced
through MCP or QGIS validates against the same SDK envelope and opens in Console
without a surface-specific format — there is one set of package contracts, not
one per surface.
