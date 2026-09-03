/**
 * Realtime operational feature state.
 *
 * These types model live create/update/delete/snapshot delivery without
 * committing app code to SSE, WebSocket, or polling. Transport adapters emit
 * `RealtimeFeatureEvent`s; apps and SDK bindings consume reconciled state.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";

export type RealtimeConnectionStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "stale"
  | "offline"
  | "closed"
  | "error";

export type RealtimeTransportKind = "sse" | "websocket" | "polling" | "mock" | "custom";

export type RealtimeResumeMode = "none" | "cursor" | "watermark" | "timestamp" | "sequence" | "delta-token";

export type RealtimeSubscriptionMode = "snapshot" | "snapshot-then-delta" | "delta";

export interface RealtimeResumeCheckpoint {
  readonly cursor?: string;
  readonly watermark?: string;
  readonly timestamp?: string;
  readonly sequence?: number;
  readonly deltaToken?: string;
}

export interface RealtimeFeaturePatch<TFeature = unknown> {
  readonly id: FeatureId;
  readonly sourceId?: SourceId;
  readonly feature: TFeature;
  readonly version?: number;
  readonly updatedAt?: string;
}

export interface RealtimeFeatureRecord<TFeature = unknown> extends RealtimeFeaturePatch<TFeature> {
  readonly key: string;
  readonly cursor?: string;
  readonly sequence?: number;
  readonly receivedAt: number;
}

export interface RealtimeFeatureTombstone {
  readonly id: FeatureId;
  readonly sourceId?: SourceId;
  readonly key: string;
  readonly cursor?: string;
  readonly sequence?: number;
  readonly version?: number;
  readonly updatedAt?: string;
  readonly deletedAt: number;
}

export interface RealtimeFeatureEventBase {
  readonly eventId?: string;
  /** Canonical governed operation instance supplied by honua-server. */
  readonly operationInstanceId?: string;
  /** Canonical request correlation identity supplied by honua-server. */
  readonly correlationId?: string;
  /** Durable acceptance-audit identity supplied by honua-server. */
  readonly auditId?: string;
  /** Approved proposal identity supplied by honua-server, when applicable. */
  readonly proposalId?: string;
  readonly cursor?: string;
  readonly watermark?: string;
  readonly timestamp?: string;
  readonly deltaToken?: string;
  readonly checkpoint?: RealtimeResumeCheckpoint;
  readonly sequence?: number;
  readonly receivedAt?: number;
}

export interface RealtimeSnapshotEvent<TFeature = unknown> extends RealtimeFeatureEventBase {
  readonly type: "snapshot";
  readonly features: ReadonlyArray<RealtimeFeaturePatch<TFeature>>;
  /** Replace the current live set. @default true */
  readonly replace?: boolean;
}

export interface RealtimeUpsertEvent<TFeature = unknown> extends RealtimeFeatureEventBase {
  readonly type: "upsert";
  readonly feature: RealtimeFeaturePatch<TFeature>;
}

export interface RealtimeDeleteEvent extends RealtimeFeatureEventBase {
  readonly type: "delete";
  readonly id: FeatureId;
  readonly sourceId?: SourceId;
  readonly version?: number;
  readonly updatedAt?: string;
  readonly deletedAt?: number;
}

export interface RealtimeDeletePatch {
  readonly id: FeatureId;
  readonly sourceId?: SourceId;
  readonly version?: number;
  readonly updatedAt?: string;
  readonly deletedAt?: number;
}

export interface RealtimeDeltaEvent<TFeature = unknown> extends RealtimeFeatureEventBase {
  readonly type: "delta";
  readonly upserts?: ReadonlyArray<RealtimeFeaturePatch<TFeature>>;
  readonly deletes?: ReadonlyArray<RealtimeDeletePatch>;
}

export interface RealtimeHeartbeatEvent extends RealtimeFeatureEventBase {
  readonly type: "heartbeat";
}

export interface RealtimeStatusEvent extends RealtimeFeatureEventBase {
  readonly type: "status";
  readonly status: RealtimeConnectionStatus;
  readonly staleSince?: number;
  readonly reason?: string;
  readonly retryAfterMs?: number;
  readonly reconnectAttempt?: number;
}

export interface RealtimeErrorEvent extends RealtimeFeatureEventBase {
  readonly type: "error";
  readonly error: unknown;
  readonly terminal?: boolean;
  readonly code?: string;
  readonly retryAfterMs?: number;
}

export type RealtimeFeatureEvent<TFeature = unknown> =
  | RealtimeSnapshotEvent<TFeature>
  | RealtimeUpsertEvent<TFeature>
  | RealtimeDeleteEvent
  | RealtimeDeltaEvent<TFeature>
  | RealtimeHeartbeatEvent
  | RealtimeStatusEvent
  | RealtimeErrorEvent;

export interface RealtimeFeatureState<TFeature = unknown> {
  readonly status: RealtimeConnectionStatus;
  readonly records: Readonly<Record<string, RealtimeFeatureRecord<TFeature>>>;
  readonly tombstones: Readonly<Record<string, RealtimeFeatureTombstone>>;
  readonly cursor?: string;
  readonly watermark?: string;
  readonly timestamp?: string;
  readonly deltaToken?: string;
  readonly checkpoint?: RealtimeResumeCheckpoint;
  readonly lastSequence?: number;
  readonly lastEventAt?: number;
  readonly lastStatusAt?: number;
  readonly lastHeartbeatAt?: number;
  readonly staleSince?: number;
  readonly error?: unknown;
  readonly statusReason?: string;
  readonly retryAfterMs?: number;
  readonly reconnectAttempt?: number;
  readonly terminalError?: boolean;
  readonly ignoredEventCount: number;
  readonly seenEventIds: ReadonlyArray<string>;
}

export interface RealtimeReducerOptions {
  readonly now?: () => number;
  readonly maxSeenEventIds?: number;
  /**
   * Upper bound on the number of delete tombstones retained in state. Outside a
   * `replace` snapshot, tombstones are never cleared, so a long-lived delta
   * subscription leaks one entry per delete. When the cap is exceeded the
   * oldest tombstones (by `deletedAt`) are evicted, mirroring the
   * {@link maxSeenEventIds} cap. Defaults to 1024; set to `0` to disable the
   * count bound.
   */
  readonly maxTombstones?: number;
  /**
   * Maximum age, in milliseconds, of a retained tombstone measured from its
   * `deletedAt`. Tombstones older than this are dropped on the next reduce.
   * Disabled (no age bound) when omitted.
   */
  readonly tombstoneTtlMs?: number;
}

export interface RealtimeStalenessOptions {
  readonly staleAfterMs: number;
  readonly now?: number;
}

export interface RealtimeSubscriptionIdentity {
  readonly sourceId: SourceId;
  readonly layerId?: string | number;
  readonly where?: string;
  readonly fields?: ReadonlyArray<string>;
  readonly spatialFilter?: unknown;
  /**
   * Optional caller-owned logical subscription id. Use this when a UI needs
   * to reconnect the same source/layer/filter request across page reloads.
   */
  readonly requestId?: string;
}

export interface RealtimeSubscriptionRequest extends RealtimeSubscriptionIdentity {
  readonly mode?: RealtimeSubscriptionMode;
  readonly resumeFrom?: RealtimeResumeCheckpoint;
  readonly cursor?: string;
  readonly watermark?: string;
  readonly timestamp?: string;
  readonly deltaToken?: string;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RealtimeFeatureObserver<TFeature = unknown> {
  next(event: RealtimeFeatureEvent<TFeature>): void;
  error(error: unknown): void;
  complete(): void;
}

export interface RealtimeSubscriptionHandle {
  close(): void;
}

export interface RealtimeTransportCapabilities {
  readonly kind: RealtimeTransportKind;
  readonly resumeModes?: ReadonlyArray<RealtimeResumeMode>;
  readonly emitsHeartbeats?: boolean;
  readonly emitsWatermarks?: boolean;
}

export interface RealtimeFeatureTransport<TFeature = unknown> {
  readonly capabilities?: RealtimeTransportCapabilities;
  subscribe(
    request: RealtimeSubscriptionRequest,
    observer: RealtimeFeatureObserver<TFeature>,
  ): RealtimeSubscriptionHandle;
}

export type RealtimeStateListener<TFeature = unknown> = (
  state: RealtimeFeatureState<TFeature>,
  event: RealtimeFeatureEvent<TFeature> | undefined,
) => void;
