/**
 * OSRM adapter for the {@link RoutingProvider} contract, targeting the OSRM
 * HTTP API v1 (`/route/v1/{profile}/{coordinates}`).
 *
 * There is no default endpoint: pass the `baseUrl` of an instance you are
 * entitled to use. If you point at the public demo
 * (`https://router.project-osrm.org` or an FOSSGIS/OSM community instance)
 * you MUST follow its usage policy — light, non-commercial request volumes.
 *
 * @packageDocumentation
 */

import type { CapabilityPolicy } from "../../contract/types.js";
import { HonuaHttpError } from "../../core/errors.js";
import { type ProviderTransportOptions, providerGetJson, trimProviderBaseUrl } from "../../geocoding/provider-http.js";
import {
  type ProviderRouteResult,
  type RouteWaypoint,
  type RoutingCapability,
  type RoutingProvenance,
  type RoutingProvider,
  assertRouteWaypoints,
  assertRoutingCapability,
} from "../provider.js";

/** Options for {@link osrmRoutingProvider}. @experimental */
export interface OsrmProviderOptions extends ProviderTransportOptions {
  /**
   * Base URL of the OSRM instance, e.g. `https://osrm.example.org`.
   * Required — no third-party default is baked in (usage-policy safety).
   */
  baseUrl: string;
  /** OSRM profile path segment (default `"driving"`). */
  profile?: string;
  /** Capability policy for declared-capability enforcement. */
  capabilityPolicy?: CapabilityPolicy;
  /** Override the default attribution string (self-hosted instances). */
  attribution?: string;
  /** Override the default usage-policy URL (self-hosted instances). */
  usagePolicyUrl?: string;
}

interface OsrmRouteResponse {
  code?: string;
  message?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: { coordinates?: [number, number][] };
    legs?: Array<{ distance?: number; duration?: number }>;
  }>;
}

const OSRM_ATTRIBUTION = "Route data © OpenStreetMap contributors, ODbL 1.0";
const OSRM_USAGE_POLICY_URL = "https://routing.openstreetmap.de/about.html";
const OSRM_CAPABILITIES: ReadonlyArray<RoutingCapability> = ["route"];

/**
 * Create a {@link RoutingProvider} backed by an OSRM instance.
 *
 * @experimental
 */
export function osrmRoutingProvider(options: OsrmProviderOptions): RoutingProvider {
  const baseUrl = trimProviderBaseUrl(options.baseUrl);
  const profile = options.profile ?? "driving";
  const policy = options.capabilityPolicy ?? "strict";
  const provenance: RoutingProvenance = Object.freeze({
    provider: "osrm",
    attribution: options.attribution ?? OSRM_ATTRIBUTION,
    usagePolicyUrl: options.usagePolicyUrl ?? OSRM_USAGE_POLICY_URL,
  });

  return {
    id: "osrm",
    capabilities: OSRM_CAPABILITIES,
    attribution: provenance.attribution,
    usagePolicyUrl: provenance.usagePolicyUrl,

    async route(waypoints: ReadonlyArray<RouteWaypoint>): Promise<ProviderRouteResult> {
      assertRoutingCapability({ id: "osrm", capabilities: OSRM_CAPABILITIES }, "route", policy);
      assertRouteWaypoints(waypoints);

      const coordinates = waypoints.map((waypoint) => `${waypoint.longitude},${waypoint.latitude}`).join(";");
      const params = new URLSearchParams({
        overview: "full",
        geometries: "geojson",
        alternatives: "false",
        steps: "false",
      });
      const url = `${baseUrl}/route/v1/${encodeURIComponent(profile)}/${coordinates}?${params.toString()}`;
      const data = await providerGetJson<OsrmRouteResponse>(url, {
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        label: "osrm route",
      });

      const route = data.routes?.[0];
      if (data.code !== "Ok" || !route) {
        throw new HonuaHttpError(
          200,
          `OSRM route error: ${data.code ?? "no route"}${data.message ? ` — ${data.message}` : ""}`,
          data,
        );
      }

      return {
        geometry: (route.geometry?.coordinates ?? []).map(([lon, lat]) => [lon, lat] as [number, number]),
        distanceMeters: route.distance ?? 0,
        durationSeconds: route.duration ?? 0,
        legs: (route.legs ?? []).map((leg) => ({
          distanceMeters: leg.distance ?? 0,
          durationSeconds: leg.duration ?? 0,
        })),
        provenance,
      };
    },
  };
}
