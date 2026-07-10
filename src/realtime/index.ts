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
