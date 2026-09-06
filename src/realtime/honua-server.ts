/**
 * First-party realtime preset for honua-server's
 * `/api/v1/streaming/features` Server-Sent Events endpoint.
 *
 * The default SSE transport encoder emits `sourceId=` / `layerId=` query
 * params and assumes events already use the SDK's `RealtimeFeatureEvent`
 * vocabulary. honua-server instead expects `serviceId=` / `layers=` query
 * params and emits its own feature-change envelopes. This module packages the
 * two hooks (`encodeRequest` + `decodeEvent`) the transport already exposes so
 * consumers do not have to re-implement the same adapter for every app.
 *
 * @example Use the preset options with the SSE transport.
 * ```ts
 * import {
 *   createRealtimeServerSentEventsTransport,
 *   honuaServerRealtimePreset,
 * } from "@honua/sdk-js/realtime";
 *
 * const transport = createRealtimeServerSentEventsTransport({
 *   url: "https://honua.example/api/v1/streaming/features",
 *   ...honuaServerRealtimePreset(),
 * });
 * ```
 *
 * @example Or use the convenience factory.
 * ```ts
 * import { createHonuaServerRealtimeSubscription } from "@honua/sdk-js/realtime";
 *
 * const transport = createHonuaServerRealtimeSubscription({
 *   baseUrl: "https://honua.example",
 * });
 * ```
 *
 * @module
 */

import type { FeatureId } from "../contract/types.js";
import { trimTrailingSlashes } from "../core/path-utils.js";
import { HonuaRealtimeResumeError } from "./resumable.js";
import { createRealtimeServerSentEventsTransport, decodeRealtimeServerSentEvent } from "./sse.js";
import type { RealtimeServerSentEventsTransportOptions } from "./sse.js";
import type {
  RealtimeFeatureEvent,
  RealtimeFeaturePatch,
  RealtimeFeatureTransport,
  RealtimeSubscriptionRequest,
} from "./types.js";

/** Default streaming-features path served by honua-server. */
export const HONUA_SERVER_STREAMING_FEATURES_PATH = "/api/v1/streaming/features";

/**
 * Encode a `RealtimeSubscriptionRequest` into honua-server's
 * `/api/v1/streaming/features` query contract: `serviceId=` (not `sourceId=`)
 * and `layers=` (not `layerId=`). The remaining filter/resume params match the
 * default encoder so cursors, watermarks, and where-clauses keep working.
 */
export function encodeHonuaServerRealtimeRequest(url: URL, request: RealtimeSubscriptionRequest): URL {
  url.searchParams.set("serviceId", String(request.sourceId));
  if (request.layerId !== undefined) url.searchParams.set("layers", String(request.layerId));
  if (request.requestId) url.searchParams.set("requestId", request.requestId);
  if (request.mode) url.searchParams.set("mode", request.mode);
  if (request.where) url.searchParams.set("where", request.where);
  if (request.fields?.length) url.searchParams.set("fields", request.fields.join(","));
  if (request.cursor ?? request.resumeFrom?.cursor) {
    url.searchParams.set("cursor", request.cursor ?? request.resumeFrom?.cursor ?? "");
  }
  if (request.watermark ?? request.resumeFrom?.watermark) {
    url.searchParams.set("watermark", request.watermark ?? request.resumeFrom?.watermark ?? "");
  }
  if (request.timestamp ?? request.resumeFrom?.timestamp) {
    url.searchParams.set("timestamp", request.timestamp ?? request.resumeFrom?.timestamp ?? "");
  }
  if (request.deltaToken ?? request.resumeFrom?.deltaToken) {
    url.searchParams.set("deltaToken", request.deltaToken ?? request.resumeFrom?.deltaToken ?? "");
  }
  if (request.resumeFrom?.sequence !== undefined) {
    url.searchParams.set("sequence", String(request.resumeFrom.sequence));
  }
  if (request.spatialFilter !== undefined) url.searchParams.set("spatialFilter", JSON.stringify(request.spatialFilter));
  if (request.metadata !== undefined) url.searchParams.set("metadata", JSON.stringify(request.metadata));
  return url;
}

/**
 * Shape of a single change carried by a honua-server feature-change envelope.
 * honua-server reports the change kind via `op` (`insert` / `update` / `delete`)
 * alongside the affected feature or feature id.
 */
export interface HonuaServerFeatureChange<TFeature = unknown> {
  readonly op: "insert" | "update" | "delete" | "snapshot";
  readonly featureId?: FeatureId;
  readonly feature?: TFeature;
  readonly version?: number;
  readonly updatedAt?: string;
}

/**
 * Shape of the envelope honua-server writes to the
 * `/api/v1/streaming/features` SSE stream. Each envelope carries the service /
 * layer scope, ordering metadata, and one or more feature changes.
 */
export interface HonuaServerFeatureChangeEnvelope<TFeature = unknown> {
  readonly serviceId?: string;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly eventId?: string;
  readonly operationInstanceId?: string;
  readonly correlationId?: string;
  readonly auditId?: string;
  readonly proposalId?: string;
  readonly sequence?: number;
  readonly cursor?: string;
  readonly watermark?: string;
  readonly timestamp?: string;
  readonly deltaToken?: string;
  /** `change` (or `feature-change`) is the default envelope kind. */
  readonly kind?: string;
  readonly changes?: ReadonlyArray<HonuaServerFeatureChange<TFeature>>;
  /** Single-change envelopes inline the change instead of a `changes` array. */
  readonly op?: HonuaServerFeatureChange<TFeature>["op"];
  readonly featureId?: FeatureId;
  readonly objectId?: FeatureId;
  readonly feature?: TFeature;
  /** Current honua-server wire field; normalized to {@link HonuaServerFeatureChange.op}. */
  readonly operation?: Exclude<HonuaServerFeatureChange<TFeature>["op"], "snapshot">;
  /** Current honua-server GeoJSON geometry field. */
  readonly geometry?: unknown;
  /** Current honua-server full attribute snapshot for insert/update events. */
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly version?: number;
  readonly updatedAt?: string;
  /** Pass-through status / heartbeat / error envelopes. */
  readonly type?: string;
}

/**
 * Decode a honua-server `/api/v1/streaming/features` envelope into the SDK's
 * `RealtimeFeatureEvent`. Feature-change envelopes become `delta` events
 * (batching upserts and deletes); status, heartbeat, and error envelopes that
 * already speak the SDK vocabulary pass through unchanged.
 */
export function decodeHonuaServerRealtimeEvent<TFeature = unknown>(payload: unknown): RealtimeFeatureEvent<TFeature> {
  if (!isRecord(payload)) {
    throw new HonuaRealtimeResumeError("invalid-event", "honua-server streaming payload must be a JSON object.");
  }
  const envelope = payload as HonuaServerFeatureChangeEnvelope<TFeature>;

  // A current-server change discriminator always wins over generic `type`.
  // Otherwise a malformed/colliding payload could masquerade as status or
  // error and bypass the stricter operation/after-image validation below.
  const currentServerChange = envelope.operation !== undefined;

  // Snapshot / status / heartbeat / error envelopes already use the SDK
  // vocabulary. Their `cursor`, however, is honua-server's global event-store
  // position: a JSON number on the batched `snapshot` baseline frame, where the
  // SDK's resume gate requires the string form it checkpoints. Normalizing it
  // here — the one place that already owns honua-server's wire dialect — keeps
  // a batched baseline from failing closed as a checkpoint conflict.
  if (
    !currentServerChange &&
    typeof envelope.type === "string" &&
    envelope.type !== "change" &&
    envelope.type !== "feature-change"
  ) {
    const framed = withNormalizedNumericCursor(payload);
    if (envelope.type === "status" && (payload.status === "connected" || payload.status === "subscribed")) {
      return decodeRealtimeServerSentEvent<TFeature>({ ...framed, status: "live" });
    }
    return decodeRealtimeServerSentEvent<TFeature>(framed);
  }

  const serviceId = optionalNonEmptyText(envelope.serviceId, "serviceId");
  optionalNonEmptyText(envelope.sourceId, "sourceId");
  const cursor = normalizeCursor(envelope.cursor);
  const sequence = optionalSequence(envelope.sequence);
  if (currentServerChange && serviceId === undefined) {
    throw new HonuaRealtimeResumeError(
      "invalid-event",
      "honua-server current feature-change envelope is missing serviceId.",
    );
  }
  const changes = collectChanges(envelope);
  if (changes.length === 0) {
    throw new HonuaRealtimeResumeError("invalid-event", "honua-server feature-change envelope is missing changes.");
  }

  const base = {
    eventId: envelope.eventId,
    ...(optionalNonEmptyText(envelope.operationInstanceId, "operationInstanceId") !== undefined
      ? { operationInstanceId: envelope.operationInstanceId }
      : {}),
    ...(optionalNonEmptyText(envelope.correlationId, "correlationId") !== undefined
      ? { correlationId: envelope.correlationId }
      : {}),
    ...(optionalNonEmptyText(envelope.auditId, "auditId") !== undefined ? { auditId: envelope.auditId } : {}),
    ...(optionalNonEmptyText(envelope.proposalId, "proposalId") !== undefined
      ? { proposalId: envelope.proposalId }
      : {}),
    sequence,
    cursor,
    watermark: envelope.watermark,
    timestamp: envelope.timestamp,
    deltaToken: envelope.deltaToken,
  };

  const upserts: RealtimeFeaturePatch<TFeature>[] = [];
  const deletes: Array<{ readonly id: FeatureId; readonly version?: number; readonly updatedAt?: string }> = [];

  for (const change of changes) {
    if (!isRecord(change)) {
      throw new HonuaRealtimeResumeError("invalid-event", "honua-server feature change must be an object.");
    }
    const operation = featureChangeOperation(change.op);
    const featureId = featureIdValue(change.featureId);
    if (operation === "delete") {
      deletes.push({ id: featureId, version: change.version, updatedAt: change.updatedAt });
      continue;
    }
    if (change.feature === undefined) {
      throw new HonuaRealtimeResumeError(
        "invalid-event",
        `honua-server ${operation} change is missing feature payload.`,
      );
    }
    upserts.push({
      id: featureId,
      sourceId: serviceId,
      feature: change.feature,
      version: change.version,
      updatedAt: change.updatedAt,
    });
  }

  return {
    type: "delta",
    ...base,
    ...(upserts.length ? { upserts } : {}),
    ...(deletes.length ? { deletes: deletes.map((entry) => ({ ...entry, sourceId: serviceId })) } : {}),
  };
}

/**
 * Reusable hook bundle for honua-server's streaming-features endpoint. Spread
 * this into {@link createRealtimeServerSentEventsTransport} options to opt into
 * honua-server's query-param contract and feature-change decoding.
 */
export function honuaServerRealtimePreset<TFeature = unknown>(): Pick<
  RealtimeServerSentEventsTransportOptions<TFeature>,
  "encodeRequest" | "decodeEvent"
> {
  return {
    encodeRequest: (url, request) => {
      encodeHonuaServerRealtimeRequest(url, request);
    },
    decodeEvent: decodeHonuaServerRealtimeEvent<TFeature>,
  };
}

export interface CreateHonuaServerRealtimeSubscriptionOptions<TFeature = unknown>
  extends Omit<RealtimeServerSentEventsTransportOptions<TFeature>, "url" | "encodeRequest" | "decodeEvent"> {
  /**
   * honua-server origin, e.g. `https://honua.example`. The
   * `/api/v1/streaming/features` path is appended automatically. Mutually
   * exclusive with {@link CreateHonuaServerRealtimeSubscriptionOptions.url}.
   */
  readonly baseUrl?: string;
  /**
   * Full streaming-features URL. Use this when the endpoint lives at a
   * non-default path. Overrides {@link CreateHonuaServerRealtimeSubscriptionOptions.baseUrl}.
   */
  readonly url?: string;
  /**
   * Override the honua-server feature-change decoder while keeping the
   * `serviceId=` / `layers=` query encoding.
   */
  readonly decodeEvent?: RealtimeServerSentEventsTransportOptions<TFeature>["decodeEvent"];
}

/**
 * Convenience factory that builds a {@link RealtimeFeatureTransport} wired to
 * honua-server's `/api/v1/streaming/features` endpoint with the
 * {@link honuaServerRealtimePreset} hooks applied.
 */
export function createHonuaServerRealtimeSubscription<TFeature = unknown>(
  options: CreateHonuaServerRealtimeSubscriptionOptions<TFeature>,
): RealtimeFeatureTransport<TFeature> {
  const { baseUrl, url, decodeEvent, ...rest } = options;
  const resolvedUrl = url ?? resolveStreamingUrl(baseUrl);
  const preset = honuaServerRealtimePreset<TFeature>();
  return createRealtimeServerSentEventsTransport<TFeature>({
    ...rest,
    url: resolvedUrl,
    encodeRequest: preset.encodeRequest,
    decodeEvent: decodeEvent ?? preset.decodeEvent,
  });
}

function resolveStreamingUrl(baseUrl: string | undefined): string {
  if (!baseUrl) {
    throw new HonuaRealtimeResumeError(
      "invalid-event",
      "createHonuaServerRealtimeSubscription requires either `url` or `baseUrl`.",
    );
  }
  // Linear trim (no anchored `\/+$` regex) to avoid polynomial backtracking on
  // adversarial input — mirrors the rest of the SDK's path handling.
  return `${trimTrailingSlashes(baseUrl)}${HONUA_SERVER_STREAMING_FEATURES_PATH}`;
}

function collectChanges<TFeature>(
  envelope: HonuaServerFeatureChangeEnvelope<TFeature>,
): ReadonlyArray<HonuaServerFeatureChange<TFeature>> {
  if (envelope.operation !== undefined) {
    const operation = currentServerOperation(envelope.operation);
    const featureId =
      envelope.featureId === "" || envelope.featureId === undefined ? envelope.objectId : envelope.featureId;
    return [
      {
        op: operation,
        featureId,
        feature: operation === "delete" ? undefined : projectCurrentServerFeature<TFeature>(envelope, featureId),
        version: envelope.version,
        updatedAt: envelope.updatedAt ?? envelope.timestamp,
      },
    ];
  }
  if (Array.isArray(envelope.changes)) return envelope.changes;
  if (envelope.op !== undefined) {
    return [
      {
        op: envelope.op,
        featureId: envelope.featureId,
        feature: envelope.feature,
        version: envelope.version,
        updatedAt: envelope.updatedAt,
      },
    ];
  }
  return [];
}

function projectCurrentServerFeature<TFeature>(
  envelope: HonuaServerFeatureChangeEnvelope<TFeature>,
  featureId: FeatureId | undefined,
): TFeature {
  if (!Object.hasOwn(envelope, "geometry") || envelope.geometry === undefined) {
    throw new HonuaRealtimeResumeError(
      "invalid-event",
      "honua-server insert/update change is missing a complete geometry after-image.",
    );
  }
  if (!isAttributeRecord(envelope.attributes)) {
    throw new HonuaRealtimeResumeError(
      "invalid-event",
      "honua-server insert/update change is missing a complete attributes after-image.",
    );
  }
  return {
    type: "Feature",
    ...(featureId === undefined ? {} : { id: featureId }),
    geometry: envelope.geometry,
    properties: envelope.attributes,
  } as TFeature;
}

/**
 * Render a numeric `cursor` in its string form, leaving every other payload
 * untouched. A malformed numeric cursor is deliberately left as-is so the
 * resume gate still reports it, rather than being converted into a decode
 * failure that would hide which contract was actually violated.
 */
function withNormalizedNumericCursor(payload: Record<string, unknown>): Record<string, unknown> {
  const cursor = payload.cursor;
  if (typeof cursor !== "number") return payload;
  if (!Number.isSafeInteger(cursor) || cursor < 0) return payload;
  return { ...payload, cursor: String(cursor) };
}

function normalizeCursor(cursor: unknown): string | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor === "number") {
    if (Number.isSafeInteger(cursor) && cursor >= 0) return String(cursor);
  } else if (typeof cursor === "string" && cursor.length > 0) {
    return cursor;
  }
  throw new HonuaRealtimeResumeError(
    "invalid-event",
    "honua-server feature-change cursor must be a non-empty string or non-negative safe integer.",
  );
}

function optionalSequence(sequence: unknown): number | undefined {
  if (sequence === undefined) return undefined;
  if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0) return sequence;
  throw new HonuaRealtimeResumeError(
    "invalid-event",
    "honua-server feature-change sequence must be a non-negative safe integer.",
  );
}

function optionalNonEmptyText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw new HonuaRealtimeResumeError(
    "invalid-event",
    `honua-server feature-change ${field} must be a non-empty string.`,
  );
}

function featureIdValue(value: unknown): FeatureId {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new HonuaRealtimeResumeError(
    "invalid-event",
    "honua-server feature change featureId must be a non-empty string or safe integer.",
  );
}

function featureChangeOperation(value: unknown): HonuaServerFeatureChange["op"] {
  if (value === "insert" || value === "update" || value === "delete" || value === "snapshot") return value;
  throw new HonuaRealtimeResumeError(
    "invalid-event",
    "honua-server feature change operation must be insert, update, delete, or snapshot.",
  );
}

function currentServerOperation(value: unknown): Exclude<HonuaServerFeatureChange["op"], "snapshot"> {
  if (value === "insert" || value === "update" || value === "delete") return value;
  throw new HonuaRealtimeResumeError(
    "invalid-event",
    "honua-server current feature-change operation must be insert, update, or delete.",
  );
}

function isAttributeRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
