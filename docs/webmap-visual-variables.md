---
type: reference
title: "WebMap visual variables"
description: "Supported color and size ramps, scale conversion, field bindings, legends, and diagnostics for WebMap and compatibility renderers."
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
# WebMap visual variables

`convertRenderer`, `parseWebMap`, `webmapJsonToMapLibreStyle`, and compatibility
renderer projections share the visual-variable compiler. Conversion is pure:
it reads only supplied JSON and never fetches item metadata or feature values.

```ts doc-test=skip reason="partial excerpt requires caller-supplied WebMap JSON"
const result = parseWebMap(webmap, { fieldMap: { Speed: "speed" } });
```

Bindings apply to renderer classification fields and visual-variable fields.
Unmapped names retain their spelling. The caller supplies metadata from a
reviewed capture when a WebMap references a separate layer item.

Supported combinations:

| Variable | Symbols | Input |
| --- | --- | --- |
| `colorInfo` | Simple markers, lines, polygon fills | Numeric field and RGBA stops |
| `sizeInfo` | Simple markers, line widths | Numeric field or `$view.scale` stops |
| `sizeInfo`, `target: "outline"` | Polygon outlines | Numeric field or `$view.scale` stops |

Both stop arrays and fixed numeric `minDataValue`/`maxDataValue` and
`minSize`/`maxSize` ranges are supported for field size. Values outside the range
clamp to the endpoint. Missing, null, string and boolean field values retain the
base symbol for the matching class or category; they are not coerced to zero.
RGBA alpha is divided by 255 without rounding or applying it twice. Sizes in
WebMap JSON are points: one point is 96/72 CSS pixels. Marker size is a diameter,
so `circle-radius` receives half that pixel size. Polygon outline width is
represented by an additional line layer; direct `convertRenderer` consumers
must install `additionalLayers` alongside the primary layer.
Static marker radii, marker strokes and line widths are also converted to CSS
pixels when visual variables are present. Outline alpha, a shared dash pattern,
and null (invisible) outlines are preserved. Different dash patterns across
classes or categories require separate layers and produce a path-specific
`unsupported-renderer-semantics` warning.

`$view.scale` (and legacy `expression: "view.scale"`) uses **projected Web
Mercator scale at 96 DPI**, with MapLibre's 512-pixel zoom-zero world:

```
scale = (2 * PI * 6378137 * 96 / (512 * 0.0254)) / 2 ** zoom
```

The conversion reverses scale stops into ascending zoom stops and uses an
exponential interpolation base of 0.5. This exactly preserves linear
interpolation in scale, including between stops. A linear interpolation in zoom
would produce different widths. This convention is latitude independent;
ground resolution includes projection distortion, so it must not be substituted
for `$view.scale`. Use these styles with a Web Mercator map; globe, other
projections, 3D/pitched physical sizes and real-world-unit sizes are outside this
conversion contract.

These semantics follow Esri's [size visual-variable schema](https://developers.arcgis.com/web-map-specification/objects/sizeInfo_visualVariable/),
[screen size definition](https://developers.arcgis.com/web-map-specification/objects/size/),
and [Web Mercator spatial-reference convention](https://developers.arcgis.com/documentation/spatial-references/).

`visualVariableLegends` on conversion results and `visualVariableLegends()` on
compatibility renderer objects return continuous stop labels, exact alpha,
output size units, endpoint behavior and the original missing-value property
expression. `parseWebMap` stores this information in each primary layer's
`metadata["honua:visual-variable-legends"]`. Consumers presenting continuous
ramps should use this metadata together with the base categorical legend to
explain missing values. It is retained in serialized renderer descriptors.

Unsupported types, expressions, normalization, real-world units, nested
scale-dependent size ranges, malformed stops, and conflicting variables emit
`unsupported-visual-variable` with the input path. The first supported variable
for a property is applied; a second conflicting variable requires review.
Unsupported base renderer expressions/normalization emit
`unsupported-renderer-semantics`. Both warnings appear as manual gaps in the
MapLibre migration report and mark the content-WebMap report as requiring
manual intervention. Converted fallback styles remain inspectable.

The helicopter regression fixture extracts the renderer from public item
`1b496d1b79fd4344ab548a1f2399c5fa`. The September 23 recapture exactly matches the
run-004 source SHA-256
`c9baf813cdd54a9aa5c3b4f887c120806cfacbb1f7e4bde681eb265ee3331ec3`.
Its source stops and alpha are tested through MapLibre's actual expression
evaluator; no Esri service is called by the test. The browser regression measures
rendered pixel widths for markers, lines and outlines at two zooms and at
latitudes 0 and 60 degrees.
