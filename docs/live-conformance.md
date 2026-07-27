# Live SDK Conformance Lane

The live-conformance lane drives the **public SDK journeys** —
`connect()` → `HonuaConnection.inspection` → bounded source operations, plus
the operation-only `discoverOgcProcesses()` boundary — against a small,
reviewed set of **public reference services**. The lane covers Esri
GeoServices, OGC API Features (two independent implementations), raw OGC API
Records / Tiles / Maps / Processes, WFS 2.0, WMS 1.3, WMTS 1.0, STAC API, and
OData v4.

It exists to catch the class of drift that fixtures structurally cannot: a real
server changes a landing-page link, retires a conformance class, renames an
output format, or starts serving an error page with a `200` — and the SDK's
parsers, serializers, or capability negotiation quietly stop matching reality.

```bash
# scheduled/manual only; contacts third-party services
HONUA_LIVE_CONFORMANCE_ENABLED=true npm run evidence:live-conformance

# always-on, zero network: the same runner over deterministic stand-ins
npx vitest run test/live-conformance-evidence.test.ts
```

## Where it sits among the lanes

| Lane | What it proves | When it runs |
| --- | --- | --- |
| `npm test` (`test/live-conformance-evidence.test.ts`) | The runner's own contracts: manifest review policy, redaction, budgets, typed degradation, and the semantic assertions | Every commit, offline |
| `npm run test:conformance` | Pinned, versioned geospatial-grpc fixtures round-tripped through a pinned `honua-server:nightly` | Release-gated, deterministic |
| `npm run test:integration` | The public client against a real, seeded Honua Server we operate | Nightly |
| **live-conformance** | The public SDK journeys against **third-party** servers nobody here operates | Weekly schedule + `workflow_dispatch` |

The live lane is **never** part of pull-request CI. A third-party outage must
not be able to block a merge, and a lane that can be blocked by an outage is a
lane people learn to ignore.

## Files

| Path | Role |
| --- | --- |
| `config/live-conformance-endpoints.v1.json` | Versioned, reviewed endpoint manifest: one entry per target with owner, review expiry, provider attribution, journey, and expectations |
| `config/live-conformance-endpoints.schema.json` | JSON Schema for the manifest |
| `scripts/live-conformance-evidence.mjs` | The runner: bounded fetch seam, journeys, assertions, typed degradation, evidence emitter |
| `schemas/live-conformance-evidence.v1.json` | JSON Schema for the published artifact (`honua.sdk.live-conformance-evidence.v1`) |
| `test/live-conformance-evidence.test.ts` | Always-on offline lane |
| `test/helpers/live-conformance-reference-services.ts` | Deterministic stand-ins for the reviewed services |
| `.github/workflows/live-conformance.yml` | Scheduled workflow; uploads the artifact with `if: always()` |

`config/support-manifest.v1.json` carries a `live-conformance` evidence entry
(`kind: live`, `freshnessPolicy: scheduled-live`) that the GeoServices, OGC API
Features, Records, Tiles, Maps, operation-only Processes discovery, WFS, WMS,
WMTS, STAC, and OData support claims reference, so
`config/sdk-coverage.v1.json` shows this lane as evidence behind each claim.

## Journeys

Every enabled target runs discovery plus **at least one supported operation**.
Discovery alone would only prove that a document parsed.

**`query`** (GeoServices, OGC API Features, OGC API Records, STAC, WFS, OData)

1. `connect()` with the reviewed protocol and discovery narrowing.
2. Assert the resolved protocol, that the reviewed `sourceId` survived
   discovery, and that every expected capability resolved as *effective*.
3. Collect conformance evidence (below).
4. `explainQuery(..., { capabilityPolicy: "strict" })` when the protocol has a
   deterministic compiler: the plan must stay `exact` with zero losses and a
   bounded request count. STAC has no compiler; that is **recorded**, not faked.
5. `Source.query({ pagination: { limit: 1 } })` — one bounded page. Assert the
   limit was honoured, features parsed with typed attributes, geometry presence
   matches the review, and `Result.degraded` is empty.
6. Run the capability guard (below).

**`raster-tiles`** (WMS, WMTS)

1. `connect()` and assert `render`/`tiles` resolved as effective.
2. `projectRasterSourceToMapLibre()` and assert the protocol's strategy
   (`wms-raster` / `wmts-raster`) and a credential-free HTTPS template.
3. Fetch **one** bounded tile at the reviewed `z/x/y`, then assert HTTP 200, a
   media type the service advertised, and real image magic bytes — so an error
   page served as `image/jpeg` fails instead of passing.
4. Run the capability guard (below), against the same source the tile came
   from — `query` is unadvertised on every WMS/WMTS source.

**`ogc-tile`** (raw OGC API Tiles)

1. `connect()` and select the reviewed collection-backed `Source`.
2. Resolve its `ogc-tiles` protocol adapter and fetch exactly one reviewed
   tile matrix / row / column.
3. Assert the server-advertised vector-tile media type and a non-empty body.
4. Prove canonical `Source.query()` remains fail-closed because the source does
   not advertise `query`.

**`ogc-map`** (raw OGC API Maps)

1. `connect()` and select the reviewed collection-backed `Source`.
2. Resolve its `ogc-maps` protocol adapter and render one bounded 256-by-256
   map.
3. Assert the reviewed media type, a non-empty body, and image magic bytes.
4. Prove canonical `Source.query()` remains fail-closed because the source does
   not advertise `query`.

**`process-discovery`** (raw OGC API Processes)

1. Call `discoverOgcProcesses()` and require the reviewed process id,
   provenance, and effective `processes` capability.
2. Record operation-level discovery evidence with `sourceId: null` and
   `sourceCount: 0`.
3. Call `connect({ protocol: "ogc-processes" })` and require
   `discovery.unsupported-protocol` with a zero-request delta. This proves
   Processes remains operation-only and is never represented as a fake
   protocol-neutral `Source`.

**The capability guard**, on every source-backed journey: call one capability
the endpoint does **not** advertise and require
`HonuaCapabilityNotSupportedError`. This is
the SDK's headline contract ("capability gaps throw rather than return empty
data") and costs no requests, because the capability check precedes the wire.
A guard that cannot run — no resolvable source, or nothing unadvertised left to
probe — **fails the target**, and `validateLiveConformanceEvidence()` refuses to
publish an `executed` target whose `operation.capabilityGuard` is missing. The
lane may not claim it proved something it skipped.

## Operation and conformance-class evidence, not a protocol boolean

Each target records `discovery.capabilityDecisions`: every capability, whether
it is effective, the decision code, and the discovery evidence kinds behind it.
On top of that, `discovery.conformance` carries per-family truth:

| `conformance.kind` | Source | Recorded |
| --- | --- | --- |
| `ogc-features-conformance-classes` | `HonuaClient.getOgcFeaturesConformance()` | Advertised conformance-class URIs |
| `stac-landing-conformance-classes` | `HonuaClient.getStacLanding()` | STAC API conformance classes (e.g. `item-search`) |
| `capabilities-document-operations` | Discovered WMS/WMTS/WFS capabilities | Operation availability, advertised formats, and the reason when unavailable |
| `service-metadata-operations` | Capability decisions with metadata evidence | Per-operation availability for protocols with no class vocabulary |

A target may pin `expect.conformanceClasses`; if one disappears the lane fails
with `capability-regression` rather than silently continuing.

## Bounded by construction

All limits live in `budgets` in the endpoint manifest and are re-published in
the artifact. The runner hands the SDK a wrapped `fetch` that enforces:

- **GET/HEAD only**, same-origin with the reviewed endpoint, `credentials: "omit"`.
- **No redirects** (`redirect: "manual"`; a 3xx is a typed degradation). This is
  why the OData target is the redirect-free Northwind V4 root rather than
  TripPin, which issues session-scoped 302s.
- **Per-request timeout**, nested inside a per-target timeout, nested inside a
  run timeout; every request also carries the run's cancellation signal.
- **Request ceiling per target**, and **byte ceilings** per response
  (`maxResponseBytes`, per target) and per run (`maxTotalResponseBytes`, a
  single ledger shared by every target, so the published run ceiling is the
  real one). Both are enforced while streaming, so an unbounded body is
  cancelled mid-flight.
- **Retries** capped through the SDK client's own `retry.maxRetries`.
- **One page** (`limit=1`), **one tile**, or **one map** per source-backed
  target.
- **Media-type allowlist**: JSON/XML/text for metadata, reviewed image types
  for raster/map targets, and reviewed vector-tile types for raw OGC Tiles.
- **Credential refusal**: credential-shaped query parameters and auth headers
  are rejected before the request leaves the process.
- **Availability statuses classified in the seam**: 408, 429, and 5xx become
  typed transport errors inside the wrapped `fetch`, so an upstream outage on a
  directly fetched tile degrades the lane instead of reading as a broken
  serializer. If the SDK client wraps such a rejection in its own error, the
  innermost typed reason still wins.

## Redaction

The artifact is meant to be publishable. Endpoint identities are recorded as
origin + path (the manifest forbids query strings and fragments outright).
The request ledger records the method, path, status, byte count, media type,
and query parameter **names**; values are kept only for a reviewed
non-sensitive allowlist (`f`, `limit`, `bbox`, `typeNames`, `TILEMATRIX`, …).
`assertLiveConformanceEvidenceRedacted()` then sweeps the whole serialized
document for credential shapes and fails closed. `redacted: true` in the
artifact means both checks passed.

## Honest degradation

The lane separates *availability* from *semantics*:

| Situation | Target status | `degradation.state` | Typed code |
| --- | --- | --- | --- |
| DNS/socket failure | `degraded` | `unavailable` | `endpoint-unreachable` |
| Timeout, 408 | `degraded` | `unavailable` | `endpoint-timeout` |
| 5xx | `degraded` | `unavailable` | `endpoint-server-error` |
| 429 | `degraded` | `unavailable` | `endpoint-rate-limited` |
| 3xx | `degraded` | `unavailable` | `endpoint-redirect-refused` |
| Budget exhausted | `degraded` | `unavailable` | `budget-exceeded` |
| 4xx to an SDK-serialized request | **`failed`** | `unexpected` | `endpoint-client-error` |
| Expected capability or conformance class gone | **`failed`** | `capability-gap` | `capability-regression` |
| 200 that violates a semantic assertion | **`failed`** | `semantic-regression` | `semantic-assertion-failed` |
| Capability guard could not run | **`failed`** | `semantic-regression` | `semantic-assertion-failed` |
| Endpoint review expired | **`failed`** | `unexpected` | `endpoint-review-expired` |
| Target muted, mute unexpired | `skipped` | `muted` | `target-muted` |
| Mute expired | **`failed`** | `unexpected` | `mute-metadata-expired` |
| Lane not enabled | `skipped` | `muted` | `live-lane-disabled` |

Every reason carries `owner` and `expiresAt`, so no skip or degradation is
anonymous or permanent. A target failure never aborts the run: the remaining
targets still execute, so one outage cannot mask a real regression elsewhere.

Process exit codes: `0` all executed, `1` any semantic failure, `2`
availability-only degradation (`--allow-degraded` downgrades that to `0`).
A 4xx being a *failure* is deliberate — a `400`/`404` from a request the SDK
built is usually a serializer or manifest defect, which is exactly what this
lane exists to find.

## Adding or re-reviewing a target

1. Add an entry to `config/live-conformance-endpoints.v1.json`: credential-free
   HTTPS root, `provider`, `attribution`, `reliability`, `owner`, `reviewedAt`,
   `reviewExpiresAt` (within `defaults.reviewCadenceDays` of `reviewedAt`),
   `journey`, `expect`, and reviewer `notes` explaining why this endpoint is
   trustworthy and what it proves. Source-backed journeys also require
   `sourceId`; operation-only Processes discovery deliberately forbids it.
2. Add routes to `test/helpers/live-conformance-reference-services.ts` so the
   offline lane covers the new family, and extend
   `test/live-conformance-evidence.test.ts`.
3. Run the offline lane, then a manual live run
   (`HONUA_LIVE_CONFORMANCE_ENABLED=true npm run evidence:live-conformance`).
4. Bump the manifest `revision`.

To mute a target that has genuinely rotted, set `enabled: false` and supply
`skip` with `reasonCode`, `reason`, `owner`, `expiresAt`, and ideally
`tracking`. The mute itself expires: after `expiresAt` the target reports
`mute-metadata-expired` and fails the lane, so muting buys time instead of
silence.

## Endpoint selection policy

Targets are anonymous, credential-free, read-only, and bounded to a single
page, tile, map, or process-list request per operation — a courteous load on
services we do not own. Preference order is national-agency and cloud-reference
services first, then
vendor/community demos where they are the only realistic option (or where the
repo already records fixtures from them). Two independently implemented OGC API
Features servers are pinned on purpose: one vendor's landing-page shape must
never be able to pass for the standard.
