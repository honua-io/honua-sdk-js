# OGC API Processes candidate replay (honua-io/honua-sdk-js#1328)

Status: **passed**. Generated 2026-09-16T19:20:26.933Z.

## Identity

- SDK: installed `@honua/sdk-js@0.1.9-beta.0` (`sha512-xVJnTpZnscV1exvoSGH/I1qbqhlxTy3FcldKJTCQe8N2gq5legwV8huu2FKGVmvi+/bc9pnvu4HobpsIGnR5OQ==`), sealed source `c99e71197dd940ed952aecb024c6de273456f2ae`, provenance verified; harness `d7877203ac0048b3a9c4dd3e0be697ec28cbfa07`
- Server: `ghcr.io/honua-io/honua-server@sha256:61e06ef3a94d00e4c8fc57ce93e008a5e31b2dcf1da5deb22781fdd42d2d4e51`, revision `2cc221388ea47d78c29e79eaee62737e4c792351`, running image id matches: true

## Result

| Criterion | Observation |
| --- | --- |
| No non-standard `Prefer` token | 20 requests; Prefer values sent: `respond-async` |
| Mode gates fail closed | sync-execute-undeclared (live): refused-locally `processes.sync-execute`; sync-execute-undeclared-strict (live): refused-locally `processes.sync-execute`; core-class-undeclared (derived): refused-locally `processes.execute`; async-execute-undeclared (derived): refused-locally `processes.async-execute` |
| Governed process reaches a terminal result | sync successful; async successful via accepted → successful; buffer oracle radius 0.00025 |
| Cancel as declared | dismiss declared: false; cancel refused, DELETE issued: false |
| Errors | unauthenticated execute → HTTP 401; invalid WKB → request-rejected HTTP 400; unknown process → HTTP 404 |

## Joins

- #39 receipt `test-results/installed-package-certification.json` `sha256:dd62f8c666719f36096e66b630eae97c1edb3796d640d53a2209c7c6bc74503e` (server `sha256:29974ee7b722e3ae15c3b891024e5e70800f412188aeccf5ec3d32d9dac675c1`, not-certified); same package bytes. No cell promoted.
  - `protocol-certification:ogc-processes:landing` (supported): #39 blocked by honua-sdk-js#39; this receipt observed-passing
  - `protocol-certification:ogc-processes:conformance` (supported): #39 blocked by honua-sdk-js#39; this receipt observed-passing
  - `protocol-certification:ogc-processes:list` (supported): #39 blocked by honua-sdk-js#39; this receipt observed-passing
  - `protocol-certification:ogc-processes:describe` (supported): #39 blocked by honua-sdk-js#39; this receipt observed-passing
  - `sdk-operation:ogc-processes-discovery-standalone:discovery` (supported): #39 blocked by honua-sdk-js#39; this receipt observed-passing
  - `sdk-operation:ogc-processes-execution-standalone:processes` (experimental, non-counting): #39 not-counted; this receipt observed-passing
- server nightly-container-build: https://github.com/honua-io/honua-server/actions/runs/35084811526 (Nightly Container Build, success, head `2cc221388ea47d78c29e79eaee62737e4c792351`)
- server ci: https://github.com/honua-io/honua-server/actions/runs/35085513511 (CI , success, head `2cc221388ea47d78c29e79eaee62737e4c792351`)
