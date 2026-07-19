/**
 * `@honua/sdk-js/realtime` — realtime transport adapters (Server-Sent Events today,
 * WebSocket/WebTransport adapters land alongside future server endpoints).
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
