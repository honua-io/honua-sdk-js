import type { Capability, ConnectionInspection, Source } from "@honua/sdk-js";
import type {
  DataToMapDiagnostic,
  DataToMapLibreMap,
  DataToMapStrategy,
  MountSourceOptions,
  MountedSource,
} from "@honua/sdk-js/map";

import type { FirstMapConfig } from "./first-map-config.js";

export interface FirstMapSourceChoice {
  readonly id: string;
  readonly protocol: FirstMapSourceDescriptor["protocol"];
  readonly capabilities: readonly Capability[];
  readonly attribution?: string;
}

export type FirstMapDiagnostic = ConnectionInspection["diagnostics"][number];

export interface FirstMapConnectionView {
  readonly id: string;
  readonly endpoint: string;
  readonly protocol: ConnectionInspection["protocol"];
  readonly cacheStatus: ConnectionInspection["cacheStatus"];
  readonly observedAt?: string;
  readonly diagnostics: readonly FirstMapDiagnostic[];
}

export interface FirstMapViewModel {
  readonly mode: FirstMapConfig["mode"];
  readonly connection: FirstMapConnectionView;
  readonly source: FirstMapSourceChoice;
  readonly strategy: DataToMapStrategy;
  readonly strategyReasons: readonly DataToMapDiagnostic[];
  readonly maxFeatures: number;
}

export interface FirstMapStrategyBoundary<T> {
  readonly source: Source<T>;
  readonly options: Readonly<Pick<MountSourceOptions<T>, "maxGeoJsonFeatures" | "query" | "strategy">>;
}

export interface FirstMapReady<T> {
  readonly state: "ready";
  readonly view: FirstMapViewModel;
  readonly mount: FirstMapStrategyBoundary<T>;
  readonly mounted: MountedSource<T>;
  dispose(): Promise<void>;
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

export type FirstMapWorkflowResult<T> = FirstMapReady<T> | FirstMapSourceSelection | FirstMapFailure;

export interface FirstMapWorkflowOptions<T = Record<string, unknown>> {
  readonly map: DataToMapLibreMap;
  readonly mount?: Readonly<Omit<MountSourceOptions<T>, "maxGeoJsonFeatures" | "query" | "signal" | "strategy">>;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}

export type FirstMapSourceDescriptor = ConnectionInspection["sources"][number]["descriptor"];
