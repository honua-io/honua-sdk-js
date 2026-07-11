# Generated App Runtime (`@honua/sdk-js/generated-app`)

Status: implemented for ticket `honua-sdk-js#140`.

The generated-app subpath is the SDK browser projection for the first
AI-generated operations dashboard proof. It consumes a versioned manifest from
`AppPackage.manifest_artifact`, hydrates the referenced `MapPackage` through
`@honua/sdk-js/runtime`, and binds map, table/list, count, chart, and filter
widgets through one `ExplorationContext`.

The subpath is intentionally separate from the root barrel and
`@honua/sdk-js/runtime`:

```ts
import {
  HONUA_GENERATED_APP_MANIFEST_FORMAT_V1,
  previewGeneratedApp,
} from "@honua/sdk-js/generated-app";
```

## Manifest Profile

| Export | Value | Purpose |
| --- | --- | --- |
| `HONUA_GENERATED_APP_MANIFEST_FORMAT_V1` | `honua_generated_app_manifest.v1` | Version gate for the browser manifest shape. |
| `HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1` | `operations-dashboard.v1` | Narrow proof profile. Other generated-app profiles are rejected with `HonuaGeneratedAppError { code: "unsupported-profile" }`. |
| `HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND` | `honua.generated-app.manifest` | `AppPackage.manifest_artifact.artifactKind`. |
| `HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION` | `1` | `AppPackage.manifest_artifact.artifactVersion`. |

The proof profile requires these widget kinds:

- `map` backed by a `MapPackage` and the MapLibre runtime.
- `table` or `list` backed by the manifest source binding.
- `count` over the current linked result set.
- `chart` grouped by a categorical field.
- `filter` over the same or another categorical field.

Unsupported widgets and missing required widgets produce structured preview
diagnostics instead of a blank host surface.

Map widgets bind feature-state and filter synchronization to
`widget.layerId` first, then `manifest.bindings.layerId`. The map widget's
`sourceLayer` is passed through to MapLibre feature-state calls when present.

## Canonical Mapping

The SDK does not define a competing canonical builder contract. The manifest is
the browser-safe projection of canonical builder/package output.

| Canonical source | Generated-app manifest/runtime field | Notes |
| --- | --- | --- |
| `BuildSpec.profile` / `BuildSpec.appProfile` | `manifest.profile` | Must project to `operations-dashboard.v1` for this slice. |
| `BuildSpec.appId` / `BuildSpec.id` | `manifest.appId` | Stable browser runtime identity and `ExplorationContext.datasetId`. |
| `BuildSpec.sourceId` / `BuildSpec.primarySourceId` | `manifest.data.sourceId` | Primary source used by table, count, chart, and filter widgets. |
| `BuildSpec.layout.widgets` / `BuildSpec.widgets` | `manifest.layout.widgets` | Widget ids and bindings consumed by `loadGeneratedAppRuntime`. |
| `BuildSpec.bindings` | `manifest.bindings` | Field bindings such as `primaryKey`, `titleField`, `categoryField`, `filterField`, `tableFields`, `searchFields`, and `layerId`. |
| `BuildSpec.initialState` | `manifest.initialState` | Optional initial `ExplorationState` seed. |
| `AppPackage.id` / `AppPackage.version` | `manifest.appId` / `manifest.version` fallback | `projectAppPackageToGeneratedAppManifest` fills these when the artifact omits them. |
| `AppPackage.manifest_artifact` / `AppPackage.manifestArtifact` | `HonuaGeneratedAppManifestArtifact` | Inline artifact with kind/version plus `manifest`. `manifest_artifact` is the preferred Portal handoff; the SDK also accepts a bare manifest for draft/test callers. |
| `MapPackage.mapPackageId` | `manifest.mapPackageId` | Used to verify the map asset referenced by the app package. |
| `MapPackage.sourceBindings[]` | `manifest.data.sourceId` plus runtime source ids | The generated runtime reuses `loadMapPackage`; source/protocol logic stays in `@honua/sdk-js/runtime`. |
| `MapPackage.mapSpec`, `legend`, `popupBindings`, `initialView` | map widget model / `HonuaMapRuntime` | The generated runtime does not duplicate map style, legend, popup, or view logic. |

When a `BuildSpec` or `MapPackage` projection omits widgets, the SDK creates
the proof dashboard's default map, table, count, chart, and filter widgets from
the supplied field bindings.

## Preview Host

Portal can consume an app package without duplicating widget or protocol logic:

```ts
const preview = await previewGeneratedApp(
  { appPackage, mapPackage },
  {
    mapFactory: () => ({ map: maplibreMap, dispose: () => maplibreMap.remove() }),
    mapLoadOptions: {
      client: honuaClient,
      popupFactory: () => new maplibregl.Popup(),
    },
  },
);

if (preview.status === "error") {
  renderPreviewErrors(preview.errors);
} else {
  renderDashboard(preview.model);
}
```

Manifests with a `map` widget require a `MapPackage`, `mapFactory`, and
`mapLoadOptions`. When `manifest.mapPackageId` is present, the resolved
`MapPackage.mapPackageId` must match before the SDK constructs the host map;
mismatches return a `map-package-mismatch` diagnostic. `mapFactory` returns the
host-owned MapLibre map plus an optional `dispose` callback. The SDK calls that
callback during normal runtime teardown and if the map loads but the initial
feature refresh fails.

For deterministic drafts or tests, pass `initialFeatures`. For live hosts,
the default loader queries the `HonuaMapRuntime.dataset` source with a bounded
`previewLimit` (`250` when unset) and applies categorical filters client-side.
Hosts that need realtime or larger server-side result windows should pass
`featureLoader` and still return `HonuaGeneratedAppFeatureInput[]`; the SDK
continues to own linked filtering, chart buckets, count values, table
selection, and map feature-state sync.

## Preview Response Contract

`previewGeneratedApp(input, options)` is the safest host entrypoint. It catches
projection, load, and render failures and returns a discriminated union:

| Status | Shape | Notes |
| --- | --- | --- |
| `ready` | `{ status, manifest, runtime, model, errors: [] }` | `manifest` is the resolved `HonuaGeneratedAppManifest`; `runtime` is the live `HonuaGeneratedAppRuntime`; `model` is the first rendered dashboard model. |
| `error` | `{ status, manifest?, errors }` | `errors` contains serializable `HonuaGeneratedAppDiagnostic` objects. `manifest` is present only when projection got far enough to resolve one. |

The ready `model` has stable top-level fields:

| Field | Meaning |
| --- | --- |
| `status` | Always `ready`. |
| `appId`, `title`, `sourceId` | Runtime identity and primary source binding. |
| `visibleCount`, `totalCount` | Filtered count and loaded-record count. |
| `widgets` | Ordered widget models matching `manifest.layout.widgets`. |
| `snapshot` | `ExplorationContext` snapshot for save/restore. |

Widget models are framework-neutral render data, not DOM instructions:

| Widget kind | Model fields |
| --- | --- |
| `map` | `loaded`, `mapPackageId`, `layerId`, `legend`, and `searchFields`; `layerId` uses the widget value with a manifest binding fallback. |
| `table` / `list` | `sourceId`, rendered `rows`, and visible `fields`; fields come from the widget, manifest table binding, or first-record inference. |
| `count` | `label` and numeric `value`. |
| `chart` | `sourceId`, `groupBy`, and selected/count-bearing `buckets` with source-qualified selection targets. |
| `filter` | `sourceId`, `field`, and selected/count-bearing `options`; explicit manifest option labels are preserved while observed values add counts. |

Use `HonuaGeneratedAppLoadOptions.onEvent` or `runtime.on(...)` to observe the
preview lifecycle. Events are `widget-bound`, `rendered`, `loaded`, `error`,
and `disposed`; they are intended for host telemetry and preview diagnostics.
Load-time failures can only reach `onEvent`, because no runtime handle exists
yet. Runtime events include stable payloads such as `appId`, `widgetId`,
`widgetKind`, `visibleCount`, or the structured `HonuaGeneratedAppError`.

## Runtime Interactions

`HonuaGeneratedAppRuntime` exposes:

- `render()` for the current widget models.
- `refresh()` to reload feature records.
- `setFilter(widgetId, value)` for filter widgets.
- `selectChartBucket(widgetId, value)` for categorical chart selection.
- `selectRecord(widgetId, id)` for table/list selection.
- `snapshot()` / `restore(snapshot)` over the underlying `ExplorationContext`.
- `dispose()` for map/runtime teardown.

Filter, chart, table, and map bindings all dispatch through the shared
`ExplorationContext`. The map path uses `syncMapLayerFilterToExploration` and
`syncFeatureStateSelection` when the host map exposes the relevant MapLibre
methods.

## Errors

`previewGeneratedApp` catches runtime/projection failures and returns
serializable diagnostics:

```ts
const diagnostic = {
  name: "HonuaGeneratedAppError",
  code: "missing-manifest-artifact",
  stage: "projection",
  message: "AppPackage is missing manifest_artifact for generated-app preview",
  detail: { path: "AppPackage.manifest_artifact" }
};
```

Call `loadGeneratedAppRuntime` directly when the host wants exceptions instead
of preview diagnostics. If map hydration succeeds and the initial feature load
then fails, the loader disposes the partially loaded `HonuaMapRuntime`, calls
the host map `dispose` callback, and `previewGeneratedApp` returns a
`data-load-failed` diagnostic.
