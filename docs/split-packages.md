# Advanced: split-package build target

For nearly all consumers the canonical install is the single `@honua/sdk-js`
package described in [`INSTALL.md`](../INSTALL.md). The repository also carries
an opt-in build target that produces six focused npm packages from the
same source tree, for downstream packagers and organizations that only want a
subset of the surface.

## Packages produced by the split build

| Package | Subpath equivalent | What it contains |
|---------|--------------------|------------------|
| `@honua/sdk` | `@honua/sdk-js/honua` + most stable subpaths | Core client, shared contract, query planner, offline-region contract, and plan-bound MapLibre adapter |
| `@honua/sdk-esri-compat` | `@honua/sdk-js/esri-compat` | Esri ArcGIS JS compatibility layer (incl. the `geometryEngine` shim) |
| `@honua/honua-migrate` | `@honua/sdk-js/migration` | Codemod runner + migration scanner |
| `@honua/react` | `@honua/sdk-js/react` | React provider, hooks, and map components (optional `react` / `react-dom` peers) |
| `@honua/geometry` | `@honua/sdk-js/geometry` | Curated turf/proj4 client-side geometry ops + reprojection |
| `@honua/app-platform` | (evicted from `@honua/sdk-js`) | Application-platform surfaces — app-shell/workspace/scene state, studio + generated-app builder contracts, operator controllers, native controls / web components, and hosted-product clients (control-plane, collaboration, share, operate, replica-sync). See [`decisions/scope-split-and-1.0.md`](./decisions/scope-split-and-1.0.md). |

Companion packages that carry a copy of the contract declare the exact
`@honua/sdk` version as a required peer. Their local contract forwards
capability-profile recognition to that peer, so an immutable profile created by
the core SDK remains valid across React, app-platform, geometry, and Esri-compat
boundaries without exposing the profile-registration authority.

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
- A downstream team that only consumes the migration codemod can install
  `@honua/honua-migrate` without pulling the full SDK surface.

## When *not* to use it

If you are writing an application that consumes the Honua server directly, install
`@honua/sdk-js` instead. The split packages are not the recommended consumer
install — they exist for packaging workflows, not for end users.

The monolithic package root is a reviewed common workflow, not an alias for all
split-package surfaces. Advanced imports use the focused subpaths in
[`INSTALL.md`](../INSTALL.md); every transition-era root symbol has an exact
replacement in the generated [`root import migration table`](./root-surface-migration.md).
