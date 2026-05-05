/**
 * Pure reducer helpers for realtime feature state.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import type {
  RealtimeFeatureEvent,
  RealtimeFeaturePatch,
  RealtimeFeatureRecord,
  RealtimeFeatureState,
  RealtimeFeatureTombstone,
  RealtimeReducerOptions,
  RealtimeStalenessOptions,
} from "./types.js";

const DEFAULT_MAX_SEEN_EVENT_IDS = 256;

export function emptyRealtimeFeatureState<TFeature = unknown>(): RealtimeFeatureState<TFeature> {
  return {
    status: "idle",
    records: {},
    tombstones: {},
    ignoredEventCount: 0,
    seenEventIds: [],
  };
}

export function realtimeFeatureKey(sourceId: SourceId | undefined, id: FeatureId): string {
  return `${sourceId ?? ""}:${String(id)}`;
}

export function reduceRealtimeFeatureState<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  event: RealtimeFeatureEvent<TFeature>,
  options: RealtimeReducerOptions = {},
): RealtimeFeatureState<TFeature> {
  if (isDuplicateOrOutOfOrder(state, event)) {
    return {
      ...state,
      ignoredEventCount: state.ignoredEventCount + 1,
    };
  }

  const receivedAt = event.receivedAt ?? options.now?.() ?? Date.now();
  const base = withEventMetadata(state, event, receivedAt, options.maxSeenEventIds ?? DEFAULT_MAX_SEEN_EVENT_IDS);

  switch (event.type) {
    case "snapshot":
      return applySnapshot(base, event.features, {
        replace: event.replace ?? true,
        cursor: event.cursor,
        sequence: event.sequence,
        receivedAt,
      });
    case "upsert":
      return applyUpsert(base, event.feature, {
        cursor: event.cursor,
        sequence: event.sequence,
        receivedAt,
      });
    case "delete":
      return applyDelete(base, {
        id: event.id,
        sourceId: event.sourceId,
        cursor: event.cursor,
        sequence: event.sequence,
        deletedAt: event.deletedAt ?? receivedAt,
      });
    case "heartbeat":
      return {
        ...base,
        status: base.status === "connecting" || base.status === "reconnecting" ? "live" : base.status,
        lastHeartbeatAt: receivedAt,
        staleSince: undefined,
      };
    case "status":
      return {
        ...base,
        status: event.status,
        staleSince: event.status === "stale" ? (event.staleSince ?? receivedAt) : undefined,
        error: event.status === "error" ? base.error : undefined,
      };
    case "error":
      return {
        ...base,
        status: event.terminal ? "error" : "reconnecting",
        error: event.error,
        staleSince: event.terminal ? base.staleSince : receivedAt,
      };
  }
}

export function reconcileRealtimeStaleness<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  options: RealtimeStalenessOptions,
): RealtimeFeatureState<TFeature> {
  const now = options.now ?? Date.now();
  const lastLiveAt = state.lastHeartbeatAt ?? state.lastEventAt;
  if (!lastLiveAt || now - lastLiveAt <= options.staleAfterMs) return state;
  if (state.status === "closed" || state.status === "error" || state.status === "offline") return state;
  return {
    ...state,
    status: "stale",
    staleSince: state.staleSince ?? lastLiveAt + options.staleAfterMs,
  };
}

function isDuplicateOrOutOfOrder<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  event: RealtimeFeatureEvent<TFeature>,
): boolean {
  if (event.eventId && state.seenEventIds.includes(event.eventId)) return true;
  return (
    typeof event.sequence === "number" && typeof state.lastSequence === "number" && event.sequence <= state.lastSequence
  );
}

function withEventMetadata<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  event: RealtimeFeatureEvent<TFeature>,
  receivedAt: number,
  maxSeenEventIds: number,
): RealtimeFeatureState<TFeature> {
  const seenEventIds = event.eventId
    ? [...state.seenEventIds, event.eventId].slice(-Math.max(1, maxSeenEventIds))
    : state.seenEventIds;
  return {
    ...state,
    status:
      state.status === "idle" || state.status === "connecting" || state.status === "reconnecting"
        ? "live"
        : state.status,
    cursor: event.cursor ?? state.cursor,
    watermark: event.watermark ?? state.watermark,
    lastSequence: typeof event.sequence === "number" ? event.sequence : state.lastSequence,
    lastEventAt: receivedAt,
    staleSince: undefined,
    seenEventIds,
  };
}

function applySnapshot<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  features: ReadonlyArray<RealtimeFeaturePatch<TFeature>>,
  metadata: {
    readonly replace: boolean;
    readonly cursor?: string;
    readonly sequence?: number;
    readonly receivedAt: number;
  },
): RealtimeFeatureState<TFeature> {
  const records: Record<string, RealtimeFeatureRecord<TFeature>> = metadata.replace ? {} : { ...state.records };
  const tombstones: Record<string, RealtimeFeatureTombstone> = metadata.replace ? {} : { ...state.tombstones };
  for (const feature of features) {
    const key = realtimeFeatureKey(feature.sourceId, feature.id);
    records[key] = {
      ...feature,
      key,
      cursor: metadata.cursor,
      sequence: metadata.sequence,
      receivedAt: metadata.receivedAt,
    };
    delete tombstones[key];
  }
  return {
    ...state,
    records,
    tombstones,
  };
}

function applyUpsert<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  feature: RealtimeFeaturePatch<TFeature>,
  metadata: {
    readonly cursor?: string;
    readonly sequence?: number;
    readonly receivedAt: number;
  },
): RealtimeFeatureState<TFeature> {
  const key = realtimeFeatureKey(feature.sourceId, feature.id);
  const tombstones = { ...state.tombstones };
  delete tombstones[key];
  return {
    ...state,
    records: {
      ...state.records,
      [key]: {
        ...feature,
        key,
        cursor: metadata.cursor,
        sequence: metadata.sequence,
        receivedAt: metadata.receivedAt,
      },
    },
    tombstones,
  };
}

function applyDelete<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  tombstone: Omit<RealtimeFeatureTombstone, "key">,
): RealtimeFeatureState<TFeature> {
  const key = realtimeFeatureKey(tombstone.sourceId, tombstone.id);
  const records = { ...state.records };
  delete records[key];
  return {
    ...state,
    records,
    tombstones: {
      ...state.tombstones,
      [key]: {
        ...tombstone,
        key,
      },
    },
  };
}
