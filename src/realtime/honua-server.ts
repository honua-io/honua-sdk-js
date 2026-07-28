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
  readonly layerId?: string | number;
  readonly eventId?: string;
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
  readonly feature?: TFeature;
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

  // Status / heartbeat / error envelopes already use the SDK vocabulary.
  if (typeof envelope.type === "string" && envelope.type !== "change" && envelope.type !== "feature-change") {
    return decodeRealtimeServerSentEvent<TFeature>(payload);
  }

  const changes = collectChanges(envelope);
  if (changes.length === 0) {
    throw new HonuaRealtimeResumeError("invalid-event", "honua-server feature-change envelope is missing changes.");
  }

  const base = {
    eventId: envelope.eventId,
    sequence: envelope.sequence,
    cursor: envelope.cursor,
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
    if (change.featureId === undefined) {
      throw new HonuaRealtimeResumeError("invalid-event", "honua-server feature change is missing featureId.");
    }
    if (change.op === "delete") {
      deletes.push({ id: change.featureId, version: change.version, updatedAt: change.updatedAt });
      continue;
    }
    if (change.feature === undefined) {
      throw new HonuaRealtimeResumeError(
        "invalid-event",
        `honua-server ${change.op} change is missing feature payload.`,
      );
    }
    upserts.push({
      id: change.featureId,
      sourceId: envelope.serviceId,
      feature: change.feature,
      version: change.version,
      updatedAt: change.updatedAt,
    });
  }

  return {
    type: "delta",
    ...base,
    ...(upserts.length ? { upserts } : {}),
    ...(deletes.length ? { deletes: deletes.map((entry) => ({ ...entry, sourceId: envelope.serviceId })) } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
