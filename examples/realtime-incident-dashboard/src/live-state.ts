import type { RealtimeConnectionStatus, RealtimeFeatureState, RealtimeResumeCheckpoint } from "@honua/sdk-js/realtime";

export type IncidentMetadataCacheResource = "schemas" | "renderers" | "legends" | "domains";
export type IncidentMetadataCacheStatus = "hit" | "miss" | "stale" | "refreshed" | "bypass";

export interface IncidentMetadataCacheState {
  readonly scope: "metadata";
  readonly status: IncidentMetadataCacheStatus;
  readonly resources: ReadonlyArray<IncidentMetadataCacheResource>;
  readonly ageMs?: number;
  readonly ttlMs?: number;
}

export type IncidentFeatureStateProvenance =
  | {
      readonly source: "realtime-delta";
      readonly checkpoint?: RealtimeResumeCheckpoint;
    }
  | {
      readonly source: "cursor-watermark-replay";
      readonly checkpoint: RealtimeResumeCheckpoint;
    }
  | {
      readonly source: "fresh-snapshot";
      readonly fetchedAt: number;
      readonly maxAgeMs: number;
      readonly checkpoint?: RealtimeResumeCheckpoint;
    }
  | {
      readonly source: "feature-result-cache";
      readonly cacheStatus: "hit" | "stale" | "expired";
      readonly ageMs?: number;
      readonly ttlMs?: number;
      readonly keyFingerprint?: string;
    }
  | {
      readonly source: "unknown";
      readonly reason?: string;
    };

export interface IncidentLiveStateAuthority {
  readonly authoritative: boolean;
  readonly actionsEnabled: boolean;
  readonly liveStatus: RealtimeConnectionStatus;
  readonly reason: string;
  readonly featureProvenance: IncidentFeatureStateProvenance;
  readonly metadataCache?: IncidentMetadataCacheState;
}

export interface IncidentLiveStateAuthorityOptions {
  readonly featureProvenance?: IncidentFeatureStateProvenance;
  readonly metadataCache?: IncidentMetadataCacheState;
  readonly now?: number;
}

export const INCIDENT_METADATA_CACHE_STATE: IncidentMetadataCacheState = {
  scope: "metadata",
  status: "hit",
  resources: ["schemas", "renderers", "legends", "domains"],
  ageMs: 45_000,
  ttlMs: 900_000,
};

const DEFAULT_FRESH_SNAPSHOT_MAX_AGE_MS = 15_000;

export function inferIncidentFeatureProvenance<TFeature>(
  state: RealtimeFeatureState<TFeature>,
): IncidentFeatureStateProvenance {
  const checkpoint = copyRealtimeResumeCheckpoint(state);
  if (hasResumeCheckpoint(checkpoint)) {
    return {
      source: "realtime-delta",
      checkpoint,
    };
  }
  if (state.lastEventAt !== undefined && Object.keys(state.records).length > 0) {
    return {
      source: "fresh-snapshot",
      fetchedAt: state.lastEventAt,
      maxAgeMs: DEFAULT_FRESH_SNAPSHOT_MAX_AGE_MS,
    };
  }
  return {
    source: "unknown",
    reason: "No realtime checkpoint or fresh snapshot has been received.",
  };
}

export function evaluateIncidentLiveStateAuthority<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  options: IncidentLiveStateAuthorityOptions = {},
): IncidentLiveStateAuthority {
  const featureProvenance = options.featureProvenance ?? inferIncidentFeatureProvenance(state);
  const provenanceRejection = rejectNonAuthoritativeProvenance(featureProvenance, options.now ?? Date.now());
  if (provenanceRejection) {
    return {
      authoritative: false,
      actionsEnabled: false,
      liveStatus: state.status,
      reason: provenanceRejection,
      featureProvenance,
      metadataCache: options.metadataCache,
    };
  }

  if (!isAuthoritativeConnectionStatus(state.status)) {
    return {
      authoritative: false,
      actionsEnabled: false,
      liveStatus: state.status,
      reason: `Incident stream is ${state.status}; last incident state is read-only.`,
      featureProvenance,
      metadataCache: options.metadataCache,
    };
  }

  return {
    authoritative: true,
    actionsEnabled: true,
    liveStatus: state.status,
    reason: "Incident feature state is sourced from the live stream.",
    featureProvenance,
    metadataCache: options.metadataCache,
  };
}

export function formatIncidentAuthorityLabel(authority: IncidentLiveStateAuthority): string {
  return authority.authoritative ? "Authoritative" : "Read-only";
}

export function formatIncidentFeatureProvenance(provenance: IncidentFeatureStateProvenance): string {
  switch (provenance.source) {
    case "realtime-delta":
      return provenance.checkpoint ? `Realtime delta (${formatCheckpoint(provenance.checkpoint)})` : "Realtime delta";
    case "cursor-watermark-replay":
      return `Cursor/watermark replay (${formatCheckpoint(provenance.checkpoint)})`;
    case "fresh-snapshot":
      return `Fresh snapshot (${Math.round(provenance.maxAgeMs / 1_000)}s budget)`;
    case "feature-result-cache":
      return `Feature-result cache (${provenance.cacheStatus})`;
    case "unknown":
      return "Unknown feature provenance";
  }
}

export function formatIncidentMetadataCacheState(cache: IncidentMetadataCacheState | undefined): string {
  if (!cache) return "Metadata cache not used";
  return `${titleCase(cache.status)} metadata (${cache.resources.join(", ")})`;
}

function copyRealtimeResumeCheckpoint<TFeature>(
  state: RealtimeFeatureState<TFeature>,
): RealtimeResumeCheckpoint | undefined {
  return state.checkpoint ? { ...state.checkpoint } : undefined;
}

function rejectNonAuthoritativeProvenance(provenance: IncidentFeatureStateProvenance, now: number): string | undefined {
  switch (provenance.source) {
    case "feature-result-cache":
      return provenance.cacheStatus === "stale" || provenance.cacheStatus === "expired"
        ? "Stale feature-result cache cannot be authoritative incident state."
        : "Feature-result cache provenance cannot be authoritative incident state.";
    case "fresh-snapshot": {
      const ageMs = Math.max(0, now - provenance.fetchedAt);
      return ageMs > provenance.maxAgeMs ? "Explicit incident snapshot exceeded its freshness budget." : undefined;
    }
    case "cursor-watermark-replay":
      return hasResumeCheckpoint(provenance.checkpoint)
        ? undefined
        : "Cursor/watermark replay is missing a resume checkpoint.";
    case "realtime-delta":
      return undefined;
    case "unknown":
      return provenance.reason ?? "Incident feature state provenance is unknown.";
  }
}

function isAuthoritativeConnectionStatus(status: RealtimeConnectionStatus): boolean {
  return status === "live";
}

function hasResumeCheckpoint(checkpoint: RealtimeResumeCheckpoint | undefined): checkpoint is RealtimeResumeCheckpoint {
  return (
    checkpoint !== undefined &&
    (checkpoint.cursor !== undefined ||
      checkpoint.watermark !== undefined ||
      checkpoint.timestamp !== undefined ||
      checkpoint.sequence !== undefined ||
      checkpoint.deltaToken !== undefined)
  );
}

function formatCheckpoint(checkpoint: RealtimeResumeCheckpoint): string {
  if (checkpoint.cursor) return `cursor ${checkpoint.cursor}`;
  if (checkpoint.watermark) return `watermark ${checkpoint.watermark}`;
  if (checkpoint.deltaToken) return `delta ${checkpoint.deltaToken}`;
  if (checkpoint.timestamp) return `timestamp ${checkpoint.timestamp}`;
  if (checkpoint.sequence !== undefined) return `sequence ${checkpoint.sequence}`;
  return "checkpoint pending";
}

function titleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
