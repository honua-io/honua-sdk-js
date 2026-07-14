import { assertScenarioName } from "./catalog.mjs";
import { createFrozenClock, createSeededIds, fingerprint, hasAsciiControlCharacters } from "./determinism.mjs";

const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const AUTH_SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const LOG_METHOD = /^(DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/;
const LOG_NAME = /^[A-Za-z0-9._~-]{1,64}$/;
const LOG_ROUTE = /^[a-z][a-z0-9-]{0,63}$/;

export function assertRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    throw Object.assign(new Error("Invalid fixture run id."), { status: 400 });
  }
  return value;
}

function assertAuthScope(value) {
  if (typeof value !== "string" || !AUTH_SCOPE.test(value)) {
    throw Object.assign(new Error("Invalid fixture authorization scope."), { status: 400 });
  }
  return value;
}

function assertSeed(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || hasAsciiControlCharacters(value)) {
    throw Object.assign(new Error("Invalid fixture seed."), { status: 400 });
  }
  return value;
}

export function createRunRegistry({
  handler,
  defaultRunId = "default",
  defaultScenario = "happy",
  maximumRuns = 16,
  runTtlMs = 300_000,
  now = () => Date.now(),
}) {
  assertRunId(defaultRunId);
  assertScenarioName(defaultScenario);
  if (!Number.isSafeInteger(maximumRuns) || maximumRuns < 1 || maximumRuns > 128) {
    throw new Error("maximumRuns must be between 1 and 128.");
  }
  if (!Number.isSafeInteger(runTtlMs) || runTtlMs < 1_000 || runTtlMs > 3_600_000) {
    throw new Error("runTtlMs must be between 1000 and 3600000.");
  }
  const runs = new Map();
  const disposalErrors = [];
  let closed = false;

  function createHandlerState(run) {
    const state = handler.createRunState(run);
    if (state && typeof state.then === "function") {
      throw new TypeError("Fixture handlers must construct run state synchronously.");
    }
    return state;
  }

  function buildRun({ id, scenario, authScope = "public", seed = id }) {
    const clock = createFrozenClock();
    const run = {
      id: assertRunId(id),
      scenario: assertScenarioName(scenario),
      authScope: assertAuthScope(authScope),
      authScopeFingerprint: fingerprint(authScope),
      seed: assertSeed(seed),
      clock,
      ids: createSeededIds(`${seed}:${id}`),
      requests: [],
      createdAt: now(),
      touchedAt: now(),
      mutation: Promise.resolve(),
      active: true,
      state: undefined,
    };
    run.state = createHandlerState(run);
    return run;
  }

  function buildResetCandidate(run) {
    const candidate = {
      id: run.id,
      scenario: run.scenario,
      authScope: run.authScope,
      authScopeFingerprint: run.authScopeFingerprint,
      seed: run.seed,
      clock: createFrozenClock(),
      ids: createSeededIds(`${run.seed}:${run.id}`),
      requests: [],
      createdAt: run.createdAt,
      touchedAt: now(),
      mutation: Promise.resolve(),
      active: true,
      state: undefined,
    };
    try {
      candidate.state = createHandlerState(candidate);
      return candidate;
    } catch (error) {
      if (candidate.state !== undefined) disposeState(candidate, "reset-candidate-construction-failed");
      throw Object.assign(new Error("Fixture run reset failed while constructing replacement state."), {
        cause: error,
        status: 500,
      });
    }
  }

  function disposeState(run, reason) {
    try {
      const disposed = handler.disposeRunState?.(run, reason);
      if (disposed && typeof disposed.then === "function") {
        throw new TypeError("Fixture handlers must dispose run state synchronously.");
      }
      return undefined;
    } catch (error) {
      const contained = Object.freeze({ runId: run.id, reason, message: "Fixture run disposal failed." });
      disposalErrors.push(contained);
      if (disposalErrors.length > maximumRuns) disposalErrors.shift();
      return error;
    }
  }

  function disposeRun(run, reason) {
    if (!run.active) return undefined;
    run.active = false;
    runs.delete(run.id);
    return disposeState(run, reason);
  }

  function cleanupExpired() {
    const cutoff = now() - runTtlMs;
    for (const run of runs.values()) {
      if (run.id !== defaultRunId && run.touchedAt <= cutoff) disposeRun(run, "ttl-expired");
    }
  }

  function create(options) {
    if (closed) throw Object.assign(new Error("Fixture run registry is closed."), { status: 503 });
    cleanupExpired();
    const id = assertRunId(options.id);
    const scenario = assertScenarioName(options.scenario ?? defaultScenario);
    const authScope = assertAuthScope(options.authScope ?? "public");
    const seed = assertSeed(options.seed ?? id);
    const existing = runs.get(id);
    if (existing) {
      if (existing.scenario !== scenario || existing.authScope !== authScope || existing.seed !== seed) {
        throw Object.assign(new Error("Fixture run id already exists with different isolation settings."), {
          status: 409,
        });
      }
      existing.touchedAt = now();
      return existing;
    }
    if (runs.size >= maximumRuns)
      throw Object.assign(new Error("Fixture run registry capacity reached."), { status: 429 });
    const run = buildRun({ id, scenario, authScope, seed });
    runs.set(id, run);
    return run;
  }

  function get(id = defaultRunId) {
    cleanupExpired();
    const run = runs.get(assertRunId(id));
    if (!run?.active) throw Object.assign(new Error("Unknown fixture run."), { status: 404 });
    run.touchedAt = now();
    return run;
  }

  function authorize(run, suppliedScope = "public") {
    const authScope = assertAuthScope(suppliedScope);
    if (run.authScope !== authScope) {
      throw Object.assign(new Error("Fixture authorization scope does not match this run."), { status: 403 });
    }
  }

  function record(run, request) {
    if (!run.active) throw Object.assign(new Error("Fixture run is no longer active."), { status: 410 });
    if (!LOG_METHOD.test(request.method) || typeof request.routeId !== "string" || !LOG_ROUTE.test(request.routeId)) {
      throw new Error("Invalid fixture request-log method or route id.");
    }
    if (!Array.isArray(request.queryNames) || request.queryNames.length > 32) {
      throw new Error("Invalid fixture request-log query names.");
    }
    const queryNames = Object.freeze(
      request.queryNames.map((name) => {
        if (typeof name !== "string" || !LOG_NAME.test(name))
          throw new Error("Invalid fixture request-log query name.");
        return name;
      }),
    );
    run.requests.push(
      Object.freeze({
        method: request.method,
        routeId: request.routeId,
        queryNames,
        observedAt: run.clock.iso(),
        requestId: run.ids.next("request"),
        authScopeFingerprint: run.authScopeFingerprint,
      }),
    );
    if (run.requests.length > 200) run.requests.splice(0, run.requests.length - 200);
  }

  function mutate(run, operation) {
    if (!run.active)
      return Promise.reject(Object.assign(new Error("Fixture run is no longer active."), { status: 410 }));
    const result = run.mutation.then(() => {
      if (!run.active) throw Object.assign(new Error("Fixture run is no longer active."), { status: 410 });
      const value = operation(run);
      if (value && typeof value.then === "function") {
        throw new TypeError("Fixture run mutations must be synchronous and bounded.");
      }
      return value;
    });
    run.mutation = result.catch(() => undefined);
    return result;
  }

  async function reset(run) {
    return mutate(run, () => {
      const candidate = buildResetCandidate(run);
      const disposalError = disposeState(run, "reset");
      if (disposalError) {
        disposeState(candidate, "reset-candidate-abandoned");
        throw Object.assign(new Error("Fixture run reset failed during state disposal."), {
          cause: disposalError,
          status: 500,
        });
      }
      run.clock = candidate.clock;
      run.ids = candidate.ids;
      run.requests = candidate.requests;
      run.state = candidate.state;
      run.touchedAt = candidate.touchedAt;
      return run;
    });
  }

  function remove(id) {
    const run = get(id);
    disposeRun(run, "deleted");
  }

  function snapshot(run) {
    return {
      id: run.id,
      scenario: run.scenario,
      clock: run.clock.iso(),
      authScopeFingerprint: run.authScopeFingerprint,
      requestCount: run.requests.length,
      state: handler.inspectRunState?.(run) ?? {},
    };
  }

  create({ id: defaultRunId, scenario: defaultScenario, authScope: "public", seed: defaultRunId });

  return Object.freeze({
    defaultRunId,
    maximumRuns,
    runTtlMs,
    create,
    get,
    authorize,
    record,
    mutate,
    reset,
    remove,
    snapshot,
    cleanupExpired,
    size: () => runs.size,
    disposalErrors: () => Object.freeze([...disposalErrors]),
    close() {
      if (closed) return Object.freeze([...disposalErrors]);
      closed = true;
      for (const run of [...runs.values()]) disposeRun(run, "registry-closed");
      return Object.freeze([...disposalErrors]);
    },
  });
}
