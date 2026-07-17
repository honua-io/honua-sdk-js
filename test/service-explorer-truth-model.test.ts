import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  type ServiceExplorerTerminalState,
  createServiceExplorerTruthModel,
} from "../examples/service-explorer/src/truth-model.js";
import type {
  Capability,
  Dataset,
  DiscoveryCapabilityDecision,
  DiscoveryDiagnostic,
  Protocol,
  Source,
  SourceDescriptor,
  SourceDiscoveryInspection,
} from "../src/contract/index.js";
import type {
  ConnectLocator,
  ConnectionInspection,
  HonuaKernel,
  HonuaKernelConnectOptions,
  HonuaKernelConnection,
} from "../src/index.js";
import { HonuaAbortError, HonuaAuthError, HonuaDiscoveryError, createHonua } from "../src/index.js";
import type { CapabilityProfile } from "../src/source-capability-types.js";
import {
  SERVICE_EXPLORER_PUBLIC_FIXTURES,
  type ServiceExplorerPublicFixture,
  createServiceExplorerRawFixtureFetch,
} from "./service-explorer-public-fixtures.js";

const ENDPOINT = "https://fixtures.example.test/services/root";
const SHA256 = `sha256:${"0".repeat(64)}` as const;

interface SyntheticBoundaryProfile {
  readonly id: string;
  readonly protocol: Protocol;
  readonly schema: "available" | "unavailable";
  readonly query: boolean;
  readonly render: boolean;
  readonly pagination: readonly ("offset" | "cursor" | "next-link")[];
}

const FEATURE_BOUNDARY_PROFILE: SyntheticBoundaryProfile = Object.freeze({
  id: "geoservices-feature",
  protocol: "geoservices-feature-service",
  schema: "available",
  query: true,
  render: false,
  pagination: Object.freeze(["offset"] as const),
});

const OGC_BOUNDARY_PROFILE: SyntheticBoundaryProfile = Object.freeze({
  id: "ogc-features",
  protocol: "ogc-features",
  schema: "unavailable",
  query: true,
  render: false,
  pagination: Object.freeze(["next-link"] as const),
});

describe("Service Explorer capability-truth model", () => {
  it("depends on the public kernel and contract surfaces only", async () => {
    const source = await readFile("examples/service-explorer/src/truth-model.ts", "utf8");
    expect(source).toContain('from "@honua/sdk-js"');
    expect(source).toContain("createHonua(");
    expect(source).toContain('from "@honua/sdk-js/contract"');
    expect(source).not.toMatch(/@honua\/sdk-js\/(?:app|app-workspace|app-controller|esri-compat)/);
  });

  it("owns and idempotently disposes its default public createHonua kernel", async () => {
    const model = createServiceExplorerTruthModel();
    const disposal = model.dispose();
    expect(model.dispose()).toBe(disposal);
    await disposal;
    expect(() => model.subscribe(() => undefined)).toThrow("disposed");
  });

  it("rejects malformed URLs and selectors before invoking the kernel", async () => {
    const fake = fakeKernel(async () => {
      throw new Error("Kernel must not run for invalid explorer input.");
    });
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });
    const invalidInputs = [
      { url: "/relative" },
      { url: "ftp://fixtures.example.test/data" },
      { url: "https://user:password@fixtures.example.test/data" },
      { url: "https://fixtures.example.test/line\nbreak" },
      { url: `${ENDPOINT}?z=2` },
      { url: `${ENDPOINT}?token=TOP-SECRET` },
      { url: `${ENDPOINT}#private` },
      { url: `https://fixtures.example.test/${"x".repeat(4_096)}` },
      { url: ENDPOINT, protocol: "made-up" },
      { url: ENDPOINT, sourceId: "" },
      { url: ENDPOINT, sourceId: "roads\u0000private" },
      { url: ENDPOINT, collectionId: " spaced " },
    ] as unknown as Parameters<typeof model.inspect>[0][];

    for (const input of invalidInputs) await expect(model.inspect(input)).resolves.toMatchObject({ kind: "error" });
    expect(fake.connect).not.toHaveBeenCalled();

    await expect(
      model.inspect({ url: `${ENDPOINT}/?format=pjson&f=json`, protocol: "ogc-features" }),
    ).resolves.toMatchObject({ kind: "error" });
    expect(fake.connect.mock.calls[0]?.[0]).toMatchObject({ url: ENDPOINT });
    expect(JSON.stringify(fake.connect.mock.calls[0]?.[0])).not.toContain("TOP-SECRET");
    await model.dispose();
  });

  it("rejects the same identity-bearing URL boundary as the real public kernel before network access", async () => {
    const endpoint = `${ENDPOINT}?z=2`;
    const kernel = createHonua();
    await expect(kernel.connect({ url: endpoint, protocol: "ogc-features" })).rejects.toMatchObject({
      code: "invalid-endpoint",
    });
    await kernel.dispose();

    const model = createServiceExplorerTruthModel();
    await expect(model.inspect({ url: endpoint, protocol: "ogc-features" })).resolves.toMatchObject({
      kind: "error",
      failure: { code: "input.identity-bearing-endpoint" },
    });
    await model.dispose();
  });

  it.each(SERVICE_EXPLORER_PUBLIC_FIXTURES)(
    "traverses raw $protocol metadata through createHonua connect, inspect, and source",
    async (profile: ServiceExplorerPublicFixture) => {
      const raw = createServiceExplorerRawFixtureFetch(profile.id);
      const model = createServiceExplorerTruthModel();

      const state = await model.inspect(
        { url: profile.endpoint, protocol: profile.protocol, sourceId: profile.sourceId },
        {
          authorizationScopeFingerprint: `sha256:${"a".repeat(64)}`,
          authorizationScopeLabel: "tenant:alpha/readers",
          clientOptions: { fetchFn: raw.fetchFn },
        },
      );

      const terminalKind = profile.terminalKind ?? "ready";
      expect(state.kind).toBe(terminalKind);
      if (state.kind !== "ready" && state.kind !== "partial") {
        throw new Error(
          `Expected inspectable ${profile.id} fixture state: ${JSON.stringify({ state, requests: raw.requests })}`,
        );
      }
      expect(state.inspection.service).toMatchObject({
        endpoint: profile.endpoint,
        protocol: profile.protocol,
        protocolHint: profile.protocol,
        detection: {
          requestedProtocolHint: profile.protocol,
          resolvedProtocol: profile.protocol,
          confidence: "not-reported",
        },
        evidenceStates: ["metadata"],
        cache: { status: "miss", scope: "discovery-metadata", featureData: "not-loaded" },
        authorization: { mode: "scoped", scopeIdentity: "tenant:alpha/readers", credentialsRetained: false },
      });
      expect(state.inspection.dataset).toMatchObject({
        sourceCount: profile.sourceCount,
        visibleSourceCount: profile.sourceCount,
        selectedSourceId: profile.sourceId,
        selectionRequired: false,
      });
      const projected = state.inspection.sources.find((source) => source.id === profile.sourceId);
      expect({
        ...projected,
        locator: projected ? { ...projected.locator, url: projected.locator.url.replace(/\/$/, "") } : undefined,
      }).toMatchObject({
        id: profile.sourceId,
        protocol: profile.protocol,
        discovery: "metadata",
        schema: { state: profile.schema },
        truncated: false,
        locator: profile.locator,
      });
      expect(projected?.capabilityProfile).toBeUndefined();
      for (const capability of profile.requiredCapabilities) {
        expect(projected?.effectiveCapabilities, `${profile.id} must expose ${capability}`).toContain(capability);
      }
      for (const capability of profile.forbiddenCapabilities) {
        expect(projected?.effectiveCapabilities, `${profile.id} must not expose ${capability}`).not.toContain(
          capability,
        );
      }

      const connection = model.connection();
      if (!connection) throw new Error(`${profile.id} did not retain its public kernel connection.`);
      const publicInspection = await connection.inspect();
      expect(publicInspection.sources.map((source) => source.descriptor.id)).toHaveLength(profile.sourceCount);
      const publicSource = connection.source(profile.sourceId);
      expect(publicSource.descriptor).toMatchObject({
        id: profile.sourceId,
        protocol: profile.protocol,
        locator: profile.locator,
      });
      expect([...publicSource.capabilities].sort()).toEqual(projected?.effectiveCapabilities);
      expect(publicSource.descriptor.capabilityProfile).toBeUndefined();

      expect(raw.requests).toHaveLength(profile.requestCount);
      expect(raw.requests.every((request) => request.method === "GET")).toBe(true);
      expect(Object.isFrozen(state.inspection)).toBe(true);
      expect(Object.isFrozen(projected?.capabilityDecisions)).toBe(true);

      await model.dispose();
    },
  );

  it("classifies ambiguous, partial, and source-less inspections explicitly", async () => {
    const roads = sourceInspection(OGC_BOUNDARY_PROFILE, "roads");
    const parcels = sourceInspection(OGC_BOUNDARY_PROFILE, "parcels");
    const warning: DiscoveryDiagnostic = {
      code: "partial-discovery",
      severity: "warning",
      message: "Conformance metadata was incomplete.",
      capabilities: ["query"],
    };
    const connections = [
      fixtureConnection({ protocol: "ogc-features", sources: [roads, parcels] }),
      fixtureConnection({
        protocol: "ogc-features",
        sources: [{ ...roads, diagnostics: [warning] }],
        defaultSourceId: roads.descriptor.id,
      }),
      fixtureConnection({ protocol: "ogc-features", sources: [] }),
    ];
    const queue = [...connections];
    const fake = fakeKernel(async () => {
      const next = queue.shift();
      if (!next) throw new Error("Fixture queue exhausted");
      return next.connection;
    });
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });

    const ambiguous = await model.inspect({ url: ENDPOINT, protocol: "ogc-features" });
    expect(ambiguous).toMatchObject({
      kind: "ambiguous",
      failure: { code: "discovery.ambiguous-source" },
      inspection: { dataset: { selectionRequired: true, sourceCount: 2 } },
    });

    const partial = await model.inspect({ url: ENDPOINT, protocol: "ogc-features", sourceId: "roads" });
    expect(partial).toMatchObject({
      kind: "partial",
      inspection: {
        diagnostics: [expect.objectContaining({ code: "partial-discovery", sourceId: "roads" })],
      },
    });

    const unsupported = await model.inspect({ url: ENDPOINT, protocol: "ogc-features" });
    expect(unsupported).toMatchObject({
      kind: "unsupported",
      failure: { code: "discovery.no-sources" },
      inspection: { dataset: { sourceCount: 0 } },
    });

    await model.dispose();
    for (const connection of connections) expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps auth, unsupported, ambiguous, and opaque failures without echoing exception detail", async () => {
    const failures: readonly {
      readonly error: Error;
      readonly kind: ServiceExplorerTerminalState["kind"];
      readonly code: string;
    }[] = [
      {
        error: new HonuaAuthError("interaction_required", "Bearer TOP-SECRET requires sign-in"),
        kind: "auth",
        code: "core.auth.interaction-required",
      },
      {
        error: new HonuaDiscoveryError("unsupported-protocol", "TOP-SECRET unsupported"),
        kind: "unsupported",
        code: "discovery.unsupported-protocol",
      },
      {
        error: new HonuaDiscoveryError("ambiguous-protocol", "TOP-SECRET ambiguous"),
        kind: "ambiguous",
        code: "discovery.ambiguous-protocol",
      },
      { error: new Error("TOP-SECRET internal failure"), kind: "error", code: "service-explorer.inspect-failed" },
    ];

    for (const expected of failures) {
      const fake = fakeKernel(async () => {
        throw expected.error;
      });
      const model = createServiceExplorerTruthModel({ honua: fake.kernel });
      const state = await model.inspect({ url: ENDPOINT, protocol: "ogc-features" });
      expect(state).toMatchObject({ kind: expected.kind, failure: { code: expected.code } });
      expect(JSON.stringify(state)).not.toContain("TOP-SECRET");
      await model.dispose();
    }
  });

  it("bounds hostile renderer input and oversized discovery collections", async () => {
    const base = sourceInspection(FEATURE_BOUNDARY_PROFILE);
    const fields = Array.from({ length: 300 }, (_, index) => ({
      name: `field-${index}`,
      type: "esriFieldTypeString" as const,
    }));
    const sources = Array.from(
      { length: 300 },
      (_, index): SourceDiscoveryInspection => ({
        ...base,
        descriptor: {
          ...base.descriptor,
          id: `source-${index}`,
          locator: { ...base.descriptor.locator, url: `${ENDPOINT}?token=TOP-SECRET` },
          schema: { fields },
        },
        provenance: [{ source: `${ENDPOINT}?signature=TOP-SECRET` }],
      }),
    );
    const diagnostics = Array.from(
      { length: 600 },
      (_, index): DiscoveryDiagnostic => ({
        code: "partial-discovery",
        severity: "warning",
        message: index === 0 ? "Bearer TOP-SECRET token=TOP-SECRET" : `diagnostic-${index}`,
        capabilities: ["query"],
      }),
    );
    const managed = fixtureConnection({
      protocol: "geoservices-feature-service",
      sources,
      defaultSourceId: "source-0",
      diagnostics,
    });
    const fake = fakeKernel(async () => managed.connection);
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });

    const accessorInput = Object.defineProperty({}, "url", {
      enumerable: true,
      get: () => {
        throw new Error("TOP-SECRET getter");
      },
    }) as { url: string };
    const rejected = await model.inspect(accessorInput);
    expect(rejected).toMatchObject({ kind: "error", failure: { code: "input.invalid-shape" } });
    expect(fake.connect).not.toHaveBeenCalled();

    const state = await model.inspect(
      { url: `${ENDPOINT}?f=json`, protocol: "geoservices-feature-service" },
      { authorizationScopeFingerprint: "Bearer TOP-SECRET" },
    );
    expect(state.kind).toBe("partial");
    if (state.kind !== "partial") throw new Error(`Expected partial bounded state, received ${state.kind}`);
    expect(state.request).toMatchObject({
      endpoint: ENDPOINT,
      authorization: { mode: "scoped", scopeIdentity: "[configured]", credentialsRetained: false },
    });
    expect(state.inspection.dataset).toMatchObject({ sourceCount: 300, visibleSourceCount: 256 });
    expect(state.inspection.sources).toHaveLength(256);
    expect(state.inspection.sources[0]).toMatchObject({
      locator: { url: ENDPOINT },
      schema: { fieldCount: 300, fields: expect.any(Array), truncated: true },
      provenance: [{ source: ENDPOINT }],
      truncated: true,
    });
    expect(state.inspection.sources[0]?.schema.fields).toHaveLength(256);
    expect(state.inspection.diagnostics).toHaveLength(512);
    expect(state.inspection.diagnostics.at(-1)?.code).toBe("explorer.diagnostic-limit");
    expect(state.inspection.truncated).toBe(true);
    expect(JSON.stringify(state)).not.toContain("TOP-SECRET");

    await model.dispose();
  });

  it("keeps opaque authorization fingerprints transport-only", async () => {
    const source = sourceInspection(OGC_BOUNDARY_PROFILE);
    const managed = fixtureConnection({
      protocol: "ogc-features",
      sources: [source],
      defaultSourceId: source.descriptor.id,
    });
    const fake = fakeKernel(async () => managed.connection);
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });

    const opaque = await model.inspect(
      { url: ENDPOINT, protocol: "ogc-features" },
      { authorizationScopeFingerprint: "short-api-key" },
    );
    expect(opaque.request.authorization).toEqual({
      mode: "scoped",
      scopeIdentity: "[configured]",
      credentialsRetained: false,
    });
    expect(JSON.stringify(opaque)).not.toContain("short-api-key");
    expect(fake.connect.mock.calls[0]?.[1]).toMatchObject({ authorizationScopeFingerprint: "short-api-key" });

    await model.dispose();
  });

  it("uses the kernel-validated requested source without scanning beyond the source projection budget", async () => {
    const base = sourceInspection(OGC_BOUNDARY_PROFILE);
    const sources = Array.from(
      { length: 257 },
      (_, index): SourceDiscoveryInspection => ({
        ...base,
        descriptor: { ...base.descriptor, id: `source-${index}` },
      }),
    );
    const managed = fixtureConnection({
      protocol: "ogc-features",
      sources,
      defaultSourceId: "source-0",
    });
    const fake = fakeKernel(async () => managed.connection);
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });

    const state = await model.inspect({
      url: ENDPOINT,
      protocol: "ogc-features",
      sourceId: "source-256",
    });

    expect(state.kind).toBe("partial");
    if (state.kind !== "partial") throw new Error(`Expected partial bounded state, received ${state.kind}`);
    expect(state.inspection.dataset).toMatchObject({
      sourceCount: 257,
      visibleSourceCount: 256,
      selectedSourceId: "source-256",
      selectedSourceVisible: false,
      selectionRequired: false,
    });
    expect(state.inspection.dataset.sourceIds).not.toContain("source-256");

    await model.dispose();
  });

  it("does not accept a dangling inspected default source", async () => {
    const roads = sourceInspection(OGC_BOUNDARY_PROFILE, "roads");
    const parcels = sourceInspection(OGC_BOUNDARY_PROFILE, "parcels");
    const managed = fixtureConnection({
      protocol: "ogc-features",
      sources: [roads, parcels],
      defaultSourceId: "missing",
    });
    const fake = fakeKernel(async () => managed.connection);
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });

    const state = await model.inspect({ url: ENDPOINT, protocol: "ogc-features", sourceId: "missing" });

    expect(state).toMatchObject({
      kind: "ambiguous",
      inspection: {
        dataset: { selectionRequired: true },
        diagnostics: [expect.objectContaining({ code: "explorer.invalid-default-source" })],
      },
    });
    if (state.kind === "ambiguous") expect(state.inspection?.dataset.selectedSourceId).toBeUndefined();

    await model.dispose();
  });

  it("makes every nested projection bound visible and redacts common credential families", async () => {
    const profile = FEATURE_BOUNDARY_PROFILE;
    const base = sourceInspection(profile);
    const descriptor = base.descriptor;
    const capabilityProfile = descriptor.capabilityProfile as CapabilityProfile;
    const firstEntry = capabilityProfile.entries[0] as CapabilityProfile["entries"][number];
    const source: SourceDiscoveryInspection = {
      ...base,
      descriptor: {
        ...descriptor,
        capabilityProfile: {
          ...capabilityProfile,
          entries: [
            {
              ...firstEntry,
              evidence: Array.from({ length: 20 }, (_, index) => ({
                kind: "conformance" as const,
                truth: "supported" as const,
                reference:
                  index === 0
                    ? "https://fixtures.example.test/conformance?token=private"
                    : `conformance:fixture-${index}`,
                observedAt: "2026-07-16T00:00:00.000Z",
                expiresAt: "2026-07-16T00:05:00.000Z",
              })),
              reasons: Array.from({ length: 20 }, () => "unsupported-by-observation" as const),
              authorizationScopes: Array.from({ length: 40 }, (_, index) => `tenant:alpha/scope-${index}`),
              constraints: {
                pagination: {
                  modes: Array.from({ length: 20 }, () => "offset" as const),
                  maxPageSize: 1000,
                },
              },
            },
          ],
        },
      },
      metadata: {
        crs: ["EPSG:4326"],
        extent: {
          spatial: { bbox: [[-158, 21, -157, 22, 0, 1, 2]] },
          temporal: { interval: [["2026-01-01T00:00:00.000Z", null, "ignored"]] },
        },
      },
      diagnostics: [
        {
          code: "partial-discovery",
          severity: "warning",
          message:
            "Basic Zml4dHVyZS1jcmVkZW50aWFs AKIA1234567890ABCDEF token: private ghp_1234567890 eyJ12345678.abcdefgh.ijklmnop",
          capabilities: Array.from({ length: 40 }, () => "query" as const),
        },
      ],
    };
    const managed = fixtureConnection({
      protocol: profile.protocol,
      sources: [source],
      defaultSourceId: source.descriptor.id,
    });
    const fake = fakeKernel(async () => managed.connection);
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });

    const state = await model.inspect({ url: ENDPOINT, protocol: profile.protocol });

    expect(state.kind).toBe("partial");
    if (state.kind !== "partial") throw new Error(`Expected partial bounded state, received ${state.kind}`);
    const projected = state.inspection.sources[0];
    expect(projected).toMatchObject({
      truncated: true,
      extent: { truncated: true },
      capabilityProfile: {
        truncated: true,
        entries: [
          expect.objectContaining({
            reasonsTruncated: true,
            evidenceTruncated: true,
            authorizationScopesTruncated: true,
            pagination: expect.objectContaining({ modesTruncated: true }),
          }),
        ],
      },
    });
    expect(projected?.capabilityProfile?.entries[0]?.reasons).toHaveLength(16);
    expect(projected?.capabilityProfile?.entries[0]?.evidence).toHaveLength(16);
    expect(projected?.capabilityProfile?.entries[0]?.evidence[0]?.reference).toBe(
      "https://fixtures.example.test/conformance",
    );
    expect(projected?.capabilityProfile?.entries[0]?.authorizationScopes).toHaveLength(32);
    expect(projected?.capabilityProfile?.entries[0]?.pagination?.modes).toHaveLength(16);
    expect(state.inspection.diagnostics[0]).toMatchObject({
      capabilitiesTruncated: true,
      capabilities: expect.any(Array),
    });
    expect(state.inspection.diagnostics[0]?.capabilities).toHaveLength(32);
    expect(JSON.stringify(state)).not.toMatch(/Zml4dHVyZS|AKIA1234567890ABCDEF|private|ghp_1234567890|eyJ12345678/);

    await model.dispose();
  });

  it("prevents a superseded inspection from replacing newer truth and disposes its stale handle", async () => {
    const first = fixtureConnection({
      protocol: "ogc-features",
      sources: [sourceInspection(OGC_BOUNDARY_PROFILE, "first")],
      defaultSourceId: "first",
    });
    const second = fixtureConnection({
      protocol: "ogc-features",
      sources: [sourceInspection(OGC_BOUNDARY_PROFILE, "second")],
      defaultSourceId: "second",
    });
    const firstInspection = await first.connection.inspect();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const staleConnection: HonuaKernelConnection = {
      ...first.connection,
      inspect: vi.fn(async () => {
        await firstGate;
        return firstInspection;
      }),
    };
    const queue = [staleConnection, second.connection];
    const fake = fakeKernel(async () => {
      const connection = queue.shift();
      if (!connection) throw new Error("Fixture queue exhausted");
      return connection;
    });
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });

    const stale = model.inspect({ url: ENDPOINT, protocol: "ogc-features", sourceId: "first" });
    await vi.waitFor(() => expect(staleConnection.inspect).toHaveBeenCalledTimes(1));
    const latest = await model.inspect({ url: ENDPOINT, protocol: "ogc-features", sourceId: "second" });
    releaseFirst();

    await expect(stale).resolves.toMatchObject({ kind: "cancelled" });
    expect(latest).toMatchObject({
      kind: "ready",
      inspection: { dataset: { selectedSourceId: "second" } },
    });
    expect(model.state).toBe(latest);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(model.connection()).toBe(second.connection);

    await model.dispose();
  });

  it("publishes disposal before invoking managed connection cleanup", async () => {
    const managed = fixtureConnection({
      protocol: "ogc-features",
      sources: [sourceInspection(OGC_BOUNDARY_PROFILE)],
      defaultSourceId: "ogc-features",
    });
    const dispose = vi.fn(() => {
      expect(() => model.connection()).toThrow("disposed");
      return Promise.resolve();
    });
    const connection: HonuaKernelConnection = { ...managed.connection, dispose, [Symbol.asyncDispose]: dispose };
    const fake = fakeKernel(async () => connection);
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });
    await model.inspect({ url: ENDPOINT, protocol: "ogc-features" });

    const completion = model.dispose();
    expect(model.dispose()).toBe(completion);
    await completion;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("cancels in-flight discovery, isolates listener failures, and clears the active handle", async () => {
    const fake = fakeKernel(
      async (_locator, options) =>
        new Promise<HonuaKernelConnection>((_resolve, reject) => {
          const abort = () => reject(options?.signal?.reason ?? new Error("aborted"));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });
    const states: string[] = [];
    model.subscribe(() => {
      throw new Error("presentation failure");
    });
    model.subscribe((state) => states.push(state.kind));

    const pending = model.inspect({ url: ENDPOINT, protocol: "ogc-features" });
    await Promise.resolve();
    expect(model.state.kind).toBe("loading");
    model.cancel();

    await expect(pending).resolves.toMatchObject({ kind: "cancelled", failure: { code: "core.cancelled" } });
    expect(model.state.kind).toBe("cancelled");
    expect(model.connection()).toBeUndefined();
    expect(states).toEqual(["idle", "loading", "cancelled"]);
    await model.dispose();
  });

  it("maps a caller deadline signal to explicit cancelled truth", async () => {
    const fake = fakeKernel(
      async (_locator, options) =>
        new Promise<HonuaKernelConnection>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new HonuaAbortError()), { once: true });
        }),
    );
    const model = createServiceExplorerTruthModel({ honua: fake.kernel });

    await expect(
      model.inspect({ url: ENDPOINT, protocol: "ogc-features" }, { signal: AbortSignal.timeout(10) }),
    ).resolves.toMatchObject({ kind: "cancelled", failure: { code: "core.cancelled" } });
    expect(model.state.kind).toBe("cancelled");

    await model.dispose();
  });
});

function sourceInspection(
  profile: SyntheticBoundaryProfile,
  id = profile.id,
  overrides: Partial<SourceDiscoveryInspection> = {},
): SourceDiscoveryInspection {
  const decisions = [capabilityDecision("query", profile.query), capabilityDecision("render", profile.render)];
  const effective = decisions.filter((decision) => decision.effective).map((decision) => decision.capability);
  const descriptor: SourceDescriptor = {
    id,
    protocol: profile.protocol,
    locator: { url: `${ENDPOINT}?access_token=never-retained`, collectionId: id },
    capabilities: new Set(effective),
    ...(profile.schema === "available"
      ? {
          schema: {
            primaryKey: "id",
            fields: [
              { name: "id", alias: "Identifier", type: "esriFieldTypeOID", nullable: false, editable: false },
              { name: "name", type: "esriFieldTypeString", length: 128, nullable: true, editable: true },
            ],
          },
          schemaV2: { kind: "honua.source-schema", version: "2.0", fingerprint: SHA256 },
        }
      : {}),
    capabilityProfile: capabilityProfile(profile),
    attribution: "Fixture data",
  };
  return {
    descriptor,
    metadata: {
      crs: ["EPSG:4326", "OGC:CRS84"],
      extent: {
        spatial: { bbox: [[-158, 21, -157, 22]], crs: "OGC:CRS84" },
        temporal: { interval: [["2026-01-01T00:00:00.000Z", null]], trs: "Gregorian" },
      },
    },
    discovery: "metadata",
    provenance: [{ source: `${ENDPOINT}?access_token=never-retained`, retrievedAt: "2026-07-16T00:00:00.000Z" }],
    capabilityDecisions: decisions,
    diagnostics: [],
    ...overrides,
  };
}

function capabilityDecision(capability: Capability, effective: boolean): DiscoveryCapabilityDecision {
  return {
    capability,
    effective,
    code: effective ? "enabled" : "adapter-unsupported",
    evidence: [
      {
        kind: "metadata",
        supported: effective,
        reason: effective ? "Advertised by fixture metadata." : "Not available on this source profile.",
        provenance: [],
      },
    ],
    adapterSupported: effective,
    positiveEvidence: effective,
    policyAllowed: true,
    reason: effective ? "Supported by adapter and endpoint evidence." : "Not supported by this adapter.",
  };
}

function capabilityProfile(profile: SyntheticBoundaryProfile): CapabilityProfile {
  return {
    kind: "honua.capabilities",
    version: "1.0",
    fingerprint: SHA256,
    evidenceFingerprint: SHA256,
    sourceFingerprint: SHA256,
    sourceEndpointFingerprint: SHA256,
    evaluatedAt: "2026-07-16T00:00:00.000Z",
    validUntil: "2026-07-16T00:05:00.000Z",
    context: {
      availablePeers: [],
      authorization: { grantedScopes: [], deniedScopes: [] },
    },
    entries: [
      capabilityProfileEntry("query", profile.query, profile.pagination, profileEvidenceKind(profile)),
      capabilityProfileEntry("render", profile.render, [], profileEvidenceKind(profile)),
    ],
  };
}

function profileEvidenceKind(profile: SyntheticBoundaryProfile): "metadata" | "conformance" {
  return profile.protocol === "ogc-features" ||
    profile.protocol === "ogc-tiles" ||
    profile.protocol === "ogc-maps" ||
    profile.protocol === "wfs" ||
    profile.protocol === "wms" ||
    profile.protocol === "wmts" ||
    profile.protocol === "stac"
    ? "conformance"
    : "metadata";
}

function capabilityProfileEntry(
  id: "query" | "render",
  supported: boolean,
  pagination: SyntheticBoundaryProfile["pagination"],
  evidenceKind: "metadata" | "conformance",
): CapabilityProfile["entries"][number] {
  return {
    id,
    claimed: supported ? "supported" : "unsupported",
    observed: supported ? "supported" : "unsupported",
    effective: supported ? "supported" : "unsupported",
    evidence: [
      {
        kind: evidenceKind,
        truth: supported ? "supported" : "unsupported",
        reference: `${evidenceKind}:fixture-${id}`,
        observedAt: "2026-07-16T00:00:00.000Z",
        expiresAt: "2026-07-16T00:05:00.000Z",
      },
    ],
    reasons: [supported ? "supported-by-claim-and-observation" : "unsupported-by-claim"],
    ...(pagination.length > 0 ? { constraints: { pagination: { modes: pagination, maxPageSize: 1000 } } } : {}),
  };
}

function fixtureConnection(options: {
  readonly protocol: Protocol;
  readonly sources: readonly SourceDiscoveryInspection[];
  readonly defaultSourceId?: string;
  readonly diagnostics?: readonly DiscoveryDiagnostic[];
}): {
  readonly connection: HonuaKernelConnection;
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  const inspection: ConnectionInspection = {
    id: `fixture-${options.protocol}`,
    endpoint: ENDPOINT,
    protocol: options.protocol as ConnectionInspection["protocol"],
    ...(options.defaultSourceId ? { defaultSourceId: options.defaultSourceId } : {}),
    sources: options.sources,
    diagnostics: options.diagnostics ?? [],
    cacheStatus: "miss",
  };
  const dispose = vi.fn(async () => undefined);
  const sourceDescriptors = options.sources.map((source) => source.descriptor);
  const dataset = { id: `dataset-${options.protocol}` } as Dataset;
  const connection = {
    id: inspection.id,
    dataset,
    sourceDescriptors,
    inspect: vi.fn(async () => inspection),
    source: vi.fn((_id?: string) => {
      throw new Error("Fixture source execution is outside S1.");
    }) as unknown as <T = Record<string, unknown>>(id?: string) => Source<T>,
    dispose,
    [Symbol.asyncDispose]: dispose,
  } satisfies HonuaKernelConnection;
  return { connection, dispose };
}

function fakeKernel(
  implementation: (
    locator: string | URL | ConnectLocator,
    options?: HonuaKernelConnectOptions,
  ) => Promise<HonuaKernelConnection>,
): {
  readonly kernel: HonuaKernel;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn(implementation);
  const dispose = vi.fn(async () => undefined);
  return {
    kernel: {
      connect,
      dispose,
      [Symbol.asyncDispose]: dispose,
    } as unknown as HonuaKernel,
    connect,
    dispose,
  };
}
