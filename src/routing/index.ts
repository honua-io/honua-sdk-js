/**
 * `@honua/sdk-js/routing` — provider-pluggable routing: the typed
 * `RoutingProvider` contract plus first-party OSRM and Valhalla adapters and
 * the Honua facade bridge. No Honua server is required; provider selection is
 * explicit configuration and no third-party endpoint is baked in.
 *
 * @example
 * ```ts
 * import { osrmRoutingProvider } from "@honua/sdk-js/routing";
 *
 * const router = osrmRoutingProvider({ baseUrl: "https://osrm.example.org" });
 * const route = await router.route([
 *   { longitude: -157.858, latitude: 21.306 },
 *   { longitude: -157.802, latitude: 21.262 },
 * ]);
 * console.log(route.distanceMeters, route.provenance.attribution);
 * ```
 *
 * @example Back an esri-compat `RouteTaskCompat` with OSRM
 * ```ts
 * import { osrmRoutingProvider, routingProviderToCompatRouteProvider } from "@honua/sdk-js/routing";
 * import { RouteTaskCompat } from "@honua/sdk-js/esri-compat";
 *
 * const task = new RouteTaskCompat({
 *   routeProvider: routingProviderToCompatRouteProvider(
 *     osrmRoutingProvider({ baseUrl: "https://osrm.example.org" }),
 *   ),
 * });
 * ```
 *
 * @experimental The `/routing` subpath is experimental: useful today, but the
 * shape may change in any minor release prior to `1.0.0`.
 *
 * @packageDocumentation
 */

export type { ProviderTransportOptions } from "../geocoding/provider-http.js";
export { decodePolyline } from "./polyline.js";
export type {
  CapabilityPolicy,
  ProviderRouteLeg,
  ProviderRouteResult,
  RouteWaypoint,
  RoutingCapability,
  RoutingProvenance,
  RoutingProvider,
} from "./provider.js";
export { assertRoutingCapability, supportsRoutingCapability } from "./provider.js";
export {
  type CompatRouteSolveResult,
  type CompatRouteSolver,
  type CompatRouteStop,
  type HonuaRoutingProviderOptions,
  honuaRoutingProvider,
  routingProviderToCompatRouteProvider,
} from "./providers/honua.js";
export { type OsrmProviderOptions, osrmRoutingProvider } from "./providers/osrm.js";
export { type ValhallaProviderOptions, valhallaRoutingProvider } from "./providers/valhalla.js";
