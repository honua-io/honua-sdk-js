import fs from "node:fs";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  REALTIME_CONFORMANCE_MUTATE_ENV,
  collectLiveRealtimeConformanceEvidence,
  isRealtimeConformanceMutationEnabled,
} from "../scripts/realtime-conformance-evidence.mjs";
import {
  ConformanceRunRefusal,
  createConformanceRunClient,
  readConformanceCapability,
} from "../scripts/realtime-conformance-run-client.mjs";
import * as realtimeSdk from "../src/realtime/index.js";
import {
  CONFORMANCE_DEPLOYMENT_REVISION,
  CONFORMANCE_LAYER_ID,
  CONFORMANCE_RUN_ID_FIELD,
  CONFORMANCE_SERVICE_ID,
  type ConformanceLoopbackOptions,
  type ConformanceLoopbackServer,
  startConformanceLoopbackServer,
} from "./helpers/realtime-conformance-loopback-server.js";
import type { RealtimeCrossTransportCorpusV1 } from "./helpers/realtime-cross-transport-conformance.js";

const GENERATED_AT = "2026-08-04T12:00:00.000Z";
const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
const corpus = JSON.parse(
  fs.readFileSync(new URL("./fixtures/realtime/cross-transport-conformance.v1.json", import.meta.url), "utf8"),
) as RealtimeCrossTransportCorpusV1;
const corpusBytes = Buffer.from(JSON.stringify(corpus));

const ajv = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv);
const validateEvidence = ajv.compile(
  JSON.parse(fs.readFileSync(new URL("../schemas/realtime-conformance-evidence.v1.json", import.meta.url), "utf8")),
);

function expectSchemaValid(document: unknown): void {
  const valid = validateEvidence(document);
  if (!valid) throw new Error(`schema validation failed: ${JSON.stringify(validateEvidence.errors)}`);
  expect(valid).toBe(true);
}

let servers: ConformanceLoopbackServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

async function loopback(options: ConformanceLoopbackOptions = {}): Promise<ConformanceLoopbackServer> {
  const server = await startConformanceLoopbackServer(options);
  servers.push(server);
  return server;
}

function liveOptions(server: ConformanceLoopbackServer, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    mutateEnabled: true,
    generatedAt: GENERATED_AT,
    sourceRevision: SOURCE_REVISION,
    baseUrl: server.baseUrl,
    serverRevision: CONFORMANCE_DEPLOYMENT_REVISION,
    // Loopback observation resolves in milliseconds; this bounds only the
    // lanes that deliberately observe nothing.
    timeoutMs: 750,
    sdk: realtimeSdk,
    corpus,
    corpusBytes,
    env: {},
    webSocketFactory: server.webSocketFactory(),
    ...overrides,
  };
}

function client(server: ConformanceLoopbackServer) {
  return createConformanceRunClient({
    baseUrl: server.baseUrl,
    fetchFn: globalThis.fetch,
    headers: {},
    timeoutMs: 5_000,
  });
}

async function refusalFrom(action: () => Promise<unknown>): Promise<ConformanceRunRefusal> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ConformanceRunRefusal) return error;
    throw error;
  }
  throw new Error("expected a controlled-conformance refusal");
}

describe("controlled-conformance run client", () => {
  it("drives the full lease, insert, per-transport touch, and release lifecycle", async () => {
    const server = await loopback();
    const runClient = client(server);

    const lease = await runClient.open({
      clientLabel: "lifecycle",
      expectedDeploymentRevision: CONFORMANCE_DEPLOYMENT_REVISION,
      expectedServiceId: CONFORMANCE_SERVICE_ID,
    });
    expect(lease).toMatchObject({
      serviceId: CONFORMANCE_SERVICE_ID,
      layerId: CONFORMANCE_LAYER_ID,
      runIdField: CONFORMANCE_RUN_ID_FIELD,
      deploymentRevision: CONFORMANCE_DEPLOYMENT_REVISION,
    });

    const inserted = await runClient.mutate({ operation: "insert", label: "lifecycle" });
    expect(inserted.mutationOrdinal).toBe(1);
    expect(server.controlledRecordCount).toBe(1);

    // One `touch` per transport: the state never changes but each republishes.
    await runClient.mutate({ operation: "touch", objectId: inserted.objectId });
    await runClient.mutate({ operation: "touch", objectId: inserted.objectId });
    expect(runClient.appliedOperations).toEqual(["insert", "touch", "touch"]);

    const cleanup = await runClient.release();
    expect(cleanup).toMatchObject({ deletedRecords: 1, baselineRestored: true, digestVerified: true });
    expect(cleanup.leaseDigest).toBe(cleanup.cleanupDigest);
    expect(server.controlledRecordCount).toBe(0);
  });

  it("verifies the baseline digest reverses and reports residue instead of hiding it", async () => {
    const clean = await loopback();
    const cleanRun = client(clean);
    await cleanRun.open({});
    await cleanRun.mutate({ operation: "insert" });
    expect((await cleanRun.release()).digestVerified).toBe(true);

    const dirty = await loopback({ leaveBaselineResidue: true });
    const dirtyRun = client(dirty);
    const lease = await dirtyRun.open({});
    await dirtyRun.mutate({ operation: "insert" });
    const cleanup = await dirtyRun.release();
    expect(cleanup.digestVerified).toBe(false);
    expect(cleanup.cleanupDigest).not.toBe(lease.baselineDigest);
  });

  it("releases idempotently so a finally block is always safe", async () => {
    const server = await loopback();
    const runClient = client(server);
    await runClient.open({});
    await runClient.mutate({ operation: "insert" });

    const first = await runClient.release();
    const second = await runClient.release();
    expect(second).toBe(first);
    expect(server.requests.filter((entry) => entry.method === "DELETE")).toHaveLength(1);
  });

  it("never exposes the per-run token on the client surface", async () => {
    const server = await loopback();
    const runClient = client(server);
    const lease = await runClient.open({});

    expect(Object.keys(runClient)).not.toContain("runToken");
    expect(JSON.stringify(lease)).not.toMatch(/runToken|run-token-/u);
    expect(JSON.stringify(runClient.lease)).not.toMatch(/run-token-/u);
    // The header is still presented on the wire — the discipline is about what
    // is retained, not about skipping the ownership proof.
    await runClient.mutate({ operation: "insert" });
    const mutation = server.requests.find((entry) => entry.path.endsWith("/mutations"));
    expect(mutation?.headers["x-honua-conformance-run-token"]).toMatch(/^run-token-/u);
    await runClient.release();
  });

  it("reads the credential-free capability block and tells absent apart from disabled", async () => {
    expect(readConformanceCapability({ data: { conformance: { enabled: false } } })).toMatchObject({
      present: true,
      enabled: false,
    });
    expect(readConformanceCapability({ enabled: true, transports: ["sse"] })).toMatchObject({ present: false });
    expect(() => readConformanceCapability({ conformance: { enabled: "yes" } })).toThrow(
      /did not declare a boolean enabled flag/u,
    );
  });
});

describe("controlled-conformance fail-closed matrix", () => {
  it("maps a disabled deployment to a named 403 refusal", async () => {
    const server = await loopback({ conformanceEnabled: false });
    const refusal = await refusalFrom(() => client(server).open({}));
    expect(refusal).toMatchObject({ code: "conformance-disabled", status: 403 });
    expect(refusal.reason).toBe("This deployment provisions no controlled-conformance source.");
  });

  it("maps an unresolvable source and an unbound revision to 503", async () => {
    const noSource = await loopback({ sourceUnavailable: true });
    expect(await refusalFrom(() => client(noSource).open({}))).toMatchObject({
      code: "conformance-source-unavailable",
      status: 503,
      reason: "The configured conformance source is not a writable layer.",
    });

    const noRevision = await loopback({ revisionUnavailable: true });
    expect(await refusalFrom(() => client(noRevision).open({}))).toMatchObject({
      code: "conformance-source-unavailable",
      status: 503,
      reason: "This deployment reports no immutable revision to bind evidence to.",
    });
  });

  it("maps an exhausted lease, a revision mismatch, and an exhausted budget to 409", async () => {
    const server = await loopback({ maxConcurrentRuns: 1, maxMutationsPerRun: 1 });
    const held = client(server);
    await held.open({});
    expect(await refusalFrom(() => client(server).open({}))).toMatchObject({
      code: "conformance-lease-unavailable",
      status: 409,
      reason: "Every controlled-conformance lease is currently held.",
    });

    await held.mutate({ operation: "insert" });
    expect(await refusalFrom(() => held.mutate({ operation: "touch", objectId: 101 }))).toMatchObject({
      code: "conformance-lease-unavailable",
      reason: "This run exhausted its mutation budget.",
    });
    await held.release();

    const mismatched = client(server);
    expect(
      await refusalFrom(() => mismatched.open({ expectedDeploymentRevision: `sha256:${"cd".repeat(32)}` })),
    ).toMatchObject({
      code: "conformance-lease-unavailable",
      reason: "The expected deployment revision does not match this deployment.",
    });
  });

  it("keeps an unknown run and a foreign record indistinguishable at 404", async () => {
    const server = await loopback({ maxConcurrentRuns: 2 });
    const owner = client(server);
    const other = client(server);
    await owner.open({});
    await other.open({});
    const owned = await owner.mutate({ operation: "insert" });

    const foreign = await refusalFrom(() => other.mutate({ operation: "touch", objectId: owned.objectId }));
    expect(foreign).toMatchObject({ code: "conformance-run-not-found", status: 404 });

    // A run that no longer exists answers with the same status and the same
    // code, so the surface cannot be used to confirm that another run's
    // records exist.
    await other.release();
    const unknown = await refusalFrom(() => other.mutate({ operation: "insert" }));
    expect(unknown.code).toBe(foreign.code);
    expect(unknown.status).toBe(foreign.status);

    await owner.release();
  });

  it("tells an absent route apart from an unknown run", async () => {
    const server = await loopback({ leaseRouteAbsent: true });
    expect(await refusalFrom(() => client(server).open({}))).toMatchObject({
      code: "conformance-endpoint-unavailable",
      status: 404,
    });
  });

  it("refuses a malformed mutation request before it reaches the deployment", async () => {
    const server = await loopback();
    const runClient = client(server);
    await runClient.open({});
    expect(await refusalFrom(() => runClient.mutate({ operation: "rename" }))).toMatchObject({
      code: "conformance-request-invalid",
    });
    expect(await refusalFrom(() => runClient.mutate({ operation: "touch" }))).toMatchObject({
      code: "conformance-request-invalid",
    });
    expect(server.requests.some((entry) => entry.path.endsWith("/mutations"))).toBe(false);
    await runClient.release();
  });
});

describe("live realtime evidence with a controlled-conformance run", () => {
  it("executes both advertised transports on one identical driven history", async () => {
    const server = await loopback();
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(server));

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "executed", executed: 2, unsupported: 1 });
    expect(evidence.conformance).toMatchObject({
      status: "executed",
      reason: null,
      serviceId: CONFORMANCE_SERVICE_ID,
      layerId: CONFORMANCE_LAYER_ID,
      deploymentRevision: CONFORMANCE_DEPLOYMENT_REVISION,
      mutations: { insert: 1, touch: 2 },
    });
    expect(evidence.conformance?.baseline).toMatchObject({ digestVerified: true, baselineRestored: true });

    const executed = evidence.transports.filter((transport) => transport.status === "executed");
    expect(executed.map((transport) => transport.id)).toEqual(["sse", "websocket"]);
    // The whole point of `touch`: transports opened sequentially still reduce
    // to one accepted history and one normalized final state.
    expect(new Set(executed.map((transport) => transport.acceptedState?.historySha256)).size).toBe(1);
    expect(new Set(executed.map((transport) => transport.acceptedState?.finalStateSha256)).size).toBe(1);
    expect(executed.every((transport) => transport.acceptedState !== undefined)).toBe(true);
    expect(server.controlledRecordCount).toBe(0);
  });

  it("never retains the run token in the evidence document", async () => {
    const server = await loopback();
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(server));

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/run-token-/u);
    expect(serialized).not.toMatch(/runToken/u);
    expect(serialized).not.toMatch(/x-honua-conformance-run-token/iu);
    expect(evidence.conformance?.runId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("names a geometry-less conformance record instead of failing opaquely", async () => {
    const server = await loopback({ recordsWithoutGeometry: true });
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(server));

    expectSchemaValid(evidence);
    expect(evidence.summary.status).toBe("failed");
    for (const transport of evidence.transports.filter((entry) => entry.advertised)) {
      expect(transport.status).toBe("failed");
      expect(transport.diagnostics[0].code).toBe("conformance-record-geometry-missing");
    }
    // The run is still released: a failed observation must not leave residue.
    expect(server.controlledRecordCount).toBe(0);
  });

  it("fails every executed transport when the baseline digest does not reverse", async () => {
    const server = await loopback({ leaveBaselineResidue: true });
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(server));

    expectSchemaValid(evidence);
    expect(evidence.conformance).toMatchObject({
      status: "failed",
      reason: { code: "conformance-baseline-not-restored" },
    });
    expect(evidence.summary.status).toBe("failed");
    for (const transport of evidence.transports.filter((entry) => entry.advertised)) {
      expect(transport.diagnostics[0].code).toBe("conformance-baseline-not-restored");
    }
  });

  it("skips the controlled run without opting in, and reports why", async () => {
    const server = await loopback();
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(server, { mutateEnabled: false }));

    expectSchemaValid(evidence);
    expect(evidence.conformance).toMatchObject({
      status: "skipped",
      reason: { code: "controlled-mutation-not-opted-in" },
      runId: null,
      mutations: { insert: 0, touch: 0 },
    });
    // Nothing was driven, so no transport may claim an executed contract.
    expect(evidence.summary.executed).toBe(0);
    expect(isRealtimeConformanceMutationEnabled({ [REALTIME_CONFORMANCE_MUTATE_ENV]: "true" })).toBe(true);
    expect(isRealtimeConformanceMutationEnabled({})).toBe(false);
  });

  it("reports a disabled deployment verbatim rather than as a fake pass", async () => {
    const server = await loopback({ conformanceEnabled: false });
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(server));

    expectSchemaValid(evidence);
    expect(evidence.conformance).toMatchObject({
      status: "skipped",
      reason: {
        code: "conformance-disabled",
        message: "The reviewed deployment provisions no controlled-conformance source.",
      },
    });
    expect(evidence.summary.executed).toBe(0);
    expect(evidence.summary.status).not.toBe("executed");
  });

  it("degrades rather than fails when the mutation surface is unavailable", async () => {
    const server = await loopback({ sourceUnavailable: true });
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(server));

    expectSchemaValid(evidence);
    expect(evidence.conformance).toMatchObject({
      status: "degraded",
      reason: {
        code: "conformance-source-unavailable",
        message: "The configured conformance source is not a writable layer.",
      },
    });
    expect(evidence.summary.executed).toBe(0);
  });

  it("refuses to bind evidence to a lease from another deployment revision", async () => {
    const drifted = await loopback({ leaseRevisionDrift: true });
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(drifted));

    expectSchemaValid(evidence);
    expect(evidence.conformance).toMatchObject({
      status: "failed",
      reason: { code: "conformance-revision-unbound" },
    });
    expect(evidence.summary.executed).toBe(0);
    // The lease was taken before the mismatch was detected, so it is released.
    expect(drifted.requests.some((entry) => entry.method === "DELETE")).toBe(true);
  });

  it("keeps a failed passive baseline diagnostic on the baseline scenario", async () => {
    const drifted = await loopback({ leaseRevisionDrift: true });
    const evidence = await collectLiveRealtimeConformanceEvidence(liveOptions(drifted, { baselineOnly: true }));

    expectSchemaValid(evidence);
    expect(evidence.conformance).toMatchObject({
      status: "failed",
      reason: { code: "conformance-revision-unbound" },
    });
    for (const transport of evidence.transports.filter((entry) => entry.advertised)) {
      expect(transport.status).toBe("failed");
      expect(transport.scenarios).toEqual([{ id: "baseline-completion", result: "failed" }]);
      expect(transport.diagnostics[0]?.scenario).toBe("baseline-completion");
    }
  });
});
