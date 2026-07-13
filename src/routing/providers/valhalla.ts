/**
 * Valhalla adapter for the {@link RoutingProvider} contract, targeting the
 * Valhalla `/route` API. Leg shapes are decoded from Valhalla's 1e-6
 * precision encoded polylines.
 *
 * There is no default endpoint: pass the `baseUrl` of an instance you are
 * entitled to use (e.g. a self-hosted Valhalla, or the FOSSGIS community
 * instance `https://valhalla1.openstreetmap.de` within its usage policy).
 *
 * @packageDocumentation
 */

import type { CapabilityPolicy } from "../../contract/types.js";
import { HonuaHttpError } from "../../core/errors.js";
import { type ProviderTransportOptions, providerGetJson, trimProviderBaseUrl } from "../../geocoding/provider-http.js";
import { decodePolyline } from "../polyline.js";
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

/** Options for {@link valhallaRoutingProvider}. @experimental */
export interface ValhallaProviderOptions extends ProviderTransportOptions {
  /**
   * Base URL of the Valhalla instance, e.g. `https://valhalla.example.org`.
   * Required — no third-party default is baked in (usage-policy safety).
   */
  baseUrl: string;
  /** Valhalla costing model (default `"auto"`). */
  costing?: string;
  /** Capability policy for declared-capability enforcement. */
  capabilityPolicy?: CapabilityPolicy;
  /** Override the default attribution string (self-hosted instances). */
  attribution?: string;
  /** Override the default usage-policy URL (self-hosted instances). */
  usagePolicyUrl?: string;
}

interface ValhallaRouteResponse {
  trip?: {
    status?: number;
    status_message?: string;
    legs?: Array<{
      shape?: string;
      summary?: { length?: number; time?: number };
    }>;
    summary?: { length?: number; time?: number };
  };
  error?: string;
  error_code?: number;
}

const VALHALLA_ATTRIBUTION = "Route data © OpenStreetMap contributors, ODbL 1.0";
const VALHALLA_USAGE_POLICY_URL = "https://gis-ops.com/global-open-valhalla-server-online/";
const VALHALLA_CAPABILITIES: ReadonlyArray<RoutingCapability> = ["route"];

/**
 * Create a {@link RoutingProvider} backed by a Valhalla instance.
 *
 * @experimental
 */
export function valhallaRoutingProvider(options: ValhallaProviderOptions): RoutingProvider {
  const baseUrl = trimProviderBaseUrl(options.baseUrl);
  const costing = options.costing ?? "auto";
  const policy = options.capabilityPolicy ?? "strict";
  const provenance: RoutingProvenance = Object.freeze({
    provider: "valhalla",
    attribution: options.attribution ?? VALHALLA_ATTRIBUTION,
    usagePolicyUrl: options.usagePolicyUrl ?? VALHALLA_USAGE_POLICY_URL,
  });

  return {
    id: "valhalla",
    capabilities: VALHALLA_CAPABILITIES,
    attribution: provenance.attribution,
    usagePolicyUrl: provenance.usagePolicyUrl,

    async route(waypoints: ReadonlyArray<RouteWaypoint>): Promise<ProviderRouteResult> {
      assertRoutingCapability({ id: "valhalla", capabilities: VALHALLA_CAPABILITIES }, "route", policy);
      assertRouteWaypoints(waypoints);

      const request = {
        locations: waypoints.map((waypoint) => ({
          lat: waypoint.latitude,
          lon: waypoint.longitude,
          ...(waypoint.name !== undefined ? { name: waypoint.name } : {}),
        })),
        costing,
        units: "kilometers",
      };
      const url = `${baseUrl}/route?json=${encodeURIComponent(JSON.stringify(request))}`;
      const data = await providerGetJson<ValhallaRouteResponse>(url, {
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        label: "valhalla route",
      });

      const trip = data.trip;
      if (!trip || data.error !== undefined) {
        throw new HonuaHttpError(200, `Valhalla route error: ${data.error ?? "no trip in response"}`, data);
      }

      const geometry: [number, number][] = [];
      const legs: ProviderRouteLeg[] = [];
      for (const leg of trip.legs ?? []) {
        const shape = leg.shape ? decodePolyline(leg.shape, 1e6) : [];
        // Consecutive legs repeat the junction vertex; drop the duplicate.
        const startIndex = geometry.length > 0 && shape.length > 0 ? 1 : 0;
        for (let i = startIndex; i < shape.length; i += 1) {
          geometry.push(shape[i]);
        }
        legs.push({
          distanceMeters: (leg.summary?.length ?? 0) * 1000,
          durationSeconds: leg.summary?.time ?? 0,
        });
      }

      return {
        geometry,
        distanceMeters: (trip.summary?.length ?? 0) * 1000,
        durationSeconds: trip.summary?.time ?? 0,
        legs,
        provenance,
      };
    },
  };
}
