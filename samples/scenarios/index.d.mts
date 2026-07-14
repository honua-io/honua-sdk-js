import type { IncomingMessage, Server, ServerResponse } from "node:http";

export type FixtureScenarioName =
  | "happy"
  | "empty"
  | "unsupported"
  | "overflow"
  | "paginated"
  | "throttled"
  | "abort"
  | "schema-drift"
  | "reconnect"
  | "duplicate-event"
  | "stale-cursor"
  | "range"
  | "edit-conflict"
  | "cache-hit"
  | "cache-stale"
  | "cache-revalidate"
  | "auth-scope";

export const SCENARIO_NAMES: readonly FixtureScenarioName[];
export const SCENARIOS: Readonly<Record<FixtureScenarioName, { readonly name: string; readonly description: string }>>;
export const HARNESS_CI_BUDGET: Readonly<{ startupMs: number; resetMs: number }>;
export const FIXTURE_CSP: string;
export const FIXTURE_RUN_ID_PATTERN_SOURCE: "^[a-z0-9][a-z0-9-]{0,63}$";
export const FIXTURE_RUN_ID_PATTERN: RegExp;
export function isFixtureRunId(value: unknown): value is string;

export interface SampleFixtureHarnessOptions {
  sampleId: "first-map" | "incident-operations";
  fixturePackId?: string;
  fixturePackVersion?: string;
  staticRoot?: string;
  defaultRunId?: string;
  defaultScenario?: FixtureScenarioName;
  maximumRuns?: number;
  runTtlMs?: number;
  registryNow?: () => number;
}

export interface SampleFixtureHarness {
  readonly server: Server;
  readonly origin: string;
  readonly url: string;
  readonly defaultRunId: string;
  readonly readinessUrl: string;
  readonly startupElapsedMs: number;
  close(): Promise<void>;
  inspect(): { activeRuns: number; socketCount: number; authorityFingerprint: string };
}

export interface FixturePackManifest {
  fixturePackVersion: string;
  identity: { id: string; version: string; revision: string; title: string };
  schema: {
    featureCount: number;
    projections?: Array<{
      protocol: string;
      crs: "EPSG:4326" | "OGC:CRS84";
      coordinateEncoding: {
        format: "Esri JSON" | "GeoJSON" | "GeoJSON-compatible positions";
        axes: [string, string];
        order: "xy";
      };
    }>;
    [name: string]: unknown;
  };
  [name: string]: unknown;
}

export interface FixturePack {
  root: string;
  manifest: FixturePackManifest;
  data: Readonly<Record<string, unknown>>;
}

export interface FixturePackValidation extends FixturePack {
  manifestPath: string;
  actualChecksums: Record<string, string>;
  checksumChanges: Array<{ name: string; before: string; after: string }>;
  hashes: { combined: string; license: string; provenance: string };
  metadataChanges: Record<string, { before: string; after: string }>;
  metadataChanged: boolean;
}

export interface FixtureClock {
  now(): number;
  iso(): string;
  advance(milliseconds: number): number;
  reset(): number;
}

export interface FixtureRun<State = unknown> {
  id: string;
  scenario: FixtureScenarioName;
  authScope: string;
  authScopeFingerprint: string;
  seed: string;
  clock: FixtureClock;
  state: State;
  active: boolean;
  requests: unknown[];
}

export interface FixtureRunHandler<State = unknown> {
  createRunState(run: FixtureRun<State>): State;
  disposeRunState?(run: FixtureRun<State>, reason: string): void;
  inspectRunState?(run: FixtureRun<State>): unknown;
}

export interface FixtureRunRegistry<State = unknown> {
  defaultRunId: string;
  maximumRuns: number;
  runTtlMs: number;
  create(options: { id: string; scenario?: FixtureScenarioName; authScope?: string; seed?: string }): FixtureRun<State>;
  get(id?: string): FixtureRun<State>;
  authorize(run: FixtureRun<State>, suppliedScope?: string): void;
  record(run: FixtureRun<State>, request: { method?: string; routeId?: string; queryNames?: readonly unknown[] }): void;
  mutate<Value>(run: FixtureRun<State>, operation: (run: FixtureRun<State>) => Value): Promise<Value>;
  reset(run: FixtureRun<State>): Promise<FixtureRun<State>>;
  remove(id: string): void;
  snapshot(run: FixtureRun<State>): {
    id: string;
    scenario: FixtureScenarioName;
    state: unknown;
    [name: string]: unknown;
  };
  cleanupExpired(): void;
  size(): number;
  disposalErrors(): ReadonlyArray<{ runId: string; reason: string; message: string }>;
  close(): ReadonlyArray<{ runId: string; reason: string; message: string }>;
}

export function startSampleFixtureHarness(options: SampleFixtureHarnessOptions): Promise<SampleFixtureHarness>;
export function canonicalJson(value: unknown): string;
export function fingerprint(value: string): string;
export function fixtureHeaders(extra?: Record<string, string | number>): Record<string, string | number>;
export function fixtureResponseHeaders(
  framing: { contentType: string; contentLength?: number; connection?: "keep-alive" | "close" },
  extra?: Record<string, string | number>,
): Record<string, string | number>;
export function loadFixturePack(id: string, version?: string): FixturePack;
export function validateFixturePackDirectory(
  root: string,
  options?: { allowChecksumChanges?: boolean; allowMetadataChanges?: boolean },
): FixturePackValidation;
export interface StaticRootBinding {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}
export function createStaticRootBinding(root: string): StaticRootBinding;
export function serveStaticFile(res: ServerResponse, root: string | StaticRootBinding, pathname: string): boolean;
export function createRunRegistry<State = unknown>(options: {
  handler: FixtureRunHandler<State>;
  defaultRunId?: string;
  defaultScenario?: FixtureScenarioName;
  maximumRuns?: number;
  runTtlMs?: number;
  now?: () => number;
}): FixtureRunRegistry<State>;
export function createSseSubscriber(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { onClose?: (reason: string) => void; maximumQueuedEvents?: number },
): { send(event: unknown): boolean; close(reason?: string): void; isClosed(): boolean; queuedEventCount(): number };
