/**
 * `@honua/sdk-js/realtime` — realtime transport adapters. Raw Server-Sent
 * Events (`sse.ts`) and WebSocket (`websocket.ts`) wire adapters pair with
 * the bounded, resumable wrapper in `resumable-transport.ts` (issue #557),
 * which adds the #556 delivery gate, reconnect/backoff, heartbeat timeout,
 * and redacted telemetry on top of either one. `odata-delta.ts` (issue #558)
 * adds a pull-based OData v4 delta-link adapter with its own bounded poll
 * loop and honest, non-live freshness reporting — it satisfies the same
 * `RealtimeFeatureTransport` surface but is not a socket transport, so it
 * does not compose with `resumable-transport.ts`'s reconnect wrapper.
 *
 * @module
 */
export {
  createRealtimeServerSentEventsTransport,
  decodeRealtimeServerSentEvent,
  encodeDefaultRealtimeRequest,
} from "./sse.js";
export type {
  RealtimeServerSentEventSource,
  RealtimeServerSentEventSourceFactory,
  RealtimeServerSentEventsTransportOptions,
} from "./sse.js";
export {
  createHonuaServerRealtimeSubscription,
  decodeHonuaServerRealtimeEvent,
  encodeHonuaServerRealtimeRequest,
  honuaServerRealtimePreset,
  HONUA_SERVER_STREAMING_FEATURES_PATH,
} from "./honua-server.js";
export type {
  CreateHonuaServerRealtimeSubscriptionOptions,
  HonuaServerFeatureChange,
  HonuaServerFeatureChangeEnvelope,
} from "./honua-server.js";
export {
  emptyRealtimeFeatureState,
  reconcileRealtimeStaleness,
  reduceRealtimeFeatureState,
  realtimeFeatureKey,
  realtimeResumeCheckpoint,
  realtimeSubscriptionKey,
} from "./reducer.js";
export { createRealtimeFeatureStore } from "./store.js";
export type { RealtimeFeatureStore } from "./store.js";
export {
  REALTIME_DURABLE_CHECKPOINT_VERSION,
  HonuaRealtimeResumeError,
  createResumableRealtimeSubscription,
  evaluateRealtimeCheckpoint,
} from "./resumable.js";
export type {
  CreateResumableRealtimeSubscriptionOptions,
  RealtimeCheckpointCompatibility,
  RealtimeCheckpointCompatibilityCode,
  RealtimeCheckpointStore,
  RealtimeDurableCheckpointV1,
  RealtimeExternalResnapshotReason,
  RealtimeResumeContextV1,
  RealtimeSequencedEvent,
  ResumableRealtimeDelivery,
  ResumableRealtimeDeliveryStatus,
  ResumableRealtimePhase,
  ResumableRealtimeReasonCode,
  ResumableRealtimeState,
  ResumableRealtimeSubscription,
} from "./resumable.js";
export {
  assertRealtimePlanIdentity,
  deriveRealtimeContractAuthority,
  realtimePlanFingerprint,
  redactRealtimeCheckpoint,
  serializeRealtimeCheckpoint,
  serializeRedactedRealtimeCheckpoint,
} from "./contract.js";
export type {
  DeriveRealtimeContractAuthorityOptions,
  RealtimeContractAuthority,
  RealtimeContractAuthorityState,
  RedactedRealtimeCheckpointV1,
  RedactedRealtimeResumePosition,
  RedactedResumePosition,
} from "./contract.js";
export { createRealtimeWebSocketTransport } from "./websocket.js";
export type {
  RealtimeWebSocket,
  RealtimeWebSocketCloseEvent,
  RealtimeWebSocketFactory,
  RealtimeWebSocketTransportOptions,
} from "./websocket.js";
export { createOdataDeltaTransport } from "./odata-delta.js";
export type {
  OdataDeltaEntity,
  OdataDeltaInitialQuery,
  OdataDeltaPollTelemetry,
  OdataDeltaTransportOptions,
} from "./odata-delta.js";
export {
  computeReconnectDelayMs,
  createResumableRealtimeTransport,
  createResumableServerSentEventsTransport,
  createResumableWebSocketTransport,
} from "./resumable-transport.js";
export type {
  RealtimeReconnectPolicy,
  RealtimeResumableTransportOptions,
  RealtimeResumableTransportTelemetry,
} from "./resumable-transport.js";
export { filterRealtimeSelection, reconcileRealtimeSelection } from "./exploration.js";
export {
  selectRealtimeDetail,
  selectRealtimeFeatureRecordMap,
  selectRealtimeFeatureRecords,
  selectRealtimeFeatureTombstones,
  selectRealtimeFeatures,
} from "./projections.js";
export type {
  RealtimeDetailSelectorOptions,
  RealtimeDetailState,
  RealtimeFeatureRecordSelectorOptions,
  RealtimeFeatureReference,
} from "./projections.js";
export type {
  RealtimeConnectionStatus,
  RealtimeDeleteEvent,
  RealtimeDeletePatch,
  RealtimeDeltaEvent,
  RealtimeErrorEvent,
  RealtimeFeatureEvent,
  RealtimeFeatureEventBase,
  RealtimeFeatureObserver,
  RealtimeFeaturePatch,
  RealtimeFeatureRecord,
  RealtimeFeatureState,
  RealtimeFeatureTombstone,
  RealtimeFeatureTransport,
  RealtimeHeartbeatEvent,
  RealtimeReducerOptions,
  RealtimeResumeCheckpoint,
  RealtimeResumeMode,
  RealtimeSnapshotEvent,
  RealtimeStateListener,
  RealtimeStatusEvent,
  RealtimeStalenessOptions,
  RealtimeSubscriptionIdentity,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionMode,
  RealtimeSubscriptionRequest,
  RealtimeTransportCapabilities,
  RealtimeTransportKind,
  RealtimeUpsertEvent,
} from "./types.js";
