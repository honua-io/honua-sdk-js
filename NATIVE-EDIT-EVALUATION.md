# Native editing evaluation consumer

This branch adds only a consumer entry and reproducible browser bundle script to
merged SDK source `83a807301e15063ede9674646b827a7dde73b8b3` (PR #2548).
It does not change the SDK's product exports or transport behavior.

Build with Node 22.23.3 and the checked-in dependency lock on the build host:

```sh
remote-run bash -lc 'npm ci --ignore-scripts && node native-edit-evaluation-build.mjs'
```

Outputs under `artifacts/native-edit-evaluation/` are the ESM bundle and source map,
esbuild module graph, and provenance including dependency-lock and bundle hashes.
The script fails on external imports, missing public exports, or an invalid
function export after importing the emitted module. This is an import smoke test;
it does not establish a browser or installed-server pass.

The consumer exposes `HonuaClient` from the gRPC-Web entry, `createDataset`,
`geoServicesFeatureSource`, `createServiceEditSession`, and
`PROTOCOL_DEFAULT_CAPABILITIES`. Import all five from the emitted module when
running the native editing customer arc. Earlier Source-only browser artifacts
omit `createServiceEditSession` and cannot exercise its multi-layer session.

Live journeys and cleanup are specified in the lane's
`handoffs/grok-eval5/artifacts/s-grpc-edit/native-edit-customer-arc.md`.
All live cases remain NOT RUN until the verification owner records evidence
against an installed candidate with the required native RPCs.
