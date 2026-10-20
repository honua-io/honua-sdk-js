# Portable map artifact lifecycle — pinned candidate receipt (#1426)

Receipt: [`map-artifact-lifecycle-candidate.json`](map-artifact-lifecycle-candidate.json), produced by
`scripts/map-artifact-lifecycle-receipt.mjs` against a deployment made by
`scripts/map-artifact-candidate-deployment.sh`.

**Verdict: not qualified.** 16 of 25 checks pass. The 9 failures are candidate defects, each filed with a
reproduction on the pinned image. None is a harness gap.

## Exact candidate and clients

| Item | Value |
| --- | --- |
| Server image | `ghcr.io/honua-io/honua-server@sha256:29974ee7b722e3ae15c3b891024e5e70800f412188aeccf5ec3d32d9dac675c1` (release PR #349 pin) |
| Server revision | `548b7a5263da5a3f2381eb43f232687cdf92b0bf` (image label checked) |
| Environment | Production, PostGIS 16-3.4, Redis 7.4, per-run key-ring certificate, static-key OIDC issuer |
| Defaults changed | `Licensing:Mode=Disabled` (2026.1 licensing ruling). `EnableTokenReplayProtection=false`, because with the default every bearer JWT is single-use and a bearer MCP session cannot make a second request (honua-server#4899). |
| JS SDK, MCP client, CLI | `@honua/sdk-js@0.1.9-beta.0` from registry.npmjs.org, integrity `sha512-xVJnTpZn…R5OQ==`, installed into an isolated consumer |
| Studio | `honua-io/honua-studio` `c7193a8efc34838dda8babdc10267d5e3687e9ea`, `src/lifecycle/lifecycle-client.ts` (Studio's own client), loaded with Node type stripping |
| Renderer | MapLibre GL `6.0.0` (registry) in Chromium 145 (SwiftShader WebGL 2) via `playwright-core` `1.58.2` |
| Determinism | Two independent runs produced the same projection digest, `032efa6a55d55c2f7bca05b8c419d211cb523183a778355596c9493339f2cbcc` |

Principals: `map-author` and `map-approver` (admin, tenant `public`), a scope-narrowed author token without
`honua.mcp.publish`, `map-viewer` (no role), and `map-foreign-admin` (admin, tenant `tenant-b`).

## Per-criterion disposition

### AC1: create, style, validate, preview pixels, save, reopen, publish through governed approval

Not met. The lifecycle itself works on the candidate; three defects block the criterion.

| Check | Verdict | Evidence |
| --- | --- | --- |
| `terminal-create-draft` | pass | Fixture persisted unchanged (canonical JSON). Generation 1, `valid`, audit/correlation ids, tenant `public`. |
| `terminal-style-and-view` | pass | `add_layer`, `set_layer_style`, `set_view` give generations 2→4. Layer, `styleRef` and view `[-157.8583, 21.3069]` zoom 9 are exactly as sent. |
| `terminal-validate-and-preview-is-not-persisted` | pass | Preview has no identity fields; neither pointer moved. |
| `terminal-save-immutable-version` | pass | Version 1, 64-hex content hash, current pointer set, not published. |
| `renderer-pixels-of-saved-artifact` | pass | Saved body rendered through the SDK's `applyStyleRefs` and MapLibre. Centre pixel `rgb(217,63,63)` is the bound `places-status` circle fill; corner is transparent; 440 ink pixels, i.e. one styled point. |
| `rendered-pixels-of-saved-version` | **fail** | Server PNG deliverable is blank: 0 ink outside the page rules, no fonts in the image, map never drawn. honua-server#4908 |
| `saved-version-is-immutable` | pass | Draft edited after save; version hash and body unchanged. |
| `terminal-reopen-version` | pass | New draft with `baseVersionId` = v1 and the identical body. |
| `terminal-proposes-publication` | pass | `AwaitingApproval` with operation, proposal, audit and correlation ids. No URL; not published. |
| `separate-principal-approval-activates-publication` | pass | `map-approver` approves: `Succeeded`, item `published`, handle `approved`, `activeUrl` = route, replayed approval refused. |
| `final-governed-url-resolves` | **fail** | `activeUrl` `/maps/<run>` returns 404 anonymously and authenticated; no route resolver exists. honua-server#4907 |

### AC2: JS, CLI, MCP and Studio round-trip the same fixture

Not met.

| Check | Verdict | Evidence |
| --- | --- | --- |
| `portable-fixture-valid-and-export-roundtrip` | pass | Installed `validateMapPackage` passes; `exportMapPackage`/`importMapPackage` round-trip with a deterministic fingerprint. |
| `js-sdk-reads-same-version` | pass | Installed `HonuaStudioLifecycleClient` returns the same hash and canonical body. |
| `studio-client-reads-and-reopens-same-version` | pass | Studio's `StudioLifecycleClient` gets the same hash and body, and reopens. |
| `mcp-js-studio-byte-identical-version-payload` | pass | MCP save, JS REST and Studio all return byte-identical body JSON. |
| `server-accepts-sdk-canonical-artifact` | **fail** | The SDK's own canonical showcase artifact, schema-valid, is refused as a map draft body: `initialView` without `bbox`, non-`url` locators. honua-server#4898 |
| `cli-publishes-portable-artifact` | **fail** | The installed CLI has no Studio lifecycle verbs. `honua map publish` → `POST /api/v1/admin/packages` refuses every package with an empty 400. honua-server#4906 |
| `js-sdk-rollback-request-uses-server-contract` | **fail** | Installed 0.1.9-beta.0 declares `{ versionId, pointer, message }`; the server binds `{ targetVersionId, pointer, reason }` → 400. Fixed on trunk by this PR; the installed candidate bytes still carry the drift until the next SDK release. |

### AC3: preview is never reported as persisted or published

**Met on the candidate.** `terminal-validate-and-preview-is-not-persisted` and `terminal-proposes-publication`
pass: preview carries no identity, and neither preview nor proposal moves a pointer or carries a URL.

### AC4: authorization, conflict, rollback and cross-tenant negatives fail closed

Not met.

| Check | Verdict | Evidence |
| --- | --- | --- |
| `terminal-stale-generation-fails-closed` | pass | Stale generation refused; draft unchanged. |
| `approval-negatives-fail-closed` | **fail** | Viewer 403 and tenant-b admin 404 are correct. The requester's own approval returns **200 `Succeeded`** and publishes. honua-server#4901 |
| `proposal-negatives-fail-closed` | **fail** | Wrong hash and the scope-narrowed token are refused. The tenant-b admin's proposal for tenant `public`'s item is **accepted**. honua-server#4905 |
| `cross-tenant-reads-fail-closed` | **fail** | The tenant-b admin reads tenant `public`'s version through the JS and Studio clients. honua-server#4905 |
| `supersede-then-rollback-restores-published-version` | **fail** | Restyled v2 renders `rgb(31,59,77)` and supersedes v1. The approved governed rollback restores v1 as published. The rollback requester approves their own rollback (200), and the tenant-b rollback request is accepted (202). honua-server#4901, honua-server#4905 |

### AC5: exact installed-package candidate, deterministic JSON receipts, final governed URL

Not met.

- Deterministic receipts: met locally. The receipt binds the registry integrity, image digest and Studio
  revision, and two runs produced the same projection digest.
- Final governed URL: fails (honua-server#4907).
- The receipt was produced on a workstation. A CI-attested producer lane can only qualify once the candidate
  defects above are fixed and re-pinned.

## Reproduce

```bash
openssl rand -hex 32 > "$RUNNER_TEMP/map-signing-key"
HONUA_MAP_CANDIDATE_IMAGE=ghcr.io/honua-io/honua-server@sha256:29974ee7b722e3ae15c3b891024e5e70800f412188aeccf5ec3d32d9dac675c1 \
HONUA_MAP_CANDIDATE_REVISION=548b7a5263da5a3f2381eb43f232687cdf92b0bf \
HONUA_MAP_ISSUER_SIGNING_KEY_FILE="$RUNNER_TEMP/map-signing-key" \
HONUA_MAP_CANDIDATE_DESCRIPTOR="$RUNNER_TEMP/map-candidate.json" \
  scripts/map-artifact-candidate-deployment.sh up

# Isolated consumer with registry bytes only
mkdir -p "$RUNNER_TEMP/consumer" && cd "$RUNNER_TEMP/consumer" && npm init -y >/dev/null
npm install --ignore-scripts @honua/sdk-js@0.1.9-beta.0 maplibre-gl@6.0.0 playwright-core@1.58.2 && cd -

# Studio's lifecycle client at a pinned revision, with .js specifiers pointed at the .ts sources
mkdir -p "$RUNNER_TEMP/studio"
for f in lifecycle-client lifecycle-errors lifecycle-types; do
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/honua-io/honua-studio/contents/src/lifecycle/$f.ts?ref=c7193a8efc34838dda8babdc10267d5e3687e9ea" \
    | sed -E 's#from "\./([a-z-]+)\.js"#from "./\1.ts"#' > "$RUNNER_TEMP/studio/$f.ts"
done

node --experimental-strip-types scripts/map-artifact-lifecycle-receipt.mjs \
  --descriptor "$RUNNER_TEMP/map-candidate.json" --signing-key-file "$RUNNER_TEMP/map-signing-key" \
  --consumer "$RUNNER_TEMP/consumer" --studio-client "$RUNNER_TEMP/studio" \
  --studio-revision c7193a8efc34838dda8babdc10267d5e3687e9ea \
  --output test-results/map-artifact-lifecycle-candidate.json
```
