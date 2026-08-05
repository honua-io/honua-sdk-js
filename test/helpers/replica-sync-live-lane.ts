/**
 * Opt-in gate for the GeoServices replica-sync live lane.
 *
 * The lane needs a deployment with the server's `sync.offline` experimental
 * capability enabled — see `docs/replica-sync.md` for the prerequisites. It is
 * deliberately not a PR gate, and absence of a flagged deployment is recorded as
 * a named non-execution, never as an implicit pass.
 *
 * Observing a deployment is read-only; resolving a conflict writes to it.
 * Enabling the lane must never imply consent to write, so the mutation switch is
 * independent of the enable switch.
 */

export const REPLICA_SYNC_LIVE_ENABLE_ENV = "HONUA_REPLICA_SYNC_LIVE_ENABLED";
export const REPLICA_SYNC_LIVE_BASE_URL_ENV = "HONUA_REPLICA_SYNC_LIVE_BASE_URL";
export const REPLICA_SYNC_LIVE_SERVICE_ENV = "HONUA_REPLICA_SYNC_LIVE_SERVICE_ID";
export const REPLICA_SYNC_LIVE_UNSUPPORTED_SERVICE_ENV = "HONUA_REPLICA_SYNC_LIVE_UNSUPPORTED_SERVICE_ID";
export const REPLICA_SYNC_LIVE_MUTATE_ENV = "HONUA_REPLICA_SYNC_LIVE_MUTATE";
export const REPLICA_SYNC_LIVE_API_KEY_ENV = "HONUA_REPLICA_SYNC_LIVE_API_KEY";
export const REPLICA_SYNC_LIVE_BEARER_ENV = "HONUA_REPLICA_SYNC_LIVE_BEARER_TOKEN";

export type ReplicaSyncLiveEnv = Record<string, string | undefined>;

export type ReplicaSyncLivePlan =
  | {
      readonly executed: false;
      readonly reason: "live-lane-disabled" | "missing-base-url" | "missing-service-id";
    }
  | {
      readonly executed: true;
      readonly baseUrl: string;
      readonly serviceId: string;
      readonly unsupportedServiceId?: string;
      readonly mutate: boolean;
    };

function isTrue(value: string | undefined): boolean {
  return /^(?:1|true)$/iu.test(value ?? "");
}

export function isReplicaSyncLiveEnabled(env: ReplicaSyncLiveEnv = process.env): boolean {
  return isTrue(env[REPLICA_SYNC_LIVE_ENABLE_ENV]);
}

/** Resolve the lane's configuration, or say precisely why it cannot run. */
export function planReplicaSyncLiveLane(env: ReplicaSyncLiveEnv = process.env): ReplicaSyncLivePlan {
  if (!isReplicaSyncLiveEnabled(env)) return { executed: false, reason: "live-lane-disabled" };
  const baseUrl = env[REPLICA_SYNC_LIVE_BASE_URL_ENV];
  if (baseUrl === undefined || baseUrl.length === 0) return { executed: false, reason: "missing-base-url" };
  const serviceId = env[REPLICA_SYNC_LIVE_SERVICE_ENV];
  if (serviceId === undefined || serviceId.length === 0) return { executed: false, reason: "missing-service-id" };
  const unsupportedServiceId = env[REPLICA_SYNC_LIVE_UNSUPPORTED_SERVICE_ENV];
  return {
    executed: true,
    baseUrl,
    serviceId,
    ...(unsupportedServiceId === undefined || unsupportedServiceId.length === 0 ? {} : { unsupportedServiceId }),
    mutate: isTrue(env[REPLICA_SYNC_LIVE_MUTATE_ENV]),
  };
}

/** Every conformance case that reaches a verdict without writing to the deployment. */
export const REPLICA_SYNC_LIVE_READ_ONLY_CASES: readonly string[] = [
  "capabilities-are-explicit",
  "unsupported-sync-is-a-typed-refusal",
  "replica-listing-is-well-formed",
  "replica-listing-paginates-with-a-cursor",
  "unknown-replica-is-replica-not-found",
  "conflict-listing-is-well-formed",
  "conflict-detail-carries-three-way-state",
  "unknown-conflict-is-conflict-not-found",
  "conflict-detail-round-trips-its-summary",
  "resolution-options-are-declared",
];
