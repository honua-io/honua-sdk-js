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
  readonly deletedAt: number;
}

export interface RealtimeFeatureEventBase {
  readonly eventId?: string;
  readonly cursor?: string;
  readonly watermark?: string;
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
  readonly deletedAt?: number;
}

export interface RealtimeHeartbeatEvent extends RealtimeFeatureEventBase {
  readonly type: "heartbeat";
}

export interface RealtimeStatusEvent extends RealtimeFeatureEventBase {
  readonly type: "status";
  readonly status: RealtimeConnectionStatus;
  readonly staleSince?: number;
}

export interface RealtimeErrorEvent extends RealtimeFeatureEventBase {
  readonly type: "error";
  readonly error: unknown;
  readonly terminal?: boolean;
}

export type RealtimeFeatureEvent<TFeature = unknown> =
  | RealtimeSnapshotEvent<TFeature>
  | RealtimeUpsertEvent<TFeature>
  | RealtimeDeleteEvent
  | RealtimeHeartbeatEvent
  | RealtimeStatusEvent
  | RealtimeErrorEvent;

export interface RealtimeFeatureState<TFeature = unknown> {
  readonly status: RealtimeConnectionStatus;
  readonly records: Readonly<Record<string, RealtimeFeatureRecord<TFeature>>>;
  readonly tombstones: Readonly<Record<string, RealtimeFeatureTombstone>>;
  readonly cursor?: string;
  readonly watermark?: string;
  readonly lastSequence?: number;
  readonly lastEventAt?: number;
  readonly lastHeartbeatAt?: number;
  readonly staleSince?: number;
  readonly error?: unknown;
  readonly ignoredEventCount: number;
  readonly seenEventIds: ReadonlyArray<string>;
}

export interface RealtimeReducerOptions {
  readonly now?: () => number;
  readonly maxSeenEventIds?: number;
}

export interface RealtimeStalenessOptions {
  readonly staleAfterMs: number;
  readonly now?: number;
}

export interface RealtimeSubscriptionRequest {
  readonly sourceId: SourceId;
  readonly layerId?: string | number;
  readonly where?: string;
  readonly cursor?: string;
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

export interface RealtimeFeatureTransport<TFeature = unknown> {
  subscribe(
    request: RealtimeSubscriptionRequest,
    observer: RealtimeFeatureObserver<TFeature>,
  ): RealtimeSubscriptionHandle;
}

export type RealtimeStateListener<TFeature = unknown> = (
  state: RealtimeFeatureState<TFeature>,
  event: RealtimeFeatureEvent<TFeature> | undefined,
) => void;
