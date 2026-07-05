# Advanced: split-package build target

For nearly all consumers the canonical install is the single `@honua/sdk-js`
package described in [`INSTALL.md`](../INSTALL.md). The repository also carries
an opt-in build target that produces three standalone npm packages from the
same source tree, for downstream packagers and organizations that only want a
subset of the surface.

## Packages produced by the split build

| Package | Subpath equivalent | What it contains |
|---------|--------------------|------------------|
| `@honua/sdk` | `@honua/sdk-js/honua` + most stable subpaths | Core client and shared contract |
| `@honua/sdk-esri-compat` | `@honua/sdk-js/esri-compat` | Esri ArcGIS JS compatibility layer |
| `@honua/honua-migrate` | `@honua/sdk-js/migration` | Codemod runner + migration scanner |
| `@honua/react` | `@honua/sdk-js/react` | React provider, hooks, and map components (optional `react` / `react-dom` peers) |

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
