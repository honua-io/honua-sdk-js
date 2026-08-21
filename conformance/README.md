# SDK contract conformance

This directory wires `@honua/sdk-js` into the **Compatibility Train**
(geospatial-grpc#18): every consumer SDK continuously round-trips the shared,
versioned `geospatial-grpc` conformance fixtures through the real
`HonuaClient` against a **pinned `honua-server:nightly`** and fails CI on any
drift in the protocol-neutral `Dataset` → `Source` → `Query` → `Result`
contract.

This is the gate that would have caught honua-server#1238 — a server-side
FeatureServer/OGC projection change that altered the on-the-wire response shape
and surfaced as production failures because nothing verified that real clients
still parsed those payloads.

## What lives here

- [`semantic-query/`](./semantic-query/) — the vendored, versioned semantic
  query equivalence corpus used by every query compiler. It carries one logical
  expected result per case plus explicit exact, approximate, or unsupported
  projections for GeoServices, CQL2, FES, OData, DuckDB, and gRPC. This lane is
  deterministic and always runs without a live server.

- `fetch-fixtures.sh` — the **committed helper** (delivered in
  geospatial-grpc#19) that SDK CI uses to pull a pinned fixture version. It
  downloads the release asset `conformance-fixtures-<version>.tar.gz` (+
  `.sha256`) from the `v<version>` GitHub Release of `honua-io/geospatial-grpc`,
  verifies the tarball SHA-256, extracts it, re-verifies every file against the
  in-tarball `SHA256SUMS`, asserts the embedded `VERSION` equals the requested
  pin, and leaves `fixtures/` (+ `manifest.txt`), `golden/`, `run.sh`, and
  `VERSION` in `--dest` (default `./conformance-fixtures-<version>/`).

  ```bash
  conformance/fetch-fixtures.sh --version 0.2.0-alpha.1 [--dest DIR] [--repo honua-io/geospatial-grpc]
  ```

The fixtures themselves are **not vendored** — they are pulled at CI time so a
fixture set always maps 1:1 to a `geospatial.v1` schema release (REQ-003).

## The conformance lane

- Test code: `test/conformance/`
  - `fixtures.ts` — loads/validates a fetched bundle (manifest, VERSION pin).
  - `mapping.ts` — translates the canonical `geospatial.v1` fixtures into the
    protocol-neutral `Query` and derives the expected `Result` contract from
    the golden. This is the only place that knows the `geospatial.v1` field
    names; golden drift changes the derived expectations.
  - `assert.ts` — pure drift detector: live `Result` vs golden-derived
    expectations (field names + types, geometry, attribute coverage,
    `exceededTransferLimit`, `totalCount`).
  - `harness.ts` — bridges the fixtures to a live `Dataset`/`Source`, reusing
    the integration lane's connect-only config, diagnostics, and reporter.
  - `feature-service.conformance.ts` — live round-trip for the `feature_query`
    workflow (FeatureServer + OGC Features — the #1238 regression class).
  - `known-gaps.conformance.ts` — KNOWN-EXPECTED-FAILING scenarios gated on
    tracked server defects (see below).
  - `drift-detection.test.ts` — the **effectiveness guardrail**: a negative
    test (runs in the normal unit lane, no server needed) proving a mutated
    golden is caught. This keeps the gate from being trivially always-green.
- Config: `vitest.conformance.config.ts`; run with `npm run test:conformance`.
- CI: the live round-trip runs in the `Integration + Conformance` job of
  `.github/workflows/integration.yml` (against the in-workflow self-contained
  server, or an external override); the always-on drift guardrail runs in the
  separate `Conformance Drift Guardrail` job so a server-bring-up flake can
  never mask a regression in the detector itself.

### Running locally

```bash
# 1. pull the pinned fixtures
conformance/fetch-fixtures.sh --version 0.2.0-alpha.1 --dest ./conformance-fixtures

# 2. point the lane at a live, seeded honua-server and the fixtures
export HONUA_INTEGRATION_BASE_URL=http://localhost:5555
export HONUA_INTEGRATION_API_KEY=...          # matches the server admin password
export HONUA_CONFORMANCE_FIXTURES_DIR=$PWD/conformance-fixtures
export HONUA_CONFORMANCE_FIXTURES_VERSION=0.2.0-alpha.1

npm run test:conformance
```

To reproduce CI's self-contained server locally (what the workflow does), run
the pinned image plus Redis and Postgres and apply the vendored seed before the
server boots — see the `Start self-contained Honua Server` step in
`.github/workflows/integration.yml` and `test/integration/seed/places-roads-v1.sql`.
That seed exposes service `test_service` / layer `0` / collection `0`, so set
`HONUA_INTEGRATION_SERVICE_ID=test_service` and `HONUA_INTEGRATION_LAYER_ID=0`.

When `HONUA_INTEGRATION_BASE_URL` or `HONUA_CONFORMANCE_FIXTURES_DIR` is unset
the lane degrades to an explicit, labelled no-op (`describe.skip`) — forks and
unconfigured pushes never report a false green.

## Pinned server image

The **test code** is connect-only — it round-trips against whatever
`HONUA_INTEGRATION_BASE_URL` points at and never owns server bootstrap. What
changed in honua-sdk-js#361 is that **CI now provides that server itself**: the
`Integration + Conformance` job in `.github/workflows/integration.yml` spins the
pinned image below plus Redis and Postgres inside the workflow, applies the
vendored seed (`test/integration/seed/places-roads-v1.sql`), waits for health,
and runs BOTH the surface matrix and this live conformance round-trip against
it — on every push to trunk and on a nightly `schedule:` cron, with no external
environment and no new secrets (image pulls use the workflow `GITHUB_TOKEN`).
An external base URL (repo variable / dispatch input) still overrides for
testing real deployments.

The lane pins and records the server under test into
`test-results/integration-meta.json`:

| Field | Value |
| --- | --- |
| Image | `ghcr.io/honua-io/honua-server@sha256:78e3088d64d832d3e2752c87d80bfcad201b414f4525989ca5d9a242cd5fee8a` |
| Server commit | `6d13c20fdf131a04cdfe2658ff84d3b55c3f5b76` |
| Candidate cut | `2026-08-20T07:58:03Z` |
| Digest | `sha256:78e3088d64d832d3e2752c87d80bfcad201b414f4525989ca5d9a242cd5fee8a` |
| Fixtures version | `0.2.0-alpha.1` |

The pin is set at workflow level in `.github/workflows/integration.yml`
(`HONUA_INTEGRATION_SERVER_IMAGE` / `HONUA_INTEGRATION_SERVER_COMMIT` /
`HONUA_CONFORMANCE_FIXTURES_VERSION`) and overridable via repo variables. The
vendored seed is kept 1:1 with the image pin. Advancing the pin (and refreshing
the seed alongside it) is a deliberate, reviewable change.

## Known, already-tracked server gaps (xfail)

These scenarios are wired but gated on tracked server-side defects. They are
registered as explicit `describe.skip` suites (KNOWN-EXPECTED-FAILING) that
record the surface as skipped **with the tracking issue** in the run metadata —
never a silent skip and never a blanket `continue-on-error`. The JOB stays
green and the harness stays in place, while any NEW / untracked drift still
FAILS (new drift surfaces in the live suites, not here). When a gap lands in
the server, flip the corresponding `knownGapConformanceSuite` to a live
`conformanceSuite` so the scenario becomes required.

| Surface | Tracking issue |
| --- | --- |
| FeatureServer/OGC JSONB attribute projection | honua-server#1238 |
| Temporal as-of / history | honua-server#1166 |
| Replica extract / sync | honua-server#1167 |
| Analysis list / estimate | honua-server#1237 |

The baseline `feature_query` shape IS covered live (geoservices + OGC) in
`feature-service.conformance.ts`; only the JSONB-typed projection sub-case of
#1238 is gated.
