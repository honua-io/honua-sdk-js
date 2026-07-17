import type {
  Capability,
  ConnectionInspection,
  FeatureQueryResult,
  MountedMap,
  QueryExecutionPlanV1,
} from "@honua/sdk-js";
import type { MapLibreRendererMap, MapLibreRendererOptions, MapLibreRendererPeer } from "@honua/sdk-js/runtime";

import type { FirstMapConfig } from "./first-map-config.js";

export type FirstMapSourceDescriptor = ConnectionInspection["sources"][number]["descriptor"];

export interface FirstMapSourceChoice {
  readonly id: string;
  readonly protocol: FirstMapSourceDescriptor["protocol"];
  readonly capabilities: readonly Capability[];
  readonly attribution?: string;
}

export interface FirstMapConnectionView {
  readonly id: string;
  readonly endpoint: string;
  readonly protocol: ConnectionInspection["protocol"];
  readonly cacheStatus: ConnectionInspection["cacheStatus"];
  readonly observedAt?: string;
  readonly diagnostics: ConnectionInspection["diagnostics"];
}

export interface FirstMapViewModel {
  readonly mode: FirstMapConfig["mode"];
  readonly connection: FirstMapConnectionView;
  readonly source: FirstMapSourceChoice;
  readonly maxFeatures: number;
}

export interface FirstMapReady<T> {
  readonly state: "ready";
  readonly view: FirstMapViewModel;
  readonly plan: QueryExecutionPlanV1;
  readonly query: FeatureQueryResult<T>;
  readonly mounted: MountedMap<"maplibre", MapLibreRendererMap>;
  dispose(): Promise<void>;
}

export interface FirstMapOverflow<T> {
  readonly state: "overflow";
  readonly view: FirstMapViewModel;
  readonly plan: QueryExecutionPlanV1;
  readonly query: FeatureQueryResult<T>;
  readonly error: { readonly code: "first-map.query-overflow"; readonly message: string; readonly retryable: false };
}

export interface FirstMapSourceSelection {
  readonly state: "source-selection-required";
  readonly reason: "ambiguous" | "invalid-selection";
  readonly connection: FirstMapConnectionView;
  readonly sources: readonly FirstMapSourceChoice[];
}

export interface FirstMapFailure {
  readonly state: "authentication-required" | "unsupported" | "error";
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export type FirstMapWorkflowResult<T> =
  | FirstMapReady<T>
  | FirstMapOverflow<T>
  | FirstMapSourceSelection
  | FirstMapFailure;

export interface FirstMapWorkflowOptions {
  readonly map: MapLibreRendererMap;
  readonly maplibre?: MapLibreRendererPeer;
  readonly rendererOptions?: MapLibreRendererOptions;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}
