# First Map troubleshooting

Use this guide for the canonical app in
[`examples/maplibre-quickstart`](../examples/maplibre-quickstart/README.md). Start with the deterministic lane:

```bash
npm run demo:quickstart:mock
```

If that lane fails, the problem is in the app, SDK, local browser, or fixture contract. It does not depend on a public
service or network-hosted basemap.

## Endpoint or protocol errors

First Map accepts an absolute HTTP(S) GeoServices FeatureServer layer or OGC API Features endpoint. The visible form
and `VITE_HONUA_QUICKSTART_ENDPOINT` use the same validator.

- Remove credentials, query parameters, and fragments from the endpoint URL. A sole `f=json`/`f=pjson` format hint is
  normalized away.
- Set `VITE_HONUA_QUICKSTART_PROTOCOL` to `auto`, `geoservices-feature-service`, or `ogc-features`.
- For an OGC service advertising multiple collections, choose the advertised source when prompted instead of relying
  on first-source selection.
- Do not use the retired base/service/layer composition variables. Supply the final endpoint.

Authentication failures remain `authentication-required`; unsupported operations remain `unsupported`; ambiguous
discovery remains `source-selection-required`. They never become an empty successful map.

## Browser network and CORS failures

An anonymous public endpoint must allow the browser origin. A command-line request can succeed while the browser is
still blocked by CORS.

- Confirm metadata and query responses allow the Vite/preview origin.
- Do not put API keys or bearer tokens in `VITE_*`; Vite publishes those values in JavaScript.
- Put protected traffic behind a server-side session/proxy flow. First Map intentionally has no sample-only auth
  fallback.
- Use `VITE_HONUA_QUICKSTART_BASEMAP_STYLE` only for a public style whose dependent assets are also reachable.

Required fixture Playwright actively aborts any HTTP(S) request outside its loopback origin. Public network evidence
runs only from `.github/workflows/first-map-live-evidence.yml` or with explicit local opt-in:

```bash
HONUA_FIRST_MAP_LIVE_ENABLED=true npm run evidence:first-map:live
```

## Bounds, geometry, and query plans

- Keep `VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT` a positive integer no greater than the workflow bound.
- Use `VITE_HONUA_QUICKSTART_WHERE` only when the source protocol supports the filter.
- Confirm the source returns point, line, or polygon geometry in browser-safe coordinates.
- Inspect the visible accepted plan. Partial pushdown, warnings, overflow, and renderer diagnostics are reported in the
  degradation panel rather than hidden.
- The query receipt fingerprint must match the plan passed to both `query()` and `mount()`.

## Source, freshness, and cache truth

The evidence panel distinguishes:

- endpoint and discovered protocol/source identity;
- advertised attribution versus “no attribution advertised”;
- SDK observation time versus unavailable source validity time;
- SDK metadata-cache status (`bypass`, `hit`, `miss`, or `refreshed`);
- exact execution versus explicit degradation reasons.

The scheduled live envelope and screenshot preserve the same fields. They do not replace deterministic fixture proof.

## Runtime and cleanup

Inspect:

- `window.__HONUA_QUICKSTART_EVENTS__`
- `window.__HONUA_QUICKSTART_RUNTIME__`
- `window.__HONUA_QUICKSTART_DISPOSE__()`

Useful runtime fields include `sourceProtocol`, `sourceId`, `sourceAttribution`, `sourceObservedAt`, `sourceFreshness`,
`cacheStatus`, `degradation`, `planFingerprint`, `featureCount`, `layerIds`, timing-budget fields, and cleanup state.
Disposal is idempotent and must remove the SDK mount, popup, handlers, and borrowed MapLibre resources within the
published cleanup budget.

## Validation

```bash
npm run demo:quickstart:typecheck
npm run demo:quickstart:test
npm run demo:quickstart:parity
npm run demo:quickstart:copyability
npm run demo:quickstart:build
npm run test:playwright:quickstart
```

The focused required command covers Chromium. The release workflow repeats the same test in Chromium, Firefox, and
WebKit and repeats source and packed SDK modes. If only the packed lane fails, inspect
`honua-sample-sdk-resolution.json` before changing the sample.
