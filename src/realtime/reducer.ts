/**
 * Pure reducer helpers for realtime feature state.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import type {
  RealtimeDeletePatch,
  RealtimeFeatureEvent,
  RealtimeFeaturePatch,
  RealtimeFeatureRecord,
  RealtimeFeatureState,
  RealtimeFeatureTombstone,
  RealtimeReducerOptions,
  RealtimeResumeCheckpoint,
  RealtimeStalenessOptions,
  RealtimeSubscriptionIdentity,
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

export function realtimeSubscriptionKey(request: RealtimeSubscriptionIdentity): string {
  return [
    request.requestId ?? "",
    request.sourceId,
    request.layerId === undefined ? "" : String(request.layerId),
    request.where ?? "",
    request.fields?.join(",") ?? "",
    encodeIdentityPart(request.spatialFilter),
  ].join("\u0000");
}

export function realtimeResumeCheckpoint<TFeature>(
  state: RealtimeFeatureState<TFeature>,
): RealtimeResumeCheckpoint | undefined {
  if (!state.checkpoint) return undefined;
  return { ...state.checkpoint };
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
  const metadata = mutationMetadata(event, receivedAt);

  switch (event.type) {
    case "snapshot":
      return applySnapshot(base, event.features, {
        replace: event.replace ?? true,
        ...metadata,
      });
    case "upsert":
      return applyUpsert(base, event.feature, metadata);
    case "delete":
      return applyDelete(base, {
        id: event.id,
        sourceId: event.sourceId,
        cursor: metadata.cursor,
        sequence: metadata.sequence,
        version: event.version,
        updatedAt: event.updatedAt,
        deletedAt: event.deletedAt ?? receivedAt,
      });
    case "delta":
      return applyDelta(base, event.upserts ?? [], event.deletes ?? [], metadata);
    case "heartbeat":
      return {
        ...base,
        status: base.status === "closed" || base.status === "error" ? base.status : "live",
        lastHeartbeatAt: receivedAt,
        staleSince: undefined,
        error: base.status === "error" ? base.error : undefined,
        statusReason: base.status === "error" ? base.statusReason : undefined,
        retryAfterMs: base.status === "error" ? base.retryAfterMs : undefined,
        reconnectAttempt: base.status === "error" ? base.reconnectAttempt : undefined,
      };
    case "status":
      return {
        ...base,
        status: event.status,
        lastStatusAt: receivedAt,
        staleSince: event.status === "stale" ? (event.staleSince ?? receivedAt) : undefined,
        error: event.status === "error" ? base.error : undefined,
        statusReason: event.reason,
        retryAfterMs: event.retryAfterMs,
        reconnectAttempt: event.reconnectAttempt,
        terminalError: event.status === "error" ? base.terminalError : undefined,
      };
    case "error":
      return {
        ...base,
        status: event.terminal ? "error" : "reconnecting",
        lastStatusAt: receivedAt,
        error: event.error,
        statusReason: event.code,
        retryAfterMs: event.retryAfterMs,
        terminalError: event.terminal === true,
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
  const sequence = eventSequence(event);
  return typeof sequence === "number" && typeof state.lastSequence === "number" && sequence <= state.lastSequence;
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
  const sequence = eventSequence(event);
  const checkpoint = mergeCheckpoint(state.checkpoint, event);
  const cursor = eventCursor(event) ?? state.cursor;
  const watermark = eventWatermark(event) ?? state.watermark;
  const timestamp = eventTimestamp(event) ?? state.timestamp;
  const deltaToken = eventDeltaToken(event) ?? state.deltaToken;
  const status = isRecoverableStatus(state.status) ? "live" : state.status;
  return {
    ...state,
    status,
    cursor,
    watermark,
    timestamp,
    deltaToken,
    checkpoint,
    lastSequence: typeof sequence === "number" ? sequence : state.lastSequence,
    lastEventAt: receivedAt,
    staleSince: undefined,
    error: status === "live" ? undefined : state.error,
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

function applyDelta<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  upserts: ReadonlyArray<RealtimeFeaturePatch<TFeature>>,
  deletes: ReadonlyArray<RealtimeDeletePatch>,
  metadata: {
    readonly cursor?: string;
    readonly sequence?: number;
    readonly receivedAt: number;
  },
): RealtimeFeatureState<TFeature> {
  let next = state;
  for (const feature of upserts) {
    next = applyUpsert(next, feature, metadata);
  }
  for (const tombstone of deletes) {
    next = applyDelete(next, {
      id: tombstone.id,
      sourceId: tombstone.sourceId,
      cursor: metadata.cursor,
      sequence: metadata.sequence,
      version: tombstone.version,
      updatedAt: tombstone.updatedAt,
      deletedAt: tombstone.deletedAt ?? metadata.receivedAt,
    });
  }
  return next;
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

function eventCursor<TFeature>(event: RealtimeFeatureEvent<TFeature>): string | undefined {
  return event.checkpoint?.cursor ?? event.cursor;
}

function eventWatermark<TFeature>(event: RealtimeFeatureEvent<TFeature>): string | undefined {
  return event.checkpoint?.watermark ?? event.watermark;
}

function eventTimestamp<TFeature>(event: RealtimeFeatureEvent<TFeature>): string | undefined {
  return event.checkpoint?.timestamp ?? event.timestamp;
}

function eventDeltaToken<TFeature>(event: RealtimeFeatureEvent<TFeature>): string | undefined {
  return event.checkpoint?.deltaToken ?? event.deltaToken;
}

function eventSequence<TFeature>(event: RealtimeFeatureEvent<TFeature>): number | undefined {
  return event.sequence ?? event.checkpoint?.sequence;
}

function mutationMetadata<TFeature>(
  event: RealtimeFeatureEvent<TFeature>,
  receivedAt: number,
): {
  readonly cursor?: string;
  readonly sequence?: number;
  readonly receivedAt: number;
} {
  return {
    cursor: eventCursor(event),
    sequence: eventSequence(event),
    receivedAt,
  };
}

function mergeCheckpoint<TFeature>(
  previous: RealtimeResumeCheckpoint | undefined,
  event: RealtimeFeatureEvent<TFeature>,
): RealtimeResumeCheckpoint | undefined {
  const cursor = eventCursor(event);
  const watermark = eventWatermark(event);
  const timestamp = eventTimestamp(event);
  const sequence = eventSequence(event);
  const deltaToken = eventDeltaToken(event);
  if (
    previous === undefined &&
    cursor === undefined &&
    watermark === undefined &&
    timestamp === undefined &&
    sequence === undefined &&
    deltaToken === undefined
  ) {
    return undefined;
  }
  return {
    ...(previous ?? {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(deltaToken !== undefined ? { deltaToken } : {}),
  };
}

function isRecoverableStatus(status: RealtimeFeatureState["status"]): boolean {
  return (
    status === "idle" ||
    status === "connecting" ||
    status === "reconnecting" ||
    status === "stale" ||
    status === "offline"
  );
}

function encodeIdentityPart(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(sortIdentityValue(value));
  } catch {
    return String(value);
  }
}

function sortIdentityValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortIdentityValue);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortIdentityValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
