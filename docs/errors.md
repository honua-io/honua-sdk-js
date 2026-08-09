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
[#571](https://github.com/honua-io/honua-sdk-js/issues/571), and the
stable `agent-tools`/`agent-safety` errors plus the deprecated `generated-app`
error migrated by [#570](https://github.com/honua-io/honua-sdk-js/issues/570).
The experimental `nl-map-control` domain's error class remains an explicit
residual pending a scoped migration; other experimental domains likewise
retain their current domain-specific contracts until a scoped migration
lands.

## Envelope contract

Every migrated instance has these common fields:

| Field | Meaning |
|-------|---------|
| `kind` | Constant `"honua.sdk.error.v1"` tag used by the cross-realm guard. |
| `domain` | Stable broad owner: `core`, `discovery`, `query`, `map`, `runtime`, `realtime`, `offline`, `plugin`, `agent`, or `app`. |
| `sdkCode` | Globally unique code from `HONUA_ERROR_CODE_REGISTRY`. |
| `category` | Stable `authentication`, `cancellation`, `capability`, `internal`, `network`, `protocol`, `timeout`, or `validation` classification. |
| `retryable` | Stable boolean for this exact `sdkCode`. This metadata describes the existing policy; it does not initiate retries. |
| `operationId` / `requestId` | Optional sanitized correlation identifiers when the throwing boundary has them. |
| `context` | Frozen, recursively sanitized structured context. |
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
keys. Agent-domain errors additionally never serialize prompts, plans, tool
arguments/results, feature values, approvals, or execution receipts — only
fixed reason codes and, for `HonuaAgentToolError`, the invoked tool name. The
raw instance still retains its message, documented detail fields, exact
cause, and documented cleanup aggregates for local use.

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
| `HonuaGrpcError` | `transport: "grpc-web"` only | A gRPC-Web call returned a non-OK `Code`. | Branch on `.code` (Connect/`google.rpc.Code`): `UNAUTHENTICATED` → refresh credentials, `PERMISSION_DENIED` → surface; `UNAVAILABLE` → retry with backoff (a configured `retry` already replays this class on unary calls — see [Retry policy](#retry-policy)); `DEADLINE_EXCEEDED` → increase deadline or retry; `INVALID_ARGUMENT` → fix the call site. |
| `HonuaAuthError` | `@honua/sdk-js/auth` providers (`oauth2`, `clientCredentials`) | A credential could not be produced. | Branch on `.code`: `interaction_required` → start interactive sign-in (`auth.signIn()`); `refresh_failed` → transient token-endpoint failure, retry later; `invalid_grant` → refresh token/authorization code expired or revoked (the stored credential is cleared) → interactive sign-in. The underlying transport/parse failure, when present, is on `.cause`. |
| `HonuaCapabilityNotSupportedError` | `Source.query` / `Source.applyEdits` / etc. | Under the default `capabilityPolicy: "strict"`, the active source does not support the requested operation (e.g. `query()` on a `wmts` source). | Either downgrade the request (drop the unsupported clause), fall back to `Source.protocol(...)` for raw protocol access, or set `capabilityPolicy: "degraded"` on `createDataset` to coerce best-effort behavior with a `degraded` reason in the `Result`. |
| `HonuaDiscoveryError` | `connect`, discovery truth, cache identity | Endpoint metadata, protocol hints, source selection, or cached discovery observations are invalid or ambiguous. | Branch on `.code`: provide an explicit supported protocol for `ambiguous-protocol`; select a listed source ID for `ambiguous-source`; use a reviewed adapter for `unsupported-protocol`; evict/rebuild entries for `invalid-discovery-cache`. Do not retry unchanged invalid input. |
| `HonuaGeometryError` | Spatial-filter builders | Geometry classification would otherwise require guessing, or a recognized Esri geometry is malformed. | Branch on `.code`: `unknown-geometry` means no supported Esri shape discriminator was found; `malformed-geometry` means a recognized shape, coordinate, or envelope expansion is invalid. Fix the input; do not retry it unchanged. Diagnostic context is on `.detail`. |
| `HonuaExplorationContextError` | `@honua/sdk-js/exploration` | An exploration intent referenced a missing slice / view, or the snapshot is incompatible with the active context schema. | Surface to user (UI bug) or migrate the saved snapshot. Do not retry. |
| `HonuaWfsExceptionError` | `wfs` adapter | The WFS server returned a `<ows:ExceptionReport>`. The `exceptionCode`, optional `locator`, and formatted exception message are preserved on the instance. | Branch on `.exceptionCode` (`InvalidParameterValue`, `OperationNotSupported`, `MissingParameterValue`, etc.). Most are caller bugs; surface to user. |
| `HonuaWfsProtocolError` | WFS protocol module | Bound WFS 2.0 capability evidence, paging progress, or a GeoJSON feature response was invalid. | Branch on `.reason`: fix/reconfigure invalid capability evidence or response shape; investigate a server paging bug for `paging-stalled`. Do not retry unchanged evidence. |
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
| `HonuaRealtimeReconciliationError` | `@honua/sdk-js/realtime`, `@honua/sdk-js/map` | Delta reconciliation (`reconciliation.ts`) or its MapLibre adapter (`realtime-reconciliation-adapter.ts`) receives an invalid option, or a reconciler/cache/adapter already disposed receives another patch. | Branch on `.code` (`"disposed"` / `"invalid-option"`). Recreate the reconciler/cache/adapter instead of reusing a disposed one; correct the option that failed validation. Not retryable. |
| `HonuaOfflineRegionError` | `@honua/sdk-js/offline` | Offline manifest validation, quota admission, resource loading, integrity verification, cancellation, atomic store work, or an offline read the persisted region cannot answer fails. | Branch on the existing detailed `.code`. Rebuild invalid manifests, free quota, and treat abort as terminal. Treat `cache-miss` / `scope-mismatch` / `out-of-region` (`offline.region.miss`) as "download a region for this selection", never as an empty answer. Retry through the application's loader/store policy only when `.sdkCode` is `offline.transport.transient`; generic loader failures remain conservative. Raw resource identifiers and storage paths remain local-only. |
| `HonuaReplicaSyncError` | `@honua/app-platform/replica-sync` (the deprecated `@honua/sdk-js/replica-sync` shim remains through 0.1.x) | Disconnected replica capability, conflict review/resolution, permission, validation, or transport work fails. | Branch on the existing detailed `.code` and preserve the current sync/conflict workflow. Only failures carrying a tagged retryable network/timeout cause receive retryable metadata; the envelope does not retry or resolve conflicts. |
| `HonuaPluginRegistryError` | `@honua/sdk-js/plugin` | Plugin registry validation, compatibility, policy, capability, activation, execution validation, cancellation, or cleanup fails. | Branch on the existing `PLUGIN_*` `.code` or its grouped `.sdkCode`. Correct declarations or host policy/capability, treat cancellation as terminal, and inspect `.cause` / `.cleanupErrors` locally for activation or cleanup failures. No plugin classification is automatically retryable. |
| `HonuaAgentToolError` | `@honua/sdk-js/agent-tools` | An agent tool call names an unknown tool, the tool kit is created without a usable runtime, a selection target is not source-qualified, or the adapted runtime does not implement the requested tool method. | Branch on `.code` or `.sdkCode`; correct the tool name, provide a runtime/controller/generated-app runtime, or qualify the selection. Not retryable. |
| `HonuaAgentSafetyError` | `@honua/sdk-js/agent-safety` | Agent plan validation, policy evaluation, dry-run, approval, or safety-evidence derivation/verification fails (aborted, invalid input, policy denial, integrity failure, expired approval, context mismatch, or invalid signature). | Branch on `.code`; correct the plan/policy/approval input, re-request approval, or treat cancellation as terminal. Not retryable. |
| `HonuaAgentExecutionError` | `@honua/sdk-js/agent-safety` | A plan step's authorization, start audit, execution, receipt issuance, or terminal audit fails. Extends `HonuaAgentSafetyError` with `.phase` and, when execution reached that point, the signed `.receipt`. | Branch on `.code` / `.phase`; the caller must consume `.receipt` directly (never serialized). Not retryable. |
| `HonuaGeneratedAppError` | `@honua/sdk-js/generated-app` (deprecated shim; canonical home `@honua/app-platform/generated-app`) | Generated-app preview/runtime manifest, projection, load, interaction, render, or dispose stage fails. | Branch on `.code` / `.stage`; use `toGeneratedAppDiagnostic(error)` for the legacy `{code, stage, message, detail}` shape. Not retryable. |

## Registered code families

The exported `HONUA_ERROR_CODE_REGISTRY` is the canonical, typed inventory. Its
object keys are globally unique at compile time, the common base accepts only
registered codes, and domain constructors either reject unknown runtime reasons
or project them to a fixed registered fallback. Focused entrypoints retain only
the code/domain/category/retryability classifications needed by the error base;
human-readable registry summaries remain in the explicit public registry.
`npm run check:error-codes` verifies exact classification parity, registry shape,
and this class/family documentation.

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
| `HonuaQueryPlanExecutionError` | `query.execution.*` (the eight values in `QueryPlanExecutionErrorCode`) |
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
| `HonuaRealtimeReconciliationError` | `realtime.reconciliation.disposed`, `realtime.reconciliation.invalid-option` |
| `HonuaOfflineRegionError` | `offline.region.validation`, `offline.region.quota`, `offline.region.integrity`, `offline.region.miss`, `offline.cancelled`, `offline.transport.failure`, `offline.transport.transient`, `offline.storage.*` |
| `HonuaReplicaSyncError` | `offline.replica-sync.capability`, `offline.replica-sync.validation`, `offline.replica-sync.permission-denied`, `offline.transport.failure`, `offline.transport.transient` |
| `HonuaPluginRegistryError` | `plugin.registry.validation`, `plugin.compatibility`, `plugin.execution.policy-denied`, `plugin.capability-unavailable`, `plugin.lifecycle.activation`, `plugin.execution.validation`, `plugin.lifecycle.cleanup`, `plugin.cancelled`, `plugin.internal` |
| `HonuaAgentToolError` | `agent.tool.unknown-tool`, `agent.tool.missing-runtime`, `agent.tool.unqualified-selection`, `agent.tool.missing-runtime-method`, `agent.tool.internal` |
| `HonuaAgentSafetyError` | `agent.safety.aborted`, `agent.safety.invalid-input`, `agent.safety.policy-denied`, `agent.safety.integrity-failed`, `agent.safety.approval-expired`, `agent.safety.context-mismatch`, `agent.safety.signature-invalid`, `agent.safety.execution-failed`, `agent.safety.audit-failed`, `agent.safety.receipt-failed` |
| `HonuaAgentExecutionError` | `agent.safety.aborted`, `agent.safety.execution-failed`, `agent.safety.audit-failed`, `agent.safety.receipt-failed` (subset of `HonuaAgentSafetyError`'s family) |
| `HonuaGeneratedAppError` | `app.unsupported-profile`, `app.unsupported-widget`, `app.missing-manifest`, `app.missing-manifest-artifact`, `app.missing-map-package`, `app.map-package-mismatch`, `app.missing-widget`, `app.missing-binding`, `app.map-load-failed`, `app.data-load-failed`, `app.render-failed`, `app.disposed` |

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

`HonuaAgentToolError.code` remains the existing free-form reason string;
unrecognized runtime values project to `agent.tool.internal` without
changing the local `.code` or message. `HonuaAgentSafetyError.code` and
`HonuaAgentExecutionError.code` remain the existing fixed `AgentSafetyErrorCode`
reasons, each mapped one-to-one to a registered `agent.safety.*` `sdkCode`, so
no information is lost by the grouping and no additional context is needed.
`HonuaGeneratedAppError.code`/`.stage`/`.detail` remain the existing values;
`.detail` stays local-only (never serialized as envelope context) because it
is an open, caller-supplied bag. None of the four agent-domain classes ever
place a prompt, plan, tool argument/result, feature value, approval, receipt,
credential, or query value in serialized context — `HonuaAgentToolError`
serializes only the invoked tool name (one of ten fixed identifiers); the
others serialize no context at all, relying solely on the fixed `sdkCode`
classification. The signed `AgentExecutionReceiptV1` on
`HonuaAgentExecutionError.receipt` is a local-only instance property, exactly
like `.cause`, and is never copied into the envelope. Every agent/app
classification is conservatively non-retryable.

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
| `core.coverage.invalid-request` | `core` | `validation` | no | Coverage request is invalid |
| `core.coverage.invalid-response` | `core` | `protocol` | no | Coverage response is invalid |
| `core.coverage.response-too-large` | `core` | `validation` | no | Coverage response exceeds its byte limit |
| `core.coverage.unsupported-format` | `core` | `capability` | no | Coverage format is unsupported |
| `core.coverage.service-error` | `core` | `protocol` | no | Coverage service rejected the request |
| `core.coverage.wcs-exception` | `core` | `protocol` | no | WCS exception report |
| `discovery.ambiguous-protocol` | `discovery` | `validation` | no | Multiple protocols match the endpoint |
| `discovery.ambiguous-source` | `discovery` | `validation` | no | Multiple sources match the selection |
| `discovery.invalid-cloud-native-input` | `discovery` | `validation` | no | Cloud-native discovery input is invalid or ambiguous |
| `discovery.invalid-cloud-native-manifest` | `discovery` | `validation` | no | Cloud-native deployment manifest is invalid |
| `discovery.invalid-endpoint` | `discovery` | `validation` | no | Discovery endpoint is invalid |
| `discovery.invalid-cache-identity` | `discovery` | `validation` | no | Discovery cache identity is invalid |
| `discovery.invalid-discovery-cache` | `discovery` | `validation` | no | Discovery cache entry is invalid |
| `discovery.invalid-capability` | `discovery` | `validation` | no | Discovered capability evidence is invalid |
| `discovery.cloud-native-operation-unavailable` | `discovery` | `capability` | no | Cloud-native source operation is unavailable at its declared maturity |
| `discovery.unsupported-protocol` | `discovery` | `capability` | no | Endpoint protocol is unsupported |
| `discovery.protocol-mismatch` | `discovery` | `validation` | no | Endpoint protocol conflicts with its hint |
| `query.planning.invalid-query` | `query` | `validation` | no | Query is invalid |
| `query.planning.unsupported-compiler` | `query` | `capability` | no | No compiler supports the source protocol |
| `query.planning.unsupported-query` | `query` | `capability` | no | Query cannot be represented by the compiler |
| `query.planning.capability-not-supported` | `query` | `capability` | no | Query requires an unavailable capability |
| `query.planning.fallback-disabled` | `query` | `capability` | no | Required local fallback is disabled |
| `query.planning.unsafe-materialization` | `query` | `validation` | no | Planned local materialization exceeds its safety bound |
| `query.execution.invalid-plan` | `query` | `validation` | no | Query plan is invalid |
| `query.execution.wfs-protocol` | `query` | `protocol` | no | WFS protocol evidence or response is invalid |
| `query.execution.plan-context-mismatch` | `query` | `validation` | no | Execution context does not match the accepted query plan |
| `query.execution.unsafe-materialization` | `query` | `validation` | no | Query execution exceeded its materialization bound |
| `query.execution.invalid-resource-handle` | `query` | `validation` | no | Query resource handle is invalid |
| `query.execution.resource-unavailable` | `query` | `authentication` | no | Query resource is unavailable in the authorization context |
| `query.execution.resource-expired` | `query` | `authentication` | no | Query resource authorization has expired |
| `query.execution.resource-resolution-failed` | `query` | `internal` | no | Query resource resolution failed |
| `query.execution.resource-execution-failed` | `query` | `internal` | no | Resolved query resource execution failed |
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
| `realtime.reconciliation.disposed` | `realtime` | `validation` | no | Realtime reconciliation controller, cache, or adapter is disposed |
| `realtime.reconciliation.invalid-option` | `realtime` | `validation` | no | Realtime reconciliation option is invalid |
| `offline.region.validation` | `offline` | `validation` | no | Offline region input or lifecycle state is invalid |
| `offline.region.quota` | `offline` | `validation` | no | Offline region exceeds a logical storage quota |
| `offline.region.integrity` | `offline` | `protocol` | no | Offline resource integrity verification failed |
| `offline.region.miss` | `offline` | `validation` | no | Offline region does not cover the requested read |
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
| `agent.tool.unknown-tool` | `agent` | `validation` | no | Requested agent tool name is not registered |
| `agent.tool.missing-runtime` | `agent` | `validation` | no | Agent tool kit requires a runtime, controller, or generated-app runtime |
| `agent.tool.unqualified-selection` | `agent` | `validation` | no | Agent tool selection target is not source-qualified |
| `agent.tool.missing-runtime-method` | `agent` | `capability` | no | Adapted runtime does not implement the requested agent tool |
| `agent.tool.internal` | `agent` | `internal` | no | Agent tool executor internal failure |
| `agent.safety.aborted` | `agent` | `cancellation` | no | Agent safety operation was aborted |
| `agent.safety.invalid-input` | `agent` | `validation` | no | Agent safety input is invalid |
| `agent.safety.policy-denied` | `agent` | `capability` | no | Agent plan step was denied by host policy |
| `agent.safety.integrity-failed` | `agent` | `protocol` | no | Agent safety evidence integrity verification failed |
| `agent.safety.approval-expired` | `agent` | `authentication` | no | Agent step approval has expired |
| `agent.safety.context-mismatch` | `agent` | `validation` | no | Agent execution context does not match the authorized plan |
| `agent.safety.signature-invalid` | `agent` | `validation` | no | Agent approval or receipt signature is invalid |
| `agent.safety.execution-failed` | `agent` | `internal` | no | Agent plan step execution failed |
| `agent.safety.audit-failed` | `agent` | `internal` | no | Agent execution audit record could not be appended |
| `agent.safety.receipt-failed` | `agent` | `internal` | no | Agent execution receipt could not be issued or verified |
| `app.unsupported-profile` | `app` | `capability` | no | Generated app profile is not supported |
| `app.unsupported-widget` | `app` | `capability` | no | Generated app widget kind is not supported |
| `app.missing-manifest` | `app` | `validation` | no | Generated app manifest or app package is missing |
| `app.missing-manifest-artifact` | `app` | `validation` | no | Generated app manifest artifact is missing |
| `app.missing-map-package` | `app` | `validation` | no | Generated app map widget requires a MapPackage |
| `app.map-package-mismatch` | `app` | `validation` | no | Generated app MapPackage does not match its manifest |
| `app.missing-widget` | `app` | `validation` | no | Generated app manifest is missing a required widget |
| `app.missing-binding` | `app` | `validation` | no | Generated app runtime is missing a required binding |
| `app.map-load-failed` | `app` | `internal` | no | Generated app map widget failed to load |
| `app.data-load-failed` | `app` | `internal` | no | Generated app feature data failed to load |
| `app.render-failed` | `app` | `internal` | no | Generated app render failed |
| `app.disposed` | `app` | `validation` | no | Generated app runtime is disposed |
| `app.export-unsafe` | `app` | `validation` | no | Component export refused because the artifact could not be proven credential-free |
| `app.export-failed` | `app` | `internal` | no | Component export adapter failed to produce an artifact |
<!-- error-code-registry:end -->

## Narrowing in `catch`

Prefer the `isHonuaError` guard so unrelated exceptions (e.g. caller TypeErrors
in callbacks) propagate normally:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { HonuaHttpError, HonuaTimeoutError, HonuaCapabilityNotSupportedError, isHonuaError } from "@honua/sdk-js";

try {
  await dataset.source("parcels")!.queryAll({ pagination: { limit: 100 } });
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
| `HonuaHttpError` with status in `retryStatuses` (default `[429, 502, 503, 504]`) | Yes — on replay-safe methods only (`GET` / `HEAD` / `PUT` / `DELETE`) |
| `HonuaNetworkError` | Yes |
| `HonuaTimeoutError` | Yes |
| `HonuaGrpcError` with a transient code (`4` / `8` / `10` / `14` — `deadline_exceeded`, `resource_exhausted`, `aborted`, `unavailable`) | Yes — replay-safe **unary** calls only, using the same backoff/jitter and `retry-after` handling as REST. Server-streaming calls are never retried (a stream cannot be safely replayed mid-iteration), and no attempt is made once the call's abort/`timeoutMs` deadline has fired. |
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
| `HonuaAgentToolError` | **No** — caller/config bug |
| `HonuaAgentSafetyError` / `HonuaAgentExecutionError` | **No automatic retry** — every agent-safety classification is conservatively non-retryable; the host must correct plan/policy/approval input or re-request approval explicitly. |
| `HonuaGeneratedAppError` | **No automatic retry** — manifest/projection/load/render diagnostics are surfaced for the embedder to correct or retry explicitly. |

### Retry defaults are narrower than the `retryable` classification

Two HTTP status sets exist, and they are deliberately different:

| Set | Value | Role |
|-----|-------|------|
| Retry-loop default (`DEFAULT_RETRY_STATUSES` in `src/core/request-pipeline.ts`) | `429, 502, 503, 504` | The statuses the opt-in retry loop replays when `retry` is configured and no `retryStatuses` override is supplied. |
| Transient classification (`core.http.transient`, and `runtime.query-tiles.transient` for query tiles) | `408, 429, 500, 502, 503, 504` | The statuses whose error instance carries `retryable: true` metadata. |

The loop default is the narrower set on purpose: `429`, `502`, `503`, and `504`
all carry an explicit "this exact request may succeed if sent again" signal (and
frequently a `Retry-After` header). `408` and `500` are classified transient so
triage and telemetry can group them with the recoverable failures, but they are
not replayed automatically — a `500` is an unexplained server fault that a blind
replay usually just reproduces, and a `408` normally means the request was never
fully received. Applications that want the broader set opt in explicitly, e.g.
`retry: { maxRetries: 2, retryStatuses: [408, 429, 500, 502, 503, 504] }`.

The registry's `retryable` metadata does **not** drive the retry loop. The loop
reads only the configured `retryStatuses` (or the default above), the replay-safe
method gate, and the transient network/timeout error types; the classification is
descriptive metadata for callers that implement their own backoff. Changing an
`sdkCode`'s `retryable` flag therefore changes reporting, not request behavior.

## Capability policy

`createDataset({ capabilityPolicy: "strict" })` is the default and is recommended
for production. It surfaces capability misses as `HonuaCapabilityNotSupportedError`
*before* the network call, so unsupported features can never silently degrade to
an empty result. `capabilityPolicy: "degraded"` is intended for exploratory tools
that prefer best-effort results with an explicit `degraded` reason annotated on
the `Result`.
