# Error reference

The Honua JS SDK exposes a tagged error envelope from `@honua/sdk-js`. Public
errors migrated in the table below pass the cross-realm `isHonuaError(error)`
guard. Use their stable classifications to gate retry, refresh, fallback, and
surface-to-user decisions instead of parsing message strings.

This release covers core transport/auth/protocol errors, discovery, the query
planner, every public error exported by the stable `map` and `runtime`
subpaths, the public realtime resume error, and the offline region plus replica
synchronization classes migrated by
[#569](https://github.com/honua-io/honua-sdk-js/issues/569), plus the plugin
registry error migrated by
[#571](https://github.com/honua-io/honua-sdk-js/issues/571). Agent errors
([#570](https://github.com/honua-io/honua-sdk-js/issues/570)) remain an explicit
residual. Other experimental domains likewise retain their current
domain-specific contracts until a scoped migration lands.

## Envelope contract

Every migrated instance has these common fields:

| Field | Meaning |
|-------|---------|
| `kind` | Constant `"honua.sdk.error.v1"` tag used by the cross-realm guard. |
| `domain` | Stable broad owner: `core`, `discovery`, `query`, `map`, `runtime`, `realtime`, `offline`, or `plugin`. |
| `sdkCode` | Globally unique code from `HONUA_ERROR_CODE_REGISTRY`. |
| `category` | Stable `authentication`, `cancellation`, `capability`, `internal`, `network`, `protocol`, `timeout`, or `validation` classification. |
| `retryable` | Stable boolean for this exact `sdkCode`. This metadata describes the existing policy; it does not initiate retries. |
| `operationId` / `requestId` | Optional sanitized correlation identifiers when the throwing boundary has them. |
| `context` | Frozen sanitized context. Leaf adapters preserve bounded safe scalars and conservatively redact richer values; explicit structured boundaries use the recursive sanitizer. |
| `cause` | Original cause, retained on the in-process instance for debugging. |

Existing error-specific `.code` values remain compatible. For example,
`HonuaGrpcError.code` is still the numeric gRPC status and
`HonuaDiscoveryError.code` is still `"invalid-endpoint"` (or another legacy
discovery code). Use `.sdkCode` when one globally unique value is required.
`serializeHonuaError(error)` projects `.sdkCode` as the serialized envelope's
`.code`.

Serialization is deliberately fail-closed. `serializeHonuaError` and
`JSON.stringify(error)` include classification, identifiers, sanitized context,
and classification-only cause information. They omit raw messages, stacks,
response bodies, details, cause payloads, credentials, authorization/cookie
headers, cached feature bodies, raw cursors/resume tokens, signed URL values,
query/filter/SQL values, local storage paths, plugin manifests/configuration,
tool payloads, cleanup failures, binary payloads, and prototype-manipulation
keys. The raw instance still retains its message, documented detail fields,
exact cause, and documented cleanup aggregates for local use.

```ts doc-test=skip reason="partial excerpt requires application retry and logging hosts"
import { isHonuaError, serializeHonuaError } from "@honua/sdk-js";

try {
  await operation();
} catch (error) {
  if (!isHonuaError(error)) throw error;
  console.error(serializeHonuaError(error));
  if (error.category === "cancellation") return;
  if (error.retryable) scheduleRetry();
}
```

## At-a-glance table

| Class | Source | When it fires | Recover by |
|-------|--------|---------------|------------|
| `HonuaHttpError` | Any REST call | The server returned a non-2xx status with a parsed error envelope (4xx or 5xx). | Branch on `.statusCode`: `401`/`403` → refresh credentials or surface to user; `404` → treat as missing; `409` → conflict, refetch and retry; `429` → respect `Retry-After`; `5xx` → use the SDK's `retry` option or back off and retry idempotent calls. |
| `HonuaTimeoutError` | Any REST call | The `timeoutMs` configured on the client elapsed before the response arrived. | Increase `timeoutMs` per-call (the per-request `AbortSignal` is independent), or surface a "server slow" indicator. The request is idempotent-safe to retry. |
| `HonuaNetworkError` | Any REST call | The transport itself failed (`fetch` rejected) — DNS, TLS, offline, or upstream connection reset. | Inspect `.cause` if present; back off and retry. For browsers, this is also the most common error to render as "Check your connection." |
| `HonuaAbortError` | Any REST call | The caller's `AbortSignal` was aborted (or the SDK aborted on timeout — see `HonuaTimeoutError` for that case). | Do **not** retry. The caller asked to stop. Treat as a successful cancellation. |
| `HonuaGrpcError` | `transport: "grpc-web"` only | A gRPC-Web call returned a non-OK `Code`. | Branch on `.code` (Connect/`google.rpc.Code`): `UNAUTHENTICATED` → refresh credentials, `PERMISSION_DENIED` → surface; `UNAVAILABLE` → retry with backoff; `DEADLINE_EXCEEDED` → increase deadline or retry; `INVALID_ARGUMENT` → fix the call site. |
| `HonuaAuthError` | `@honua/sdk-js/auth` providers (`oauth2`, `clientCredentials`) | A credential could not be produced. | Branch on `.code`: `interaction_required` → start interactive sign-in (`auth.signIn()`); `refresh_failed` → transient token-endpoint failure, retry later; `invalid_grant` → refresh token/authorization code expired or revoked (the stored credential is cleared) → interactive sign-in. The underlying transport/parse failure, when present, is on `.cause`. |
| `HonuaCapabilityNotSupportedError` | `Source.query` / `Source.applyEdits` / etc. | Under the default `capabilityPolicy: "strict"`, the active source does not support the requested operation (e.g. `query()` on a `wmts` source). | Either downgrade the request (drop the unsupported clause), fall back to `Source.protocol(...)` for raw protocol access, or set `capabilityPolicy: "degraded"` on `createDataset` to coerce best-effort behavior with a `degraded` reason in the `Result`. |
| `HonuaDiscoveryError` | `connect`, discovery truth, cache identity | Endpoint metadata, protocol hints, source selection, or cached discovery observations are invalid or ambiguous. | Branch on `.code`: provide an explicit supported protocol for `ambiguous-protocol`; select a listed source ID for `ambiguous-source`; use a reviewed adapter for `unsupported-protocol`; evict/rebuild entries for `invalid-discovery-cache`. Do not retry unchanged invalid input. |
| `HonuaGeometryError` | Spatial-filter builders | Geometry classification would otherwise require guessing, or a recognized Esri geometry is malformed. | Branch on `.code`: `unknown-geometry` means no supported Esri shape discriminator was found; `malformed-geometry` means a recognized shape, coordinate, or envelope expansion is invalid. Fix the input; do not retry it unchanged. Diagnostic context is on `.detail`. |
| `HonuaExplorationContextError` | `@honua/sdk-js/exploration` | An exploration intent referenced a missing slice / view, or the snapshot is incompatible with the active context schema. | Surface to user (UI bug) or migrate the saved snapshot. Do not retry. |
| `HonuaWfsExceptionError` | `wfs` adapter | The WFS server returned a `<ows:ExceptionReport>`. The `exceptionCode`, optional `locator`, and formatted exception message are preserved on the instance. | Branch on `.exceptionCode` (`InvalidParameterValue`, `OperationNotSupported`, `MissingParameterValue`, etc.). Most are caller bugs; surface to user. |
| `HonuaJobFailedError` | OGC Processes / geoprocessing job polling | An async job (`IJobRun.results()`) reached a non-success terminal state (`failed` / `dismissed`). The terminal `.status`, `.errorCode`, and `.details` are preserved on the instance. | Branch on `.status` / `.errorCode`. Usually a server-side or input error; surface to user. Do not blindly retry. |
| `HonuaQueryPlanningError` / `HonuaQueryPlanExecutionError` | `@honua/sdk-js/query-planner` | Query validation/compilation/planning or accepted-plan execution fails. | Branch on the existing short `.code`; fix validation/context errors or choose a supported capability/fallback. |
| `HonuaMapLibreSourceAdapterError` | Root or `@honua/sdk-js/map` source workflow | Source projection, plan compatibility, identifier conflict, lifecycle, or renderer mutation fails. | Branch on the existing short `.code`; recreate disposed mounts and correct conflicts/options before retrying. |
| `HonuaDataToMapBridgeError` | `@honua/sdk-js/map` | The high-level bridge rejects options, renderer capabilities, conflicts, lifecycle, or mutation. | Correct options/host capability or recreate the mount. |
| `HonuaAutomaticMapLibreStrategyError` | `@honua/sdk-js/map` | Automatic strategy selection/mounting has no exact candidate, a stale plan, conflict, cancellation, disposal, or renderer failure. | Re-explain stale plans; treat cancellation as terminal; correct host conflicts/capabilities. |
| `HonuaMapLibreRasterStrategyError` | `@honua/sdk-js/map` | Raster strategy capability/metadata/options, identifiers, or renderer mutation fail. | Correct source truth/options or host conflicts; do not silently select a lossy fallback. |
| `HonuaAutomaticMapLibreIntegrationError` | `@honua/sdk-js/map` | Incremental integration is disposed or receives an invalid target. | Recreate the integration or correct the target. |
| `HonuaTemporalPlaybackError` | `@honua/sdk-js/map` | Playback options or temporal extent are invalid. | Correct input; do not retry unchanged input. |
| `HonuaMapPackageError` | `@honua/sdk-js/runtime` | Map-package fetch/load/validation/update/style/source/view/popup/disposal stage fails. | Branch on `.stage`; only fetch and disposal classifications are marked retryable. |
| `HonuaRuntimeDiagnosticError` | `@honua/sdk-js/runtime` | Runtime style/source/layer validation produces error diagnostics. | Inspect the local `.diagnostics` and correct invalid runtime input. Serialized context carries codes/count only. |
| `QueryTileServerResponseError` | `@honua/sdk-js/runtime` | Query-tile HTTP response is unsuccessful. | Inspect `.status`; transient HTTP statuses are classified retryable without changing request policy. |
| `HonuaRealtimeResumeError` | `@honua/sdk-js/realtime` | Realtime initialization, decoding, checkpoint, ordering, transport, or terminal delivery fails. | Branch on the existing reason `.code`; reconnect or request a replacement snapshot only when the stream contract already permits it. Envelope retryability is metadata and does not initiate reconnects. |
| `HonuaOfflineRegionError` | `@honua/sdk-js/offline` | Offline manifest validation, quota admission, resource loading, integrity verification, cancellation, or atomic store work fails. | Branch on the existing detailed `.code`. Rebuild invalid manifests, free quota, and treat abort as terminal. Retry through the application's loader/store policy only when `.sdkCode` is `offline.transport.transient`; generic loader failures remain conservative. Raw resource identifiers and storage paths remain local-only. |
| `HonuaReplicaSyncError` | `@honua/app-platform/replica-sync` (the deprecated `@honua/sdk-js/replica-sync` shim remains through 0.1.x) | Disconnected replica capability, conflict review/resolution, permission, validation, or transport work fails. | Branch on the existing detailed `.code` and preserve the current sync/conflict workflow. Only failures carrying a tagged retryable network/timeout cause receive retryable metadata; the envelope does not retry or resolve conflicts. |
| `HonuaPluginRegistryError` | `@honua/sdk-js/plugin` | Plugin registry validation, compatibility, policy, capability, activation, execution validation, cancellation, or cleanup fails. | Branch on the existing `PLUGIN_*` `.code` or its grouped `.sdkCode`. Correct declarations or host policy/capability, treat cancellation as terminal, and inspect `.cause` / `.cleanupErrors` locally for activation or cleanup failures. No plugin classification is automatically retryable. |

## Registered code families

The exported `HONUA_ERROR_CODE_REGISTRY` is the canonical, typed inventory. Its
object keys are globally unique at compile time, the common base accepts only
registered codes, and domain constructors either reject unknown runtime reasons
or project them to a fixed registered fallback. Focused entrypoints retain only
the code/domain/category/retryability classifications needed by the error base;
human-readable registry summaries remain in the explicit public registry.
`npm run check:error-codes` verifies exact classification parity, registry shape,
and this class/family documentation.

### Tree-shaking and explicit costs

Focused subpaths such as `@honua/sdk-js/realtime`, `offline`, `routing`,
`geocoding`, and `auth` retain only the leaf error base plus classifications
owned by the imported error classes. They do not retain the complete runtime
classification table, descriptive registry, or full cross-realm serializer.
The leaf boundary keeps safe scalar diagnostics, uses fixed `reasonCode`
contexts for closed reason unions, and redacts richer values conservatively.

Importing `serializeHonuaError` or the root `isHonuaError` guard explicitly
retains the compact runtime classification table needed for cross-realm
validation. Importing `HONUA_ERROR_CODE_REGISTRY` intentionally adds the
human-readable descriptors. `sanitizeHonuaErrorContext` remains available for
boundaries that need the complete bounded recursive sanitizer.

The generated [tree-shaking evidence](./error-tree-shaking.md) records the six
contractual gzip reductions and exact retained error modules. Regenerate it
with `npm run report:bundle-sizes`; `npm run verify:bundle-budgets` rejects
stale evidence, and `npm run verify:packed-sdk` repeats the public-import
fixtures against the packed tarball.

| Public class | Registered `sdkCode` family |
|--------------|-----------------------------|
| `HonuaHttpError` | `core.http.transient`, `core.http.rejected` |
| `HonuaTimeoutError` | `core.timeout` |
| `HonuaNetworkError` | `core.network` |
| `HonuaAbortError` | `core.cancelled` |
| `HonuaGrpcError` | `core.grpc.transient`, `core.grpc.rejected` |
| `HonuaGeometryError` | `core.geometry.unknown-geometry`, `core.geometry.malformed-geometry` |
| `HonuaAuthError` | `core.auth.interaction-required`, `core.auth.refresh-failed`, `core.auth.invalid-grant` |
| `HonuaCapabilityNotSupportedError` | `core.capability-not-supported` |
| `HonuaExplorationContextError` | `core.exploration-context` |
| `HonuaWfsExceptionError` | `core.wfs-exception` |
| `HonuaJobFailedError` | `core.job-failed` |
| `HonuaWmsCapabilitiesParseError` | `core.wms-capabilities-parse` |
| `HonuaWmtsCapabilitiesParseError` | `core.wmts-capabilities-parse` |
| `HonuaDiscoveryError` | `discovery.*` (the eight values in `HonuaDiscoveryErrorCode`) |
| `HonuaQueryPlanningError` | `query.planning.*` (the six values in `QueryPlanningErrorCode`) |
| `HonuaQueryPlanExecutionError` | `query.execution.*` (the three values in `QueryPlanExecutionErrorCode`) |
| `HonuaMapLibreSourceAdapterError` | `map.source-adapter.*` |
| `HonuaDataToMapBridgeError` | `map.data-bridge.*` |
| `HonuaAutomaticMapLibreStrategyError` | `map.automatic-strategy.*` |
| `HonuaMapLibreRasterStrategyError` | `map.raster-strategy.*` |
| `HonuaAutomaticMapLibreIntegrationError` | `map.automatic-integration.*` |
| `HonuaTemporalPlaybackError` | `map.temporal-playback.invalid-option` |
| `HonuaMapPackageError` | `runtime.map-package.*` (one code per public stage) |
| `HonuaRuntimeDiagnosticError` | `runtime.diagnostic` |
| `QueryTileServerResponseError` | `runtime.query-tiles.transient`, `runtime.query-tiles.rejected` |
| `HonuaRealtimeResumeError` | `realtime.cancelled`, `realtime.transport.reconnectable`, `realtime.checkpoint.invalid`, `realtime.sequence.gap`, `realtime.protocol.terminal` |
| `HonuaOfflineRegionError` | `offline.region.validation`, `offline.region.quota`, `offline.region.integrity`, `offline.cancelled`, `offline.transport.failure`, `offline.transport.transient`, `offline.storage.*` |
| `HonuaReplicaSyncError` | `offline.replica-sync.capability`, `offline.replica-sync.validation`, `offline.replica-sync.permission-denied`, `offline.transport.failure`, `offline.transport.transient` |
| `HonuaPluginRegistryError` | `plugin.registry.validation`, `plugin.compatibility`, `plugin.execution.policy-denied`, `plugin.capability-unavailable`, `plugin.lifecycle.activation`, `plugin.execution.validation`, `plugin.lifecycle.cleanup`, `plugin.cancelled`, `plugin.internal` |

`HonuaRealtimeResumeError.code` remains the existing detailed reason (for
example, `invalid-checkpoint`, `sequence-gap`, `transport-gap`, or
`delivery-failed`). Its `sdkCode` groups those reasons into stable recovery
classes. `realtime.transport.reconnectable` and `realtime.sequence.gap` are
marked retryable because the existing contract permits reconnect or replacement
snapshot recovery; the envelope does not perform either action. SSE abort,
unsubscribe, and close still complete normally without emitting an error.

`HonuaOfflineRegionError.code` and `HonuaReplicaSyncError.code` likewise retain
their detailed legacy reasons. Their grouped `sdkCode` values distinguish
invalid state, quota/storage, cancellation, integrity, capability, permission,
and transport recovery classes. Generic resource/replica transport failures are
non-retryable by default; `offline.transport.transient` is selected only when the
wrapped cause is itself a valid tagged, retryable network or timeout error. Raw
cached content, sync cursors, signed URLs, filter values, resource locators,
details, and filesystem paths are kept on the local error instance only;
serialization emits a fixed registered reason and classification. Retryability
is descriptive and does not alter offline eviction, commit, transport, or
conflict-resolution policy.

`HonuaPluginRegistryError.code` remains the existing `PLUGIN_*` reason and
`cleanupErrors` remains a frozen shallow copy of cleanup failures. The grouped
`sdkCode` distinguishes registry validation, compatibility, host-policy denial,
missing capability, activation, execution validation, cleanup, cancellation,
and internal failures. Every plugin classification is conservatively
non-retryable. Serialization emits only the registered classification and a
fixed known `reasonCode`; it never emits manifests, plugin/configuration IDs,
raw cause payloads, or cleanup payloads. Unknown runtime codes project to
`plugin.internal` with `reasonCode: "PLUGIN_UNKNOWN"` without changing a valid
string's local legacy `.code` or message.

### Individual code registry

<!-- error-code-registry:start -->
| Registered code | Domain | Category | Retryable | Summary |
|-----------------|--------|----------|-----------|---------|
| `core.http.transient` | `core` | `protocol` | yes | Retryable HTTP response failure |
| `core.http.rejected` | `core` | `protocol` | no | Non-retryable HTTP response failure |
| `core.timeout` | `core` | `timeout` | yes | Request deadline elapsed |
| `core.network` | `core` | `network` | yes | Network transport failure |
| `core.cancelled` | `core` | `cancellation` | no | Caller cancelled the operation |
| `core.grpc.transient` | `core` | `protocol` | yes | Retryable gRPC-Web transport failure |
| `core.grpc.rejected` | `core` | `protocol` | no | Non-retryable gRPC-Web transport failure |
| `core.geometry.unknown-geometry` | `core` | `validation` | no | Geometry shape cannot be classified safely |
| `core.geometry.malformed-geometry` | `core` | `validation` | no | Recognized geometry has invalid coordinates or structure |
| `core.auth.interaction-required` | `core` | `authentication` | no | Interactive authentication is required |
| `core.auth.refresh-failed` | `core` | `authentication` | yes | Credential refresh failed transiently |
| `core.auth.invalid-grant` | `core` | `authentication` | no | Authorization grant is invalid or expired |
| `core.capability-not-supported` | `core` | `capability` | no | Requested source capability is unavailable |
| `core.exploration-context` | `core` | `validation` | no | Exploration context operation is invalid |
| `core.wfs-exception` | `core` | `protocol` | no | WFS exception report |
| `core.job-failed` | `core` | `protocol` | no | Remote job reached a failed terminal state |
| `core.wms-capabilities-parse` | `core` | `protocol` | no | WMS capabilities document is invalid |
| `core.wmts-capabilities-parse` | `core` | `protocol` | no | WMTS capabilities document is invalid |
| `discovery.ambiguous-protocol` | `discovery` | `validation` | no | Multiple protocols match the endpoint |
| `discovery.ambiguous-source` | `discovery` | `validation` | no | Multiple sources match the selection |
| `discovery.invalid-endpoint` | `discovery` | `validation` | no | Discovery endpoint is invalid |
| `discovery.invalid-cache-identity` | `discovery` | `validation` | no | Discovery cache identity is invalid |
| `discovery.invalid-discovery-cache` | `discovery` | `validation` | no | Discovery cache entry is invalid |
| `discovery.invalid-capability` | `discovery` | `validation` | no | Discovered capability evidence is invalid |
| `discovery.unsupported-protocol` | `discovery` | `capability` | no | Endpoint protocol is unsupported |
| `discovery.protocol-mismatch` | `discovery` | `validation` | no | Endpoint protocol conflicts with its hint |
| `query.planning.invalid-query` | `query` | `validation` | no | Query is invalid |
| `query.planning.unsupported-compiler` | `query` | `capability` | no | No compiler supports the source protocol |
| `query.planning.unsupported-query` | `query` | `capability` | no | Query cannot be represented by the compiler |
| `query.planning.capability-not-supported` | `query` | `capability` | no | Query requires an unavailable capability |
| `query.planning.fallback-disabled` | `query` | `capability` | no | Required local fallback is disabled |
| `query.planning.unsafe-materialization` | `query` | `validation` | no | Planned local materialization exceeds its safety bound |
| `query.execution.invalid-plan` | `query` | `validation` | no | Query plan is invalid |
| `query.execution.plan-context-mismatch` | `query` | `validation` | no | Execution context does not match the accepted query plan |
| `query.execution.unsafe-materialization` | `query` | `validation` | no | Query execution exceeded its materialization bound |
| `map.source-adapter.disposed` | `map` | `validation` | no | Map source adapter is disposed |
| `map.source-adapter.source-conflict` | `map` | `validation` | no | Map source identifier already exists |
| `map.source-adapter.layer-conflict` | `map` | `validation` | no | Map layer identifier already exists |
| `map.source-adapter.unsupported-plan` | `map` | `capability` | no | Query plan cannot be rendered by the source adapter |
| `map.source-adapter.invalid-option` | `map` | `validation` | no | Map source adapter option is invalid |
| `map.source-adapter.map-mutation-failed` | `map` | `internal` | no | Renderer mutation failed |
| `map.data-bridge.invalid-option` | `map` | `validation` | no | Data-to-map option is invalid |
| `map.data-bridge.disposed` | `map` | `validation` | no | Data-to-map bridge is disposed |
| `map.data-bridge.source-conflict` | `map` | `validation` | no | Data-to-map source identifier already exists |
| `map.data-bridge.layer-conflict` | `map` | `validation` | no | Data-to-map layer identifier already exists |
| `map.data-bridge.map-mutation-failed` | `map` | `internal` | no | Data-to-map renderer mutation failed |
| `map.data-bridge.interaction-unsupported` | `map` | `capability` | no | Renderer interaction is unsupported |
| `map.data-bridge.filter-unsupported` | `map` | `capability` | no | Renderer filter mutation is unsupported |
| `map.automatic-strategy.no-eligible-strategy` | `map` | `capability` | no | No exact map source strategy is eligible |
| `map.automatic-strategy.stale-plan` | `map` | `validation` | no | Map strategy plan is stale |
| `map.automatic-strategy.source-conflict` | `map` | `validation` | no | Automatic strategy source identifier already exists |
| `map.automatic-strategy.layer-conflict` | `map` | `validation` | no | Automatic strategy layer identifier already exists |
| `map.automatic-strategy.map-mutation-failed` | `map` | `internal` | no | Automatic strategy renderer mutation failed |
| `map.automatic-strategy.cancelled` | `map` | `cancellation` | no | Automatic map strategy was cancelled |
| `map.automatic-strategy.disposed` | `map` | `validation` | no | Automatic map strategy is disposed |
| `map.raster-strategy.unsupported-strategy` | `map` | `capability` | no | Raster strategy is unsupported |
| `map.raster-strategy.capability-mismatch` | `map` | `capability` | no | Raster source lacks a required capability |
| `map.raster-strategy.missing-metadata` | `map` | `validation` | no | Raster source metadata is incomplete |
| `map.raster-strategy.invalid-option` | `map` | `validation` | no | Raster option is invalid |
| `map.raster-strategy.source-conflict` | `map` | `validation` | no | Raster source identifier already exists |
| `map.raster-strategy.layer-conflict` | `map` | `validation` | no | Raster layer identifier already exists |
| `map.raster-strategy.map-mutation-failed` | `map` | `internal` | no | Raster renderer mutation failed |
| `map.automatic-integration.disposed` | `map` | `validation` | no | Automatic map integration is disposed |
| `map.automatic-integration.invalid-target` | `map` | `validation` | no | Automatic map integration target is invalid |
| `map.temporal-playback.invalid-option` | `map` | `validation` | no | Temporal playback option is invalid |
| `runtime.map-package.fetch` | `runtime` | `network` | yes | Map package fetch failed |
| `runtime.map-package.load` | `runtime` | `internal` | no | Map package load failed |
| `runtime.map-package.validate` | `runtime` | `validation` | no | Map package validation failed |
| `runtime.map-package.update` | `runtime` | `internal` | no | Map package update failed |
| `runtime.map-package.style-compose` | `runtime` | `validation` | no | Map package style composition failed |
| `runtime.map-package.source-bind` | `runtime` | `internal` | no | Map package source binding failed |
| `runtime.map-package.view` | `runtime` | `internal` | no | Renderer view mutation failed |
| `runtime.map-package.popup` | `runtime` | `validation` | no | Popup binding failed |
| `runtime.map-package.dispose` | `runtime` | `internal` | yes | Runtime disposal failed |
| `runtime.diagnostic` | `runtime` | `validation` | no | Runtime validation diagnostic |
| `runtime.query-tiles.transient` | `runtime` | `protocol` | yes | Retryable query-tile response failure |
| `runtime.query-tiles.rejected` | `runtime` | `protocol` | no | Non-retryable query-tile response failure |
| `realtime.cancelled` | `realtime` | `cancellation` | no | Realtime operation was cancelled |
| `realtime.transport.reconnectable` | `realtime` | `network` | yes | Realtime transport can reconnect or resnapshot |
| `realtime.checkpoint.invalid` | `realtime` | `validation` | no | Realtime checkpoint or resume context is invalid |
| `realtime.sequence.gap` | `realtime` | `protocol` | yes | Realtime ordering requires a replacement snapshot |
| `realtime.protocol.terminal` | `realtime` | `protocol` | no | Realtime delivery reached a terminal failure |
| `offline.region.validation` | `offline` | `validation` | no | Offline region input or lifecycle state is invalid |
| `offline.region.quota` | `offline` | `validation` | no | Offline region exceeds a logical storage quota |
| `offline.region.integrity` | `offline` | `protocol` | no | Offline resource integrity verification failed |
| `offline.cancelled` | `offline` | `cancellation` | no | Offline operation was cancelled |
| `offline.transport.failure` | `offline` | `network` | no | Offline resource or replica transport failed without a transient classification |
| `offline.transport.transient` | `offline` | `network` | yes | Offline resource or replica transport failed transiently |
| `offline.storage.concurrent` | `offline` | `internal` | yes | Offline storage inventory changed before commit |
| `offline.storage.failure` | `offline` | `internal` | no | Offline storage operation failed |
| `offline.replica-sync.capability` | `offline` | `capability` | no | Replica synchronization capability is unavailable |
| `offline.replica-sync.validation` | `offline` | `validation` | no | Replica synchronization request or state is invalid |
| `offline.replica-sync.permission-denied` | `offline` | `authentication` | no | Replica synchronization permission was denied |
| `plugin.registry.validation` | `plugin` | `validation` | no | Plugin registry input or lifecycle state is invalid |
| `plugin.compatibility` | `plugin` | `capability` | no | Plugin declaration is incompatible with the host or its dependencies |
| `plugin.execution.policy-denied` | `plugin` | `capability` | no | Plugin execution was denied by host policy |
| `plugin.capability-unavailable` | `plugin` | `capability` | no | Plugin execution requires an unavailable capability or dependency |
| `plugin.lifecycle.activation` | `plugin` | `internal` | no | Plugin activation or registration failed |
| `plugin.execution.validation` | `plugin` | `validation` | no | Plugin execution input is invalid |
| `plugin.lifecycle.cleanup` | `plugin` | `internal` | no | Plugin lifecycle cleanup failed |
| `plugin.cancelled` | `plugin` | `cancellation` | no | Plugin registration was cancelled |
| `plugin.internal` | `plugin` | `internal` | no | Plugin registry internal failure |
<!-- error-code-registry:end -->

## Narrowing in `catch`

Prefer the `isHonuaError` guard so unrelated exceptions (e.g. caller TypeErrors
in callbacks) propagate normally:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { HonuaHttpError, HonuaTimeoutError, HonuaCapabilityNotSupportedError, isHonuaError } from "@honua/sdk-js";

try {
  await dataset.source("parcels")!.queryAll({ where: "1=1" });
} catch (error) {
  if (!isHonuaError(error)) throw error;

  if (error instanceof HonuaCapabilityNotSupportedError) {
    // expected for capability misses — fall back to a narrower query
    return fallbackQuery();
  }
  if (error instanceof HonuaHttpError && error.statusCode === 401) {
    await refreshCredentials();
    return retry();
  }
  if (error instanceof HonuaTimeoutError) {
    notifyUser("Server slow — try again in a moment.");
    return;
  }
  throw error;
}
```

## Retry policy

The SDK's built-in retry (`HonuaClientOptions.retry`) automatically handles a
subset of these errors when configured:

| Error | Retried by built-in `retry`? |
|-------|-------------------------------|
| `HonuaHttpError` with status in `retryStatuses` (default `[408, 429, 500, 502, 503, 504]`) | Yes |
| `HonuaNetworkError` | Yes |
| `HonuaTimeoutError` | Yes |
| `HonuaGrpcError` with retryable code | **No** — the built-in `retry` policy is not applied to the gRPC-web transport; wrap these calls yourself |
| `HonuaAuthError` | **No** — resolved by the auth provider's own silent-refresh / single-flight logic; a 401/403 additionally triggers one force-refresh + replay. Branch on `.code` to sign in or surface. |
| `HonuaAbortError` | **No** — caller asked to stop |
| `HonuaRealtimeResumeError` | **No automatic retry** — the realtime transport and resumable delivery gate retain their existing reconnect/resnapshot policy; use `.sdkCode` only to classify the observed transition. |
| `HonuaOfflineRegionError` | **No automatic retry** — loader, transaction, quota, and eviction behavior is unchanged; the application/store owns any retry after an explicitly transient tagged cause. |
| `HonuaReplicaSyncError` | **No automatic retry** — the replica transport and conflict workflow retain their existing policy; generic transport failures remain non-retryable. |
| `HonuaPluginRegistryError` | **No automatic retry** — every plugin classification is conservatively non-retryable; the host must correct registry input, compatibility, policy, capability, or lifecycle state explicitly. |
| `HonuaCapabilityNotSupportedError` | **No** — would never succeed |
| `HonuaGeometryError` | **No** — input must be corrected |
| `HonuaWfsExceptionError` | **No** — caller bug |
| `HonuaExplorationContextError` | **No** — state bug |

## Capability policy

`createDataset({ capabilityPolicy: "strict" })` is the default and is recommended
for production. It surfaces capability misses as `HonuaCapabilityNotSupportedError`
*before* the network call, so unsupported features can never silently degrade to
an empty result. `capabilityPolicy: "degraded"` is intended for exploratory tools
that prefer best-effort results with an explicit `degraded` reason annotated on
the `Result`.
