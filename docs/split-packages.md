---
type: reference
title: "Advanced: split-package build target"
description: "For nearly all consumers the canonical install is the single `@honua/sdk-js`"
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
# Advanced: split-package build target

For nearly all consumers the canonical install is the single `@honua/sdk-js`
package described in [`INSTALL.md`](../INSTALL.md). The repository also carries
an opt-in build target that produces five focused npm packages from the
same source tree, for downstream packagers and organizations that only want a
subset of the surface.

## Packages produced by the split build

| Package | Subpath equivalent | What it contains |
|---------|--------------------|------------------|
| `@honua/sdk` | `@honua/sdk-js/honua` + most stable subpaths | `HonuaClient`, not `createHonua`. Also the shared contract, query planner, offline-region contract, and plan-bound MapLibre adapter |
| `@honua/sdk-esri-compat` | `@honua/sdk-js/esri-compat` | Esri ArcGIS JS compatibility layer (incl. the `geometryEngine` shim) |
| `@honua/react` | `@honua/sdk-js/react` | React provider, hooks, and map components (optional `react` / `react-dom` peers) |
| `@honua/geometry` | `@honua/sdk-js/geometry` | Curated turf/proj4 client-side geometry ops + reprojection |
| `@honua/app-platform` | (evicted from `@honua/sdk-js`) | Application-platform surfaces — app-shell/workspace/scene state, studio + generated-app builder contracts, operator controllers, native controls / web components, and hosted-product clients (control-plane, collaboration, share, operate, replica-sync). See [`decisions/scope-split-and-1.0.md`](./decisions/scope-split-and-1.0.md). |

Companion packages that carry a copy of the contract declare the exact
`@honua/sdk` version as a required peer. Their local contract forwards
capability-profile recognition to that peer, so an immutable profile created by
the core SDK remains valid across React, app-platform, geometry, and Esri-compat
boundaries without exposing the profile-registration authority.

A new 2D map imports `createHonua` from `@honua/sdk-js` and `maplibreRenderer` from `@honua/sdk-js/runtime`. Server attach uses `HonuaClient` from `@honua/sdk-js/honua`. An ArcGIS app uses `@honua/sdk-esri-compat` and `@honua/honua-migrate`. Widget paint registers `@honua/app-platform/web-components`. `@honua/sdk` is `HonuaClient`, not `createHonua`.

The migration package is no longer a generated SDK split. It is built from the
[`honua-migrate`](https://github.com/honua-io/honua-migrate) repository, while
`@honua/sdk-js/migration` remains a temporary forwarder. `src/migration/codemod.ts`
in this repository is the in-repo suite, not the npm program. See the
[transition policy](./migration-tool-transition.md).

## Optional gRPC-Web runtime

REST and open-protocol consumers do not install the Buf/Connect runtime, and a
production bundle of `createHonua` or `HonuaClient` does not resolve it. The
gRPC adapter is loaded only after `transport: "grpc-web"` is selected, through
a non-literal dynamic import, so Vite can build a REST client when the peers
are absent. Node resolves those peers when they are installed and
`transport: "grpc-web"` is selected. A browser bundler does not add the same
specifiers to the bundle, because they are not static literals. A missing peer
throws `HonuaOptionalGrpcPeerError` from the gRPC call; Connect and RPC
failures are not relabeled as a missing install. The connect facade's PMTiles
reader uses the same non-literal import, so a REST production build does not
resolve the optional `pmtiles` package either. Node still loads it when an
archive is described. `@honua/sdk-esri-compat` declares `maplibre-gl` as an
optional peer because compat map views load it by name. A REST Vite build can
omit that renderer; installing it still includes it in the bundle.

`config/installed-package-certification.v1.json` still lists
`@bufbuild/protobuf`, `@connectrpc/connect`, and `@connectrpc/connect-web` in
`consumerDependencies`. That pin is a temporary sample workaround for the
published `0.1.9-beta.0` tarball. It is not the packaging contract, and the
committed `test-results/installed-quickstart-budget.json` receipt that recorded
those installs stays in place.

A consumer that selects `transport: "grpc-web"` must install the optional peers
alongside the split SDK:

```bash
npm install @honua/sdk @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-web
```

## How to build the split tarballs

```bash
# from the repo root
npm install
npm run build
npm run build:split-packages
# tarballs land in dist/packages/* — npm pack each as needed
npm run pack:split-packages
```

## Why the split exists

- Some enterprise registries cap individual package size; the split keeps each
  tarball under that cap.
- A downstream team can install only the focused SDK surface it uses.

## When *not* to use it

If you are writing an application that consumes the Honua server directly, install
`@honua/sdk-js` instead. The split packages are not the recommended consumer
install — they exist for packaging workflows, not for end users.

The monolithic package root is a reviewed common workflow, not an alias for all
split-package surfaces. Advanced imports use the focused subpaths in
[`INSTALL.md`](../INSTALL.md); every transition-era root symbol has an exact
replacement in the generated [`root import migration table`](./root-surface-migration.md).
