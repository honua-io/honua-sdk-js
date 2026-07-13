/**
 * Honua facade adapter for the {@link RoutingProvider} contract.
 *
 * The SDK's existing routing surface is the esri-compat route-provider
 * callback (`RouteLayerCompat` / `RouteTaskCompat` `routeProvider`), which
 * solves `stops → { path, totalLengthMeters, totalTimeSeconds }`. This module
 * bridges both directions without importing the (heavy) esri-compat
 * entrypoint:
 *
 * - {@link honuaRoutingProvider} wraps a compat-shaped solver in the
 *   provider-pluggable {@link RoutingProvider} contract.
 * - {@link routingProviderToCompatRouteProvider} adapts any
 *   {@link RoutingProvider} (OSRM, Valhalla, …) into a compat-shaped solver
 *   usable as `RouteTaskCompat`'s / `RouteLayerCompat`'s `routeProvider`.
 *
 * @packageDocumentation
 */

import type { CapabilityPolicy } from "../../contract/types.js";
import {
  type ProviderRouteLeg,
  type ProviderRouteResult,
  type RouteWaypoint,
  type RoutingCapability,
  type RoutingProvenance,
  type RoutingProvider,
  assertRouteWaypoints,
  assertRoutingCapability,
} from "../provider.js";

/**
 * Structural mirror of esri-compat's `RouteStopCompat` (`location` is
 * `[longitude, latitude]`), kept import-free so `/routing` stays small.
 *
 * @experimental
 */
export interface CompatRouteStop {
  name?: string;
  location: [number, number];
}

/**
 * Structural mirror of esri-compat's `RouteSolveResultCompat`.
 *
 * @experimental
 */
export interface CompatRouteSolveResult {
  path: [number, number][];
  totalLengthMeters: number;
  totalTimeSeconds: number;
}

/**
 * The Honua facade's route solver shape (esri-compat `routeProvider`).
 *
 * @experimental
 */
export type CompatRouteSolver = (
  stops: readonly CompatRouteStop[],
) => Promise<CompatRouteSolveResult> | CompatRouteSolveResult;

/** Options for {@link honuaRoutingProvider}. @experimental */
export interface HonuaRoutingProviderOptions {
  /** Capability policy for declared-capability enforcement. */
  capabilityPolicy?: CapabilityPolicy;
  /** Override the default attribution string for your deployment's data. */
  attribution?: string;
  /** Usage-policy URL for your deployment, when applicable. */
  usagePolicyUrl?: string;
}

const HONUA_ATTRIBUTION = "Honua-hosted route service";
const HONUA_CAPABILITIES: ReadonlyArray<RoutingCapability> = ["route"];

/**
 * Wrap the existing Honua facade route solver (the esri-compat
 * `routeProvider` callback shape) in the {@link RoutingProvider} contract.
 *
 * The compat solver only reports aggregate totals, so to preserve the
 * contract's one-leg-per-waypoint-segment shape (matching OSRM/Valhalla),
 * multi-waypoint routes are solved one consecutive segment at a time —
 * `waypoints.length - 1` solver calls — and stitched: leg geometry is
 * concatenated (dropping the duplicated junction vertex) and totals are the
 * sums of the segment totals. Routing through fixed, in-order via points is
 * exactly the concatenation of its pairwise routes, so the result is
 * unchanged for solvers that route stops in order.
 *
 * @experimental
 */
export function honuaRoutingProvider(
  solve: CompatRouteSolver,
  options: HonuaRoutingProviderOptions = {},
): RoutingProvider {
  const policy = options.capabilityPolicy ?? "strict";
  const provenance: RoutingProvenance = Object.freeze({
    provider: "honua",
    attribution: options.attribution ?? HONUA_ATTRIBUTION,
    ...(options.usagePolicyUrl !== undefined ? { usagePolicyUrl: options.usagePolicyUrl } : {}),
  });

  return {
    id: "honua",
    capabilities: HONUA_CAPABILITIES,
    attribution: provenance.attribution,
    usagePolicyUrl: provenance.usagePolicyUrl,

    async route(waypoints: ReadonlyArray<RouteWaypoint>): Promise<ProviderRouteResult> {
      assertRoutingCapability({ id: "honua", capabilities: HONUA_CAPABILITIES }, "route", policy);
      assertRouteWaypoints(waypoints);

      const stops: CompatRouteStop[] = waypoints.map((waypoint) => ({
        name: waypoint.name,
        location: [waypoint.longitude, waypoint.latitude],
      }));

      const geometry: [number, number][] = [];
      const legs: ProviderRouteLeg[] = [];
      let distanceMeters = 0;
      let durationSeconds = 0;

      for (let i = 1; i < stops.length; i += 1) {
        const solved = await solve([stops[i - 1], stops[i]]);
        // Consecutive segments repeat the junction vertex; drop the duplicate.
        const startIndex = geometry.length > 0 && solved.path.length > 0 ? 1 : 0;
        for (let p = startIndex; p < solved.path.length; p += 1) {
          const [lon, lat] = solved.path[p];
          geometry.push([lon, lat]);
        }
        legs.push({
          distanceMeters: solved.totalLengthMeters,
          durationSeconds: solved.totalTimeSeconds,
        });
        distanceMeters += solved.totalLengthMeters;
        durationSeconds += solved.totalTimeSeconds;
      }

      return { geometry, distanceMeters, durationSeconds, legs, provenance };
    },
  };
}

/**
 * Adapt any {@link RoutingProvider} into the esri-compat `routeProvider`
 * callback shape so `RouteTaskCompat` / `RouteLayerCompat` / `DirectionsCompat`
 * can be backed by OSRM, Valhalla, or a custom provider.
 *
 * @experimental
 */
export function routingProviderToCompatRouteProvider(provider: RoutingProvider): CompatRouteSolver {
  return async (stops: readonly CompatRouteStop[]): Promise<CompatRouteSolveResult> => {
    const waypoints: RouteWaypoint[] = stops.map((stop) => ({
      longitude: stop.location[0],
      latitude: stop.location[1],
      name: stop.name,
    }));
    const result = await provider.route(waypoints);
    return {
      path: result.geometry.map(([lon, lat]) => [lon, lat] as [number, number]),
      totalLengthMeters: result.distanceMeters,
      totalTimeSeconds: result.durationSeconds,
    };
  };
}
