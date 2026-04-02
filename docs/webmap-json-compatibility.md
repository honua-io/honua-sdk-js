# WebMap JSON Compatibility Contract

This document defines the compatibility contract for `parseWebMap()` in `@honua/sdk-js/webmap`.

Version target: ArcGIS WebMap JSON `2.x` (current AGOL output).

## Output Contract

`parseWebMap(input)` returns:

- `style`: Honua/MapLibre style specification (`version: 8`)
- `warnings`: non-fatal compatibility warnings (`code`, `path`, `message`, optional `context`)
- `bookmarks`: passthrough WebMap bookmarks array
- `popups`: popup metadata keyed by operational layer id

Parser behavior:

- Unsupported or unknown properties are warnings, not throw conditions.
- Conversion aims to preserve visible map behavior for supported 2D properties.
- Unsupported 3D and complex Arcade flows are explicitly called out for manual intervention.
- The exploratory Cesium example under `docs/examples/cesium-route-playback/`
  consumes `HonuaClient.queryFeatures()` directly and does not expand
  `parseWebMap()` 3D support.

## Support Matrix

| WebMap JSON area | Support | Notes |
| --- | --- | --- |
| `operationalLayers` | Partial | `ArcGISFeatureLayer` and `ArcGISMapServiceLayer` supported |
| `baseMap` | Partial | Tiled basemap layers supported; vector basemap partial |
| `spatialReference` | Partial | Web Mercator (3857/102100/102113) and 4326 handling |
| `initialViewpoint` | Partial | `targetGeometry` point/extent + optional `scale` |
| `initialExtent` | Full | Converted to `center`/`zoom` |
| `bookmarks` | Full | Passed through in parser result |
| Simple renderer | Full | Converted to layer paint/layout |
| Unique value renderer | Full | Converted to `match` expressions |
| Class breaks renderer | Full | Converted to `step` expressions |
| Heatmap renderer | Unsupported | Warning emitted |
| Dot density renderer | Unsupported | Warning emitted |
| Popup `title`/`description` | Full | Preserved in popup config |
| Popup `fieldInfos` | Full | Preserved in popup config |
| Popup `mediaInfos` | Full (basic) | Preserved in popup config |
| Popup `expressionInfos` | Unsupported | Warning emitted; manual intervention |
| `labelingInfo` | Partial | Basic `$feature.FIELD` and simple concat only |
| 3D properties | Unsupported | Warning emitted; manual intervention |

## Warning Codes

Primary warning codes emitted by the parser:

- `unknown-property`
- `unsupported-webmap-version`
- `unsupported-renderer`
- `unsupported-symbol`
- `unsupported-layer-type`
- `unsupported-feature-collection`
- `unsupported-spatial-reference`
- `unsupported-viewpoint-geometry`
- `unsupported-arcade-expression`
- `unsupported-3d-property`
- `complex-arcade`
- `complex-label-expression`
- `vector-tile-partial`
- `sprite-required`

## Golden Fixtures

Golden fixtures live under:

- `test/fixtures/webmap-json/*/input.json`
- `test/fixtures/webmap-json/*/expected.json`

Fixture suite test:

- `test/webmap-parse.test.ts`

The suite is executed by `npm test`, which is required in CI (`.github/workflows/ci.yml`) on every PR and push to `trunk`.

## Manual Intervention Cases

Manual intervention is expected for:

- 3D scene properties and layer types
- complex Arcade expressions in labels/popups
- renderer types outside simple/uniqueValue/classBreaks
- inline `featureCollection` content
