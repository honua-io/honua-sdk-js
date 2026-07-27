# Prebuilt browser bundle (CDN / build-less)

`@honua/sdk-js` ships ESM + TypeScript types as its canonical output, intended
for consumption through a bundler (Vite, webpack, esbuild, Rollup) or Node.
For static sites, quick prototypes, and CSP-strict pages that cannot run their
own bundler, the package also publishes a **prebuilt, self-contained browser
bundle** under `dist/browser/`.

This is an *additive* artifact — it does not change the ESM/`exports`/types
surface. Production apps should keep importing from `@honua/sdk-js` (and its
subpaths) through their bundler; the browser bundle exists only for build-less
consumers.

## Artifacts

| File | Format | Use |
| --- | --- | --- |
| `dist/browser/honua-sdk.min.js` | minified IIFE (`globalName: HonuaSDK`) | `<script>` tags, unpkg, jsDelivr |
| `dist/browser/honua-sdk.esm.js` | minified ESM | `<script type="module">`, esm.sh, native CDN imports |

Both ship with `.map` sourcemaps. The bundle targets `es2020`.

The `package.json` `browser`, `unpkg`, and `jsdelivr` fields point at the IIFE
build, and the `./browser` subpath export points at the ESM build, so ESM CDNs
that resolve subpaths (e.g. esm.sh) can serve it directly.

## Usage — global `<script>` (IIFE)

```html
<script src="https://cdn.jsdelivr.net/npm/@honua/sdk-js/dist/browser/honua-sdk.min.js"></script>
<script>
  // The reviewed root API of `@honua/sdk-js` is on window.HonuaSDK.
  const client = new HonuaSDK.HonuaClient({
    baseUrl: "https://your-honua-server.example",
  });

  const dataset = HonuaSDK.createDataset({
    id: "parcels",
    client,
    sources: [{ id: "parcels-fs", protocol: "geoservices", url: "https://.../FeatureServer/0" }],
  });
</script>
```

unpkg works the same way:

```html
<script src="https://unpkg.com/@honua/sdk-js/dist/browser/honua-sdk.min.js"></script>
```

## Usage — native ES module (ESM)

```html
<script type="module">
  import { HonuaClient, createDataset } from "https://esm.sh/@honua/sdk-js/browser";

  const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });
</script>
```

## What's bundled vs. external

The bundle is focused on the **core SDK public API** (everything re-exported
from `src/index.ts`). Its stable-core runtime dependency,
`@maplibre/maplibre-gl-style-spec`, is bundled in. The package manifest has two
other bounded direct dependencies: `@honua/honua-migrate` backs deprecated
migration forwarders outside the browser graph, and
`@mapbox/jsonlint-lines-primitives@2.0.2` temporarily pins style-spec's
existing parser so its new Node 22 engine metadata does not reject the
published Node 20 contract.

The heavy runtime *peers* are kept **external** so the artifact stays small and
does not inline multi-megabyte map/protobuf runtimes:

- `maplibre-gl`
- `cesium`
- `@bufbuild/protobuf`
- `@connectrpc/connect`
- `@connectrpc/connect-web`

If you use a part of the SDK that needs one of these (e.g. the MapLibre runtime
or gRPC transport), load that peer yourself — for the IIFE build, ensure it is
available on the page before the code path that needs it runs.

## Building the bundle

```bash
npm run build          # canonical tsc ESM + types output (dist/src)
npm run build:browser  # esbuild → dist/browser/*.js (+ .map)
```

`scripts/build-browser-bundle.mjs` bundles straight from `src/index.ts` using
the locally installed `esbuild`, so it does not strictly require `npm run build`
to have run first — but `npm run build:browser` is the documented entry point.
It is intentionally **not** wired into the CI `build` step so an esbuild option
mismatch can never break the main release build; run it explicitly (or at
publish time) to produce the artifact. The script smoke-checks that the IIFE
build defines the `HonuaSDK` global and prints the output sizes.

> Note: `dist/` is gitignored. The browser bundle is produced at build/publish
> time, not committed to source control. The `files` array in `package.json`
> includes `dist/browser` so the artifact is included in the published npm
> tarball.
