/**
 * Provider-pluggable routing contract: `RoutingProvider` plus the normalized
 * route result shape every adapter maps into (OSRM, Valhalla, and the Honua
 * facade).
 *
 * @packageDocumentation
 */

import type { CapabilityPolicy } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";

/**
 * Operations a {@link RoutingProvider} may support.
 *
 * @experimental
 */
export type RoutingCapability = "route";

/**
 * Identifies which provider produced a route and carries that provider's
 * attribution / usage-policy obligations so hosts can surface them.
 *
 * @experimental
 */
export interface RoutingProvenance {
  /** Provider identifier, e.g. `"osrm"`, `"valhalla"`, `"honua"`. */
  readonly provider: string;
  /** Human-readable data attribution the host is obliged to display. */
  readonly attribution: string;
  /** Usage/acceptable-use policy for the configured endpoint, when known. */
  readonly usagePolicyUrl?: string;
}

/**
 * A stop along the requested route, WGS84 longitude/latitude.
 *
 * @experimental
 */
export interface RouteWaypoint {
  longitude: number;
  latitude: number;
  name?: string;
}

/**
 * One leg of the normalized route (between two consecutive waypoints).
 *
 * @experimental
 */
export interface ProviderRouteLeg {
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Normalized route result. `geometry` is a WGS84 `[longitude, latitude]`
 * polyline covering the whole route.
 *
 * @experimental
 */
export interface ProviderRouteResult {
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  legs: ProviderRouteLeg[];
  provenance: RoutingProvenance;
}

/**
 * Provider-pluggable routing contract. Adapters normalize into the same typed
 * result shape; capability differences are declared, not discovered at
 * runtime. Operations outside {@link capabilities} throw
 * `HonuaCapabilityNotSupportedError` under the `"strict"` capability policy
 * (the default).
 *
 * @experimental
 */
export interface RoutingProvider {
  /** Stable provider identifier, e.g. `"osrm"`. */
  readonly id: string;
  /** Operations this provider supports. */
  readonly capabilities: ReadonlyArray<RoutingCapability>;
  /** Human-readable data attribution the host is obliged to display. */
  readonly attribution: string;
  /** Usage/acceptable-use policy for the configured endpoint, when known. */
  readonly usagePolicyUrl?: string;

  /** Solve a route through at least two waypoints, in order. */
  route(waypoints: ReadonlyArray<RouteWaypoint>): Promise<ProviderRouteResult>;
}

/**
 * `true` when `provider` declares `capability`.
 *
 * @experimental
 */
export function supportsRoutingCapability(provider: RoutingProvider, capability: RoutingCapability): boolean {
  return provider.capabilities.includes(capability);
}

/**
 * Enforce a capability declaration against the active capability policy.
 * Returns `true` when the capability is supported. When it is missing, throws
 * `HonuaCapabilityNotSupportedError` under `"strict"` (the default) or returns
 * `false` under `"degraded"`.
 *
 * @experimental
 */
export function assertRoutingCapability(
  provider: Pick<RoutingProvider, "id" | "capabilities">,
  capability: RoutingCapability,
  policy: CapabilityPolicy = "strict",
): boolean {
  if (provider.capabilities.includes(capability)) {
    return true;
  }
  if (policy === "strict") {
    throw new HonuaCapabilityNotSupportedError(capability, provider.id);
  }
  return false;
}

/** @internal */
export function assertRouteWaypoints(waypoints: ReadonlyArray<RouteWaypoint>): void {
  if (waypoints.length < 2) {
    throw new Error("route() requires at least two waypoints.");
  }
  for (const waypoint of waypoints) {
    if (!Number.isFinite(waypoint.longitude) || !Number.isFinite(waypoint.latitude)) {
      throw new Error("route() waypoints must have finite longitude/latitude values.");
    }
  }
}

/** Re-exported so provider hosts can type their policy without importing `/contract`. */
export type { CapabilityPolicy };
