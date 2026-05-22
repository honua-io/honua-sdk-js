/**
 * `@honua/sdk-js/realtime` — realtime transport adapters (Server-Sent Events today,
 * WebSocket/WebTransport adapters land alongside future server endpoints).
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
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
