import { describe, expect, it, vi } from "vitest";
import type { ConnectCacheStatus, HonuaConnection } from "../src/connect.js";
import type {
  DiscoveryCapabilityDecision,
  DiscoveryEvidenceKind,
  DiscoveryProvenance,
  SourceDiscoveryInspection,
} from "../src/contract/discovery.js";
import type {
  Capability,
  Dataset,
  Protocol,
  Query,
  Result,
  Source,
  SourceDescriptor,
  SourceId,
} from "../src/contract/types.js";
import { HonuaAbortError } from "../src/core/errors.js";
import { createHonuaKernel } from "../src/kernel/index.js";

interface Incident {
  readonly id: number;
  readonly status: string;
}

const FIXTURE_RESULT: Result<Incident> = Object.freeze({
  features: Object.freeze([Object.freeze({ attributes: Object.freeze({ id: 1, status: "open" }) })]),
  exceededTransferLimit: false,
  totalCount: 1,
});

interface ConnectionFixtureOptions {
  readonly endpoint: string;
  readonly protocol: "geoservices-feature-service" | "ogc-features" | "odata";
  readonly connectionId?: string;
  readonly sourceId?: string;
  readonly observedAt?: string;
  readonly validator?: string;
  readonly schemaField?: string;
  readonly capabilities?: readonly ("query" | "queryAggregate")[];
  readonly locator?: Partial<SourceDescriptor["locator"]>;
  readonly provenance?: readonly DiscoveryProvenance[];
  readonly capabilityDecisions?: readonly DiscoveryCapabilityDecision[];
  readonly cacheStatus?: ConnectCacheStatus;
  readonly query?: Source<Incident>["query"];
  readonly queryAll?: Source<Incident>["queryAll"];
}

function fixtureCapabilityDecision(
  capability: "query" | "queryAggregate",
  options: {
    readonly evidenceKind?: DiscoveryEvidenceKind;
    readonly evidenceProvenance?: readonly DiscoveryProvenance[];
  } = {},
): DiscoveryCapabilityDecision {
  return {
    capability,
    effective: true,
    code: "enabled",
    evidence: [
      {
        kind: options.evidenceKind ?? "metadata",
        supported: true,
        provenance: options.evidenceProvenance ?? [],
      },
    ],
    adapterSupported: true,
    positiveEvidence: true,
    policyAllowed: true,
    reason: `${capability} advertised by fixture metadata`,
  };
}

function connectionFixture(options: ConnectionFixtureOptions): {
  readonly connection: HonuaConnection;
  readonly source: Source<Incident>;
} {
  const sourceId = options.sourceId ?? "incidents";
  const capabilities = new Set<Capability>(options.capabilities ?? ["query"]);
  const locator = {
    ...(options.protocol === "geoservices-feature-service"
      ? { url: options.endpoint, serviceId: "public-safety", layerId: 0 }
      : options.protocol === "ogc-features"
        ? { url: options.endpoint, collectionId: sourceId }
        : { url: options.endpoint, entitySet: "Incidents" }),
    ...options.locator,
  };
  const descriptor: SourceDescriptor = {
    id: sourceId,
    protocol: options.protocol,
    locator,
    capabilities,
    schema: {
      primaryKey: "id",
      fields: [
        { name: "id", type: "esriFieldTypeInteger" },
        { name: options.schemaField ?? "status", type: "esriFieldTypeString" },
      ],
    },
  };
  const source = {
    descriptor,
    capabilities,
    query: options.query ?? vi.fn(async () => FIXTURE_RESULT),
    queryAll: options.queryAll ?? vi.fn(async () => FIXTURE_RESULT),
    queryAggregate: vi.fn(async () => FIXTURE_RESULT),
  } as unknown as Source<Incident>;
  const inspection: SourceDiscoveryInspection = {
    descriptor,
    discovery: "metadata",
    provenance: options.provenance ?? [
      {
        source: `${options.endpoint}/metadata`,
        retrievedAt: options.observedAt ?? "2026-07-16T00:00:00.000Z",
        validator: options.validator ?? '"revision-1"',
      },
    ],
    capabilityDecisions:
      options.capabilityDecisions ??
      [...capabilities].map((capability) => fixtureCapabilityDecision(capability as "query" | "queryAggregate")),
    diagnostics: [],
  };
  const dataset = {
    id: options.connectionId ?? options.endpoint,
    sourceDescriptors: [descriptor],
    sourceIds: () => [sourceId],
    source: (id: SourceId) => (id === sourceId ? source : undefined),
  } as unknown as Dataset;
  const connectionId = options.connectionId ?? options.endpoint;
  return {
    source,
    connection: {
      id: connectionId,
      dataset,
      inspection: {
        id: connectionId,
        endpoint: options.endpoint,
        protocol: options.protocol,
        defaultSourceId: sourceId,
        sources: [inspection],
        diagnostics: [],
        cacheIdentity: {
          version: 1,
          endpoint: options.endpoint,
          protocol: options.protocol,
          authorizationScopeDigest: "sha256:fixture",
          key: "fixture",
        },
        cacheStatus: options.cacheStatus ?? "hit",
      },
      source: (id?: SourceId) => {
        if (id !== undefined && id !== sourceId) throw new Error("fixture source mismatch");
        return source;
      },
    } as unknown as HonuaConnection,
  };
}

const PROTOCOL_CASES = [
  {
    protocol: "geoservices-feature-service" as const,
    endpoint: "https://geo.example.test/FeatureServer",
    compiler: "geoservices-rest-query-v1",
  },
  {
    protocol: "ogc-features" as const,
    endpoint: "https://geo.example.test/ogc/features",
    compiler: "ogc-api-features-query-v1",
  },
  {
    protocol: "odata" as const,
    endpoint: "https://geo.example.test/odata",
    compiler: "odata-v4-query-v1",
  },
] satisfies readonly { readonly protocol: Protocol; readonly endpoint: string; readonly compiler: string }[];

describe.each(PROTOCOL_CASES)("connection query facade: $protocol", ({ protocol, endpoint, compiler }) => {
  it("uses one accepted plan contract for direct and explain-then-query execution", async () => {
    const fixture = connectionFixture({ endpoint, protocol });
    const kernel = createHonuaKernel({ connectDelegate: async () => fixture.connection });
    const connection = await kernel.connect<Incident>(
      { url: endpoint, protocol, sourceId: "incidents" },
      {
        authorizationScopeFingerprint: "TENANT-ALPHA-SECRET-SCOPE",
        clientOptions: { apiKey: "RAW-API-KEY-MUST-NOT-LEAK" },
      },
    );
    const request: Query<Incident> = {
      where: "status = 'open'",
      outFields: ["id", "status"],
      pagination: { limit: 25 },
    };

    const plan = await connection.explain(request);
    const planned = await connection.query(plan);
    const direct = await connection.query(request);

    expect(plan.steps[0]).toMatchObject({ engine: "remote", compiled: { compiler } });
    expect(plan.ir.source.sourceVersion).toMatch(/^connection-source:sha256:[0-9a-f]{64}$/);
    expect(plan.ir.source.authorizationScope.join(" ")).not.toContain("TENANT-ALPHA");
    expect(plan.provenance.schema.state).toBe("known");
    expect(plan.provenance.discovery.state).toBe("metadata");
    expect(planned.features).toEqual(direct.features);
    expect(planned.execution.plan.fingerprint).toBe(plan.fingerprint);
    expect(direct.execution.plan.fingerprint).toBe(plan.fingerprint);
    expect(planned.execution.terminal).toEqual({
      state: "completed",
      featureCount: 1,
      exceededTransferLimit: false,
    });
    expect(planned.execution.observation).toMatchObject({
      protocol,
      discovery: "metadata",
      cacheStatus: "hit",
      observedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(Object.isFrozen(planned.execution)).toBe(true);
    const serializedReceipt = JSON.stringify(planned.execution);
    expect(serializedReceipt).not.toContain("TENANT-ALPHA");
    expect(serializedReceipt).not.toContain("RAW-API-KEY");
    expect(serializedReceipt).not.toContain(endpoint);
    expect(fixture.source.query).toHaveBeenCalledTimes(2);

    await kernel.dispose();
  });
});

describe("connection query cache truthfulness", () => {
  it.each(["hit", "refreshed"] as const)(
    "does not turn a discovery metadata cache %s into a query-result reuse claim",
    async (cacheStatus) => {
      const endpoint = `https://cache-${cacheStatus}.example.test/ogc/features`;
      const fixture = connectionFixture({ endpoint, protocol: "ogc-features", cacheStatus });
      const kernel = createHonuaKernel({ connectDelegate: async () => fixture.connection });
      const connection = await kernel.connect<Incident>(endpoint, { protocol: "ogc-features" });

      const plan = await connection.explain({ where: "status = 'open'" });
      const result = await connection.query(plan);

      expect(plan.cache).toMatchObject({
        policy: "bypass",
        action: "bypass",
        freshness: "unknown",
        reason: "policy-bypass",
      });
      expect(result.execution.observation.cacheStatus).toBe(cacheStatus);
      expect(fixture.source.query).toHaveBeenCalledOnce();
      await kernel.dispose();
    },
  );

  it("uses only an explicit query-cache observation for a reuse decision and still reports remote execution truth", async () => {
    const endpoint = "https://explicit-query-cache.example.test/ogc/features";
    const fixture = connectionFixture({ endpoint, protocol: "ogc-features", cacheStatus: "miss" });
    const kernel = createHonuaKernel({ connectDelegate: async () => fixture.connection });
    const connection = await kernel.connect<Incident>(endpoint, { protocol: "ogc-features" });

    const plan = await connection.explain(
      { where: "status = 'open'" },
      { cache: { policy: "prefer-cache", freshness: "fresh" } },
    );
    const result = await connection.query(plan);

    expect(plan.cache).toMatchObject({
      policy: "prefer-cache",
      action: "reuse",
      freshness: "fresh",
      reason: "fresh-entry",
    });
    expect(result.execution.observation.cacheStatus).toBe("miss");
    expect(fixture.source.query).toHaveBeenCalledOnce();
    await kernel.dispose();
  });
});

describe("connection discovery plan identity", () => {
  it("keeps observation time receipt-only so a clock-only metadata refresh accepts the plan", async () => {
    const endpoint = "https://clock-refresh.example.test/ogc/features";
    const first = connectionFixture({
      endpoint,
      protocol: "ogc-features",
      observedAt: "2026-07-16T00:00:00.000Z",
      cacheStatus: "hit",
    });
    const refreshed = connectionFixture({
      endpoint,
      protocol: "ogc-features",
      observedAt: "2026-07-16T01:00:00.000Z",
      cacheStatus: "refreshed",
    });
    const queue = [first.connection, refreshed.connection];
    const kernel = createHonuaKernel({
      connectDelegate: async () => {
        const next = queue.shift();
        if (!next) throw new Error("fixture queue exhausted");
        return next;
      },
    });
    const connection = await kernel.connect<Incident>(endpoint, { protocol: "ogc-features" });
    const request: Query<Incident> = { where: "status = 'open'" };
    const plan = await connection.explain(request);

    await connection.inspect({ refresh: true });
    const refreshedPlan = await connection.explain(request);
    const result = await connection.query(plan);

    expect(refreshedPlan.fingerprint).toBe(plan.fingerprint);
    expect(refreshedPlan.provenance.discovery).toEqual(plan.provenance.discovery);
    expect(result.execution.observation).toMatchObject({
      cacheStatus: "refreshed",
      observedAt: "2026-07-16T01:00:00.000Z",
    });
    expect(first.source.query).not.toHaveBeenCalled();
    expect(refreshed.source.query).toHaveBeenCalledOnce();
    await kernel.dispose();
  });

  it.each([
    {
      change: "validator",
      refreshed: { validator: '"revision-2"' },
    },
    {
      change: "provenance source",
      refreshed: {
        provenance: [
          {
            source: "https://semantic-refresh.example.test/ogc/features/alternate-metadata",
            retrievedAt: "2026-07-16T01:00:00.000Z",
            validator: '"revision-1"',
          },
        ],
      },
    },
    {
      change: "capability evidence",
      refreshed: { capabilityDecisions: [fixtureCapabilityDecision("query", { evidenceKind: "declared" })] },
    },
  ] as const)("rejects an accepted plan after a $change change", async ({ refreshed: refreshedOptions }) => {
    const endpoint = "https://semantic-refresh.example.test/ogc/features";
    const first = connectionFixture({ endpoint, protocol: "ogc-features" });
    const refreshed = connectionFixture({
      endpoint,
      protocol: "ogc-features",
      observedAt: "2026-07-16T01:00:00.000Z",
      ...refreshedOptions,
    });
    const queue = [first.connection, refreshed.connection];
    const kernel = createHonuaKernel({
      connectDelegate: async () => {
        const next = queue.shift();
        if (!next) throw new Error("fixture queue exhausted");
        return next;
      },
    });
    const connection = await kernel.connect<Incident>(endpoint, { protocol: "ogc-features" });
    const plan = await connection.explain({ where: "status = 'open'" });

    await connection.inspect({ refresh: true });

    await expect(connection.query(plan)).rejects.toMatchObject({
      code: "stale-plan",
      reason: "discovery-changed",
    });
    expect(first.source.query).not.toHaveBeenCalled();
    expect(refreshed.source.query).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it.each([
    {
      change: "locator binding",
      first: {},
      refreshed: { locator: { collectionId: "alternate-incidents" } },
    },
    {
      change: "schema",
      first: {},
      refreshed: { schemaField: "state" },
    },
    {
      change: "effective capabilities",
      first: {
        capabilities: ["query", "queryAggregate"],
        capabilityDecisions: [fixtureCapabilityDecision("query"), fixtureCapabilityDecision("queryAggregate")],
      },
      refreshed: {
        capabilities: ["query"],
        capabilityDecisions: [fixtureCapabilityDecision("query"), fixtureCapabilityDecision("queryAggregate")],
      },
    },
  ] as const)("rejects an accepted plan after a same-id descriptor $change change", async ({ first, refreshed }) => {
    const endpoint = "https://descriptor-refresh.example.test/ogc/features";
    const initialFixture = connectionFixture({ endpoint, protocol: "ogc-features", ...first });
    const refreshedFixture = connectionFixture({
      endpoint,
      protocol: "ogc-features",
      observedAt: "2026-07-16T01:00:00.000Z",
      ...refreshed,
    });
    const queue = [initialFixture.connection, refreshedFixture.connection];
    const kernel = createHonuaKernel({
      connectDelegate: async () => {
        const next = queue.shift();
        if (!next) throw new Error("fixture queue exhausted");
        return next;
      },
    });
    const connection = await kernel.connect<Incident>(endpoint, { protocol: "ogc-features" });
    const plan = await connection.explain({ where: "status = 'open'" });

    await connection.inspect({ refresh: true });

    await expect(connection.query(plan)).rejects.toMatchObject({
      code: "foreign-plan",
      reason: "source-identity-changed",
    });
    expect(initialFixture.source.query).not.toHaveBeenCalled();
    expect(refreshedFixture.source.query).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it("canonicalizes ordering and duplicates across provenance, validators, evidence, and decisions", async () => {
    const endpoint = "https://ordered-evidence.example.test/ogc/features";
    const evidenceSourceA = `${endpoint}/evidence/a`;
    const evidenceSourceB = `${endpoint}/evidence/b`;
    const firstEvidence = [
      { source: evidenceSourceB, retrievedAt: "2026-07-16T00:00:00.000Z", validator: '"b"' },
      { source: evidenceSourceA, retrievedAt: "2026-07-16T00:00:00.000Z", validator: '"a"' },
      { source: evidenceSourceB, retrievedAt: "2026-07-16T00:05:00.000Z", validator: '"b"' },
    ];
    const refreshedEvidence = [
      { source: evidenceSourceA, retrievedAt: "2026-07-16T01:00:00.000Z", validator: '"a"' },
      { source: evidenceSourceB, retrievedAt: "2026-07-16T01:00:00.000Z", validator: '"b"' },
    ];
    const firstQueryDecision = fixtureCapabilityDecision("query", { evidenceProvenance: firstEvidence });
    const firstAggregateDecision = fixtureCapabilityDecision("queryAggregate", {
      evidenceProvenance: firstEvidence,
    });
    const refreshedQueryDecision = fixtureCapabilityDecision("query", {
      evidenceProvenance: refreshedEvidence,
    });
    const refreshedAggregateDecision = fixtureCapabilityDecision("queryAggregate", {
      evidenceProvenance: refreshedEvidence,
    });
    const first = connectionFixture({
      endpoint,
      protocol: "ogc-features",
      capabilities: ["query", "queryAggregate"],
      provenance: firstEvidence,
      capabilityDecisions: [firstAggregateDecision, firstQueryDecision, firstAggregateDecision],
    });
    const refreshed = connectionFixture({
      endpoint,
      protocol: "ogc-features",
      capabilities: ["query", "queryAggregate"],
      provenance: refreshedEvidence,
      capabilityDecisions: [refreshedQueryDecision, refreshedAggregateDecision],
      cacheStatus: "refreshed",
    });
    const queue = [first.connection, refreshed.connection];
    const kernel = createHonuaKernel({
      connectDelegate: async () => {
        const next = queue.shift();
        if (!next) throw new Error("fixture queue exhausted");
        return next;
      },
    });
    const connection = await kernel.connect<Incident>(endpoint, { protocol: "ogc-features" });
    const request: Query<Incident> = { where: "status = 'open'" };
    const plan = await connection.explain(request);

    await connection.inspect({ refresh: true });
    const refreshedPlan = await connection.explain(request);

    expect(refreshedPlan.fingerprint).toBe(plan.fingerprint);
    expect(refreshedPlan.provenance.discovery.validator).toEqual(plan.provenance.discovery.validator);
    await expect(connection.query(plan)).resolves.toMatchObject({ format: "features" });
    expect(refreshed.source.query).toHaveBeenCalledOnce();
    await kernel.dispose();
  });

  it("canonicalizes semantically identical capability policy collections", async () => {
    const endpoint = "https://ordered-policy.example.test/ogc/features";
    const first = connectionFixture({ endpoint, protocol: "ogc-features", capabilities: ["query", "queryAggregate"] });
    const second = connectionFixture({ endpoint, protocol: "ogc-features", capabilities: ["query", "queryAggregate"] });
    const firstKernel = createHonuaKernel({
      capabilityPolicy: {
        allow: ["queryAggregate", "query", "query"],
        deny: ["attachments", "queryRelated", "attachments"],
      },
      connectDelegate: async () => first.connection,
    });
    const secondKernel = createHonuaKernel({
      capabilityPolicy: { allow: ["query", "queryAggregate"], deny: ["queryRelated", "attachments"] },
      connectDelegate: async () => second.connection,
    });
    const firstConnection = await firstKernel.connect<Incident>(endpoint, { protocol: "ogc-features" });
    const secondConnection = await secondKernel.connect<Incident>(endpoint, { protocol: "ogc-features" });

    const firstPlan = await firstConnection.explain({ where: "status = 'open'" });
    const secondPlan = await secondConnection.explain({ where: "status = 'open'" });

    expect(secondPlan.provenance.discovery).toEqual(firstPlan.provenance.discovery);
    expect(secondPlan.fingerprint).toBe(firstPlan.fingerprint);
    await Promise.all([firstKernel.dispose(), secondKernel.dispose()]);
  });
});

describe("connection accepted-plan safety", () => {
  it("rejects mutated, foreign, wrong-scope, and refreshed-schema plans without replanning", async () => {
    const first = connectionFixture({
      endpoint: "https://one.example.test/ogc/features",
      protocol: "ogc-features",
      connectionId: "connection-one",
    });
    const refreshed = connectionFixture({
      endpoint: "https://one.example.test/ogc/features",
      protocol: "ogc-features",
      connectionId: "connection-one",
      observedAt: "2026-07-16T01:00:00.000Z",
      validator: '"revision-2"',
      schemaField: "state",
    });
    const foreign = connectionFixture({
      endpoint: "https://two.example.test/ogc/features",
      protocol: "ogc-features",
      connectionId: "connection-two",
    });
    const queue = [first.connection, refreshed.connection];
    const kernel = createHonuaKernel({
      connectDelegate: async () => {
        const next = queue.shift();
        if (!next) throw new Error("fixture queue exhausted");
        return next;
      },
    });
    const connection = await kernel.connect<Incident>("https://one.example.test/ogc/features", {
      protocol: "ogc-features",
      authorizationScopeFingerprint: "scope-a",
    });
    const plan = await connection.explain({ where: "status = 'open'" });
    const mutated = { ...plan, steps: [] } as unknown as typeof plan;

    await expect(connection.query(mutated)).rejects.toMatchObject({ code: "invalid-plan" });
    expect(first.source.query).not.toHaveBeenCalled();

    const foreignKernel = createHonuaKernel({ connectDelegate: async () => foreign.connection });
    const foreignConnection = await foreignKernel.connect<Incident>("https://two.example.test/ogc/features", {
      protocol: "ogc-features",
      authorizationScopeFingerprint: "scope-a",
    });
    await expect(foreignConnection.query(plan)).rejects.toMatchObject({
      code: "foreign-plan",
      reason: "source-identity-changed",
    });
    expect(foreign.source.query).not.toHaveBeenCalled();

    const wrongScopeKernel = createHonuaKernel({ connectDelegate: async () => first.connection });
    const wrongScope = await wrongScopeKernel.connect<Incident>("https://one.example.test/ogc/features", {
      protocol: "ogc-features",
      authorizationScopeFingerprint: "scope-b",
    });
    await expect(wrongScope.query(plan)).rejects.toMatchObject({
      code: "foreign-plan",
      reason: "authorization-scope-changed",
    });
    expect(first.source.query).not.toHaveBeenCalled();

    await connection.inspect({ refresh: true });
    await expect(connection.query(plan)).rejects.toMatchObject({
      code: "foreign-plan",
      reason: "source-identity-changed",
    });
    expect(refreshed.source.query).not.toHaveBeenCalled();

    await Promise.all([kernel.dispose(), foreignKernel.dispose(), wrongScopeKernel.dispose()]);
  });

  it("keeps ambiguous source selection explicit for explain and direct query", async () => {
    const first = connectionFixture({
      endpoint: "https://multi.example.test/ogc/features",
      protocol: "ogc-features",
      sourceId: "incidents",
    });
    const second = connectionFixture({
      endpoint: "https://multi.example.test/ogc/features",
      protocol: "ogc-features",
      sourceId: "roads",
    });
    const inspections = [...first.connection.inspection.sources, ...second.connection.inspection.sources];
    const multi = {
      ...first.connection,
      inspection: {
        ...first.connection.inspection,
        defaultSourceId: undefined,
        sources: inspections,
      },
      source: (id?: SourceId) => {
        if (id === "incidents") return first.source;
        if (id === "roads") return second.source;
        throw new Error("explicit fixture source required");
      },
    } as unknown as HonuaConnection;
    const kernel = createHonuaKernel({ connectDelegate: async () => multi });
    const connection = await kernel.connect<Incident>("https://multi.example.test/ogc/features", {
      protocol: "ogc-features",
    });

    await expect(connection.explain({})).rejects.toMatchObject({ code: "ambiguous-source" });
    await expect(connection.query({})).rejects.toMatchObject({ code: "ambiguous-source" });
    const plan = await connection.explain({}, { sourceId: "roads" });
    await expect(connection.query(plan)).resolves.toMatchObject({ format: "features" });

    await kernel.dispose();
  });
});

describe("connection query cancellation", () => {
  it("propagates caller cancellation into pending queryAll paging", async () => {
    const started = vi.fn();
    const fixture = connectionFixture({
      endpoint: "https://cancel.example.test/ogc/features",
      protocol: "ogc-features",
      queryAll: (request) =>
        new Promise<Result<Incident>>((resolve, reject) => {
          void resolve;
          started(request?.signal);
          request?.signal?.addEventListener("abort", () => reject(new Error("adapter cancelled")), { once: true });
        }),
    });
    const kernel = createHonuaKernel({ connectDelegate: async () => fixture.connection });
    const connection = await kernel.connect<Incident>("https://cancel.example.test/ogc/features", {
      protocol: "ogc-features",
    });
    const controller = new AbortController();

    const pending = connection.query(
      { aggregation: { metrics: [{ fn: "count", field: "id" }] } },
      {
        signal: controller.signal,
        capabilityPolicy: "degraded",
        fallback: { mode: "bounded-local", maxRows: 10 },
      },
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const delegatedSignal = started.mock.calls[0]?.[0] as AbortSignal;
    expect(delegatedSignal).not.toBe(controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(delegatedSignal.aborted).toBe(true);
    await kernel.dispose();
  });

  it("checks cancellation at the bounded local fallback boundary", async () => {
    const controller = new AbortController();
    const queryAll = vi.fn(async (request?: Query<Incident>) => {
      expect(request?.signal?.aborted).toBe(false);
      controller.abort();
      return FIXTURE_RESULT;
    });
    const fixture = connectionFixture({
      endpoint: "https://cancel.example.test/ogc/features",
      protocol: "ogc-features",
      queryAll,
    });
    const kernel = createHonuaKernel({ connectDelegate: async () => fixture.connection });
    const connection = await kernel.connect<Incident>("https://cancel.example.test/ogc/features", {
      protocol: "ogc-features",
    });

    await expect(
      connection.query(
        { aggregation: { metrics: [{ fn: "count", field: "id" }] } },
        {
          signal: controller.signal,
          capabilityPolicy: "degraded",
          fallback: { mode: "bounded-local", maxRows: 10 },
        },
      ),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(queryAll).toHaveBeenCalledOnce();
    await kernel.dispose();
  });
});
