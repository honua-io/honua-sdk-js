/**
 * Deterministic behavioral-conformance harness for certified Honua plugins.
 *
 * Certification (see {@link certifyHonuaPluginManifest}) proves a manifest is
 * well formed and compatible with a host. This harness proves the *behavior*
 * of a certified plugin under an explicit application-local registry: that it
 * retries transient host failures within a declared budget, that its per-run
 * host interaction cost stays within a declared performance bound and is
 * deterministic across runs, and that its declared bundle footprint stays
 * within a declared budget with complete inventory metadata.
 *
 * Every measurement is an integer counted from instrumented host services — no
 * wall-clock time, randomness, or environment path enters the result — so the
 * frozen {@link HonuaPluginConformanceReport} serializes identically on every
 * run and can be committed as a golden report and re-verified by its digest.
 *
 * @packageDocumentation
 */

import { canonicalStringify, sha256 } from "../query-planner/canonical.js";
import { certifyHonuaPluginManifest } from "./certification.js";
import { deepFreeze } from "./plain-json.js";
import { HonuaPluginRegistry } from "./registry.js";
import type {
  HonuaPluginConformanceObservation,
  HonuaPluginConformanceReport,
  HonuaPluginConformanceScenario,
  HonuaPluginConformanceScenarioResult,
  HonuaPluginFactory,
  HonuaPluginHostServices,
  HonuaPluginJsonValue,
  HonuaPluginKind,
} from "./types.js";

/** A plugin factory of any single declared kind (kind-erased for the harness). */
export type AnyHonuaPluginFactory = { readonly [K in HonuaPluginKind]: HonuaPluginFactory<K> }[HonuaPluginKind];

/** Drives one canonical plugin operation through its registered extension. */
export type HonuaPluginConformanceProbe = (registry: HonuaPluginRegistry) => void | Promise<void>;

/** Declared behavioral bounds a plugin must satisfy to conform. */
export interface HonuaPluginConformanceSpec {
  /** Factory carrying inert manifest JSON plus the initialize hook. */
  readonly factory: AnyHonuaPluginFactory;
  /** Invoke exactly one canonical plugin operation. Errors fail the scenario. */
  readonly probe: HonuaPluginConformanceProbe;
  readonly retries: {
    /** Transient host failures the harness injects before the call succeeds. */
    readonly injectedFailures: number;
    /** Upper bound on total host attempts the plugin may make to recover. */
    readonly maxAttempts: number;
  };
  readonly performance: {
    /** Upper bound on host-service interactions caused by one probe run. */
    readonly maxServiceCalls: number;
  };
  readonly bundle: {
    readonly minifiedBytes: number;
    readonly gzipBytes: number;
    readonly maxMinifiedBytes: number;
    readonly maxGzipBytes: number;
  };
}

interface Counter {
  interactions: number;
  networkFailuresRemaining: number;
}

function observe(
  metric: string,
  observed: number,
  bound: number,
  comparison: HonuaPluginConformanceObservation["comparison"],
): HonuaPluginConformanceObservation {
  const satisfied =
    comparison === "<=" ? observed <= bound : comparison === ">=" ? observed >= bound : observed === bound;
  return { metric, observed, bound, comparison, satisfied };
}

function scenarioResult(
  scenario: HonuaPluginConformanceScenario,
  observations: readonly HonuaPluginConformanceObservation[],
): HonuaPluginConformanceScenarioResult {
  return {
    scenario,
    status: observations.every((observation) => observation.satisfied) ? "passed" : "failed",
    observations,
  };
}

/** Instrumented, deterministic host services. Every interaction is counted. */
function instrumentedServices(counter: Counter): HonuaPluginHostServices {
  const tick = () => {
    counter.interactions += 1;
  };
  return {
    network: {
      request: async () => {
        tick();
        if (counter.networkFailuresRemaining > 0) {
          counter.networkFailuresRemaining -= 1;
          throw new Error("HONUA_CONFORMANCE_TRANSIENT");
        }
        return "0";
      },
    },
    credentials: {
      get: async () => {
        tick();
        return "conformance-token";
      },
    },
    storage: {
      get: async () => {
        tick();
        return undefined;
      },
      set: async () => {
        tick();
      },
      delete: async () => {
        tick();
      },
    },
    cache: {
      get: async () => {
        tick();
        return undefined;
      },
      set: async () => {
        tick();
      },
    },
    mutation: {
      execute: async () => {
        tick();
        return "ok";
      },
    },
    realtime: {
      subscribe: async () => {
        tick();
        return { active: true };
      },
    },
    provenance: {
      record: () => {
        tick();
      },
    },
  };
}

interface RunOutcome {
  readonly completed: boolean;
  readonly interactions: number;
}

async function runProbe(
  spec: HonuaPluginConformanceSpec,
  hostInput: string,
  injectedFailures: number,
): Promise<RunOutcome> {
  const counter: Counter = { interactions: 0, networkFailuresRemaining: injectedFailures };
  const registry = new HonuaPluginRegistry({ host: hostInput, services: instrumentedServices(counter) });
  let completed = false;
  try {
    await registry.register([spec.factory as never]);
    await spec.probe(registry);
    completed = true;
  } catch {
    completed = false;
  } finally {
    await registry.dispose().catch(() => undefined);
  }
  return { completed, interactions: counter.interactions };
}

async function runRetriesScenario(
  spec: HonuaPluginConformanceSpec,
  hostInput: string,
): Promise<HonuaPluginConformanceScenarioResult> {
  const outcome = await runProbe(spec, hostInput, spec.retries.injectedFailures);
  return scenarioResult("retries", [
    observe("hostAttempts", outcome.interactions, spec.retries.maxAttempts, "<="),
    observe("recovered", outcome.completed ? 1 : 0, 1, ">="),
  ]);
}

async function runPerformanceScenario(
  spec: HonuaPluginConformanceSpec,
  hostInput: string,
): Promise<HonuaPluginConformanceScenarioResult> {
  const first = await runProbe(spec, hostInput, 0);
  const second = await runProbe(spec, hostInput, 0);
  return scenarioResult("performance", [
    observe("serviceCalls", first.interactions, spec.performance.maxServiceCalls, "<="),
    observe("completed", first.completed ? 1 : 0, 1, ">="),
    observe("deterministic", first.interactions === second.interactions ? 1 : 0, 1, ">="),
  ]);
}

function runBundleScenario(spec: HonuaPluginConformanceSpec): HonuaPluginConformanceScenarioResult {
  const { minifiedBytes, gzipBytes, maxMinifiedBytes, maxGzipBytes } = spec.bundle;
  const metadataComplete = minifiedBytes > 0 && gzipBytes > 0 && gzipBytes <= minifiedBytes ? 1 : 0;
  return scenarioResult("bundle-metadata", [
    observe("minifiedBytes", minifiedBytes, maxMinifiedBytes, "<="),
    observe("gzipBytes", gzipBytes, maxGzipBytes, "<="),
    observe("metadataComplete", metadataComplete, 1, ">="),
  ]);
}

/**
 * Run the deterministic behavioral-conformance suite for one plugin against one
 * explicit host snapshot. The returned report is deeply frozen, binds the
 * certification digest it depends on, and is sealed by a top-level SHA-256.
 */
export async function runHonuaPluginConformance(
  spec: HonuaPluginConformanceSpec,
  hostInput: string,
): Promise<HonuaPluginConformanceReport> {
  const certification = certifyHonuaPluginManifest(spec.factory.manifest, hostInput);
  const scenarios: HonuaPluginConformanceScenarioResult[] = [];
  if (certification.status === "certified") {
    scenarios.push(await runRetriesScenario(spec, hostInput));
    scenarios.push(await runPerformanceScenario(spec, hostInput));
  } else {
    scenarios.push(scenarioResult("retries", [observe("certified", 0, 1, ">=")]));
    scenarios.push(scenarioResult("performance", [observe("certified", 0, 1, ">=")]));
  }
  scenarios.push(runBundleScenario(spec));

  const status = scenarios.every((scenario) => scenario.status === "passed") ? "passed" : "failed";
  const unsignedReport = {
    reportVersion: 1 as const,
    plugin: certification.plugin,
    status,
    certification: { status: certification.status, sha256: certification.sha256 },
    scenarios,
  };
  const report = {
    ...unsignedReport,
    sha256: sha256(canonicalStringify(unsignedReport as unknown as Parameters<typeof canonicalStringify>[0])),
  };
  return deepFreeze(report as unknown as HonuaPluginJsonValue) as unknown as HonuaPluginConformanceReport;
}
