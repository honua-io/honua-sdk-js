import { describe, expect, it, vi } from "vitest";

import {
  INCIDENT_LAYER_ID,
  INCIDENT_SOURCE_ID,
  INITIAL_INCIDENTS,
} from "../examples/realtime-incident-dashboard/src/fixtures.js";
import {
  type IncidentMapLoadErrorEvent,
  createIncidentLifecycle,
  initializeIncidentMap,
} from "../examples/realtime-incident-dashboard/src/lifecycle.js";
import {
  INCIDENT_METADATA_CACHE_STATE,
  evaluateIncidentLiveStateAuthority,
  formatIncidentMetadataCacheState,
} from "../examples/realtime-incident-dashboard/src/live-state.js";
import {
  formatIncidentAccessibleName,
  presentIncidentConnection,
} from "../examples/realtime-incident-dashboard/src/presentation.js";
import { applyIncidentProjection, incidentRecords } from "../examples/realtime-incident-dashboard/src/projection.js";
import { createFixtureIncidentTransport } from "../examples/realtime-incident-dashboard/src/realtime-fixture.js";
import {
  createIncidentDashboardTransport,
  decodeIncidentServerEvent,
  readIncidentTransportConfig,
  resolveIncidentTransportConfig,
} from "../examples/realtime-incident-dashboard/src/realtime-transport.js";
import {
  SAFE_DEMO_EDIT_SOURCE_ID,
  SAFE_DEMO_INCIDENT_ID,
  evaluateIncidentMutationGuard,
} from "../examples/realtime-incident-dashboard/src/safe-edit.js";
import type { IncidentFeature } from "../examples/realtime-incident-dashboard/src/types.js";
import {
  createExplorationContext,
  selectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget,
} from "../src/exploration/index.js";
import {
  createRealtimeFeatureStore,
  emptyRealtimeFeatureState,
  realtimeFeatureKey,
  reconcileRealtimeSelection,
  reduceRealtimeFeatureState,
} from "../src/realtime/index.js";

describe("realtime incident dashboard presentation", () => {
  it("does not claim live authority while connecting, reconnecting, or failed", () => {
    const connecting = presentIncidentConnection("live", "connecting", false);
    expect(connecting).toMatchObject({ laneLabel: "Live source selected", overlayState: "loading" });
    expect(connecting.disclosure).toMatch(/read-only and non-authoritative/i);
    expect(`${connecting.disclosure} ${connecting.overlay}`).not.toMatch(/connected/i);

    const reconnecting = presentIncidentConnection("live", "reconnecting", false);
    expect(reconnecting).toMatchObject({ laneLabel: "Live source reconnecting", overlayState: "degraded" });
    expect(`${reconnecting.disclosure} ${reconnecting.overlay}`).toMatch(/read-only and non-authoritative/i);

    const failed = presentIncidentConnection("live", "error", false);
    expect(failed).toMatchObject({ laneLabel: "Live source error", overlayState: "error" });
    expect(failed.disclosure).toMatch(/read-only and non-authoritative/i);
  });

  it("claims authority only for an open authoritative source and always labels replay read-only", () => {
    expect(presentIncidentConnection("live", "live", true)).toMatchObject({
      laneLabel: "Live authoritative",
      overlayState: "ready",
    });
    expect(presentIncidentConnection("live", "live", false)).toMatchObject({
      laneLabel: "Live source unverified",
      overlayState: "degraded",
    });

    const replay = presentIncidentConnection("replay", "live", true, "Streaming is unavailable.");
    expect(replay).toMatchObject({ laneLabel: "Replay fallback", overlayState: "degraded" });
    expect(`${replay.disclosure} ${replay.overlay}`).toMatch(/read-only/i);
  });

  it("includes severity and status in each queue action's accessible name", () => {
    expect(formatIncidentAccessibleName(INITIAL_INCIDENTS[0])).toBe(
      "Open Harbor fuel sheen, Critical severity, Open status",
    );
  });
});

describe("realtime incident dashboard lifecycle", () => {
  it("cleans every incrementally owned resource once even if one cleanup fails", () => {
    const lifecycle = createIncidentLifecycle();
    const mapRemove = vi.fn();
    const storeClose = vi.fn(() => {
      throw new Error("close failed");
    });
    const unsubscribe = vi.fn();
    lifecycle.own(mapRemove);
    lifecycle.own(storeClose);
    lifecycle.own(unsubscribe);

    expect(lifecycle.dispose()).toHaveLength(1);
    expect(lifecycle.disposed).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
    expect(mapRemove).toHaveBeenCalledOnce();
    expect(lifecycle.dispose()).toEqual([]);
  });

  it.each(["initializer", "style"] as const)(
    "removes the partial map and load listeners after a %s failure",
    async (failure) => {
      let loadListener: (() => void) | undefined;
      let errorListener: ((event: IncidentMapLoadErrorEvent) => void) | undefined;
      const off = vi.fn();
      const remove = vi.fn();
      const map = {
        on(type: "load" | "error", listener: (() => void) | ((event: IncidentMapLoadErrorEvent) => void)) {
          if (type === "load") loadListener = listener as () => void;
          else errorListener = listener as (event: IncidentMapLoadErrorEvent) => void;
        },
        off,
        remove,
      };
      const initialization = initializeIncidentMap(map, () => {
        if (failure === "initializer") throw new Error("layer initialization failed");
        return "ready";
      });

      if (failure === "initializer") loadListener?.();
      else errorListener?.({ error: { message: "style failed" } });

      await expect(initialization).rejects.toThrow(
        failure === "initializer" ? "layer initialization failed" : "style failed",
      );
      expect(remove).toHaveBeenCalledOnce();
      expect(off).toHaveBeenCalledTimes(2);
      expect(off).toHaveBeenCalledWith("load", loadListener);
      expect(off).toHaveBeenCalledWith("error", errorListener);
    },
  );
});

describe("realtime incident dashboard fixture", () => {
  it("prefers deployed live streaming and falls back to visibly labeled replay", async () => {
    const autoConfig = readIncidentTransportConfig({ search: "" } as Location);
    expect(autoConfig).toMatchObject({
      requestedMode: "auto",
      demoBaseUrl: "https://demo.honua.io",
      streamUrl: "https://demo.honua.io/api/v1/streaming/features",
      sourceIdentity: "maui-incidents",
      layerId: 0,
    });

    const live = await resolveIncidentTransportConfig(autoConfig, {
      fetchFn: async () => new Response(JSON.stringify({ enabled: true }), { status: 200 }),
    });
    expect(live).toMatchObject({ mode: "live", requestedMode: "auto" });
    expect(createIncidentDashboardTransport(live).transport.capabilities?.kind).toBe("sse");

    const replay = await resolveIncidentTransportConfig(autoConfig, {
      fetchFn: async () => new Response(JSON.stringify({ enabled: false, minimumEdition: "Pro" }), { status: 200 }),
    });
    expect(replay).toMatchObject({
      mode: "replay",
      requestedMode: "auto",
      fallbackReason: expect.stringContaining("requires Pro"),
    });
    const replayTransport = createIncidentDashboardTransport(replay);
    expect(replayTransport.controls).toMatchObject({
      mode: "replay",
      safeDemoEditing: false,
      authorized: false,
    });
  });

  it.each(["client_secret", "x-api-key", "X-Goog-Signature"])(
    "rejects the %s credential query parameter from public endpoints",
    (credentialKey) => {
      const baseUrl = new URL("https://demo.honua.io");
      baseUrl.searchParams.set(credentialKey, "must-not-enter-the-browser");
      const search = new URLSearchParams({ baseUrl: baseUrl.href }).toString();
      expect(() => readIncidentTransportConfig({ search: `?${search}` } as Location)).toThrow(
        "Incident endpoint must not contain credential query parameters.",
      );
    },
  );

  it("preserves benign public endpoint query parameters", () => {
    const baseUrl = "https://demo.honua.io/tenant?style=night&page_tokenized=true";
    const search = new URLSearchParams({ baseUrl }).toString();
    expect(readIncidentTransportConfig({ search: `?${search}` } as Location).demoBaseUrl).toBe(baseUrl);
  });

  it("uses an explicit isolated fixture-edit lane for required CI", async () => {
    const fixtureLocation = {
      origin: "http://127.0.0.1:4173",
      search: "?transport=fixture-edit&fixtureRun=incident-operations",
    } as Location;
    const fixtureConfig = readIncidentTransportConfig(fixtureLocation);
    const fixtureResolved = await resolveIncidentTransportConfig(fixtureConfig, {
      fetchFn: async () => {
        throw new Error("fixture configuration must not access the network");
      },
    });
    const actionRequests: string[] = [];
    const fixture = createIncidentDashboardTransport(fixtureResolved, {
      fetchFn: (async (input, init) => {
        actionRequests.push(String(input));
        if (String(input).endsWith("/actions/refresh")) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Fixture action aborted.", "AbortError")),
              { once: true },
            );
          });
        }
        return new Response(
          JSON.stringify({
            label: "Escalate outage",
            kind: "upsert",
            event: { type: "upsert", feature: { id: "INC-1002", feature: INITIAL_INCIDENTS[1] } },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(fixture.controls).toMatchObject({
      mode: "fixture-edit",
      sourceIdentity: SAFE_DEMO_EDIT_SOURCE_ID,
      safeDemoEditing: true,
      authorized: true,
    });
    expect(fixtureConfig).toMatchObject({
      demoBaseUrl: "http://127.0.0.1:4173",
      streamUrl: "http://127.0.0.1:4173/api/v1/streaming/features",
      fixtureRunId: "incident-operations",
      fixtureControlUrl: "http://127.0.0.1:4173/__fixture__/runs/incident-operations",
    });
    expect(fixture.transport.capabilities?.kind).toBe("sse");
    expect(fixture.request).toMatchObject({
      requestId: "realtime-incident-dashboard",
      sourceId: INCIDENT_SOURCE_ID,
      layerId: INCIDENT_LAYER_ID,
      mode: "snapshot-then-delta",
      metadata: {
        channel: "fixture-edit",
        livePreferred: true,
      },
    });
    await expect(fixture.controls.step()).resolves.toMatchObject({ label: "Escalate outage", kind: "upsert" });
    expect(actionRequests).toEqual(["http://127.0.0.1:4173/__fixture__/runs/incident-operations/actions/step"]);
    const pendingRefresh = fixture.controls.refresh();
    fixture.controls.dispose();
    await expect(pendingRefresh).rejects.toMatchObject({ name: "AbortError" });
    await expect(fixture.controls.step()).rejects.toMatchObject({ name: "AbortError" });
    expect(actionRequests.at(-1)).toBe("http://127.0.0.1:4173/__fixture__/runs/incident-operations/actions/refresh");
  });

  it("rejects missing runs and cross-origin fixture-edit endpoints before creating controls", () => {
    const origin = "http://127.0.0.1:4173";
    expect(() => readIncidentTransportConfig({ origin, search: "?transport=fixture-edit" } as Location)).toThrow(
      /explicit valid fixtureRun/i,
    );
    for (const search of [
      "?transport=fixture-edit&fixtureRun=incident.operations",
      "?transport=fixture-edit&fixtureRun=incident_operations",
      "?transport=fixture-edit&fixtureRun=incident-a&fixtureRun=incident-b",
    ]) {
      expect(() => readIncidentTransportConfig({ origin, search } as Location), search).toThrow(
        /explicit valid fixtureRun/i,
      );
    }

    for (const parameter of ["baseUrl", "streamUrl", "capabilitiesUrl"]) {
      const search = new URLSearchParams({
        transport: "fixture-edit",
        fixtureRun: "incident-operations",
        [parameter]: "http://127.0.0.1:9999/foreign",
      });
      expect(() => readIncidentTransportConfig({ origin, search: `?${search}` } as Location)).toThrow(/same origin/i);
    }
  });

  it("rejects malformed remote action acknowledgements, events, incidents, and conflict receipts", async () => {
    const config = {
      ...readIncidentTransportConfig({
        origin: "http://127.0.0.1:4173",
        search: "?transport=fixture-edit&fixtureRun=incident-operations",
      } as Location),
      mode: "fixture-edit" as const,
    };
    const controlsFor = (payload: unknown, status = 200) =>
      createIncidentDashboardTransport(config, {
        fetchFn: (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch,
      }).controls;
    const invalidActions: Array<{
      payload: unknown;
      invoke(controls: ReturnType<typeof controlsFor>): Promise<unknown>;
    }> = [
      { payload: { label: 7, kind: "upsert" }, invoke: (controls) => controls.step() },
      { payload: { label: "Step", kind: "move" }, invoke: (controls) => controls.step() },
      {
        payload: {
          label: "Step",
          kind: "upsert",
          event: { type: "upsert", feature: { id: "INC-1002", feature: { id: "INC-1002" } } },
        },
        invoke: (controls) => controls.step(),
      },
      { payload: { reconnecting: false }, invoke: (controls) => controls.reconnect() },
      { payload: { resumed: "true" }, invoke: (controls) => controls.resume() },
      { payload: [], invoke: (controls) => controls.refresh() },
      { payload: { duplicated: 1 }, invoke: (controls) => controls.duplicateLast() },
      { payload: { staleCursorInjected: null }, invoke: (controls) => controls.staleCursor() },
      {
        payload: { incident: { id: SAFE_DEMO_INCIDENT_ID } },
        invoke: (controls) => controls.simulateConcurrentUpdate(),
      },
    ];
    for (const invalid of invalidActions) {
      const controls = controlsFor(invalid.payload);
      await expect(invalid.invoke(controls)).rejects.toThrow(/malformed response/i);
      controls.dispose();
    }
    const noPriorDuplicate = controlsFor({ duplicated: false });
    await expect(noPriorDuplicate.duplicateLast()).resolves.toBeUndefined();
    noPriorDuplicate.dispose();

    const request = {
      incidentId: SAFE_DEMO_INCIDENT_ID,
      expectedRevision: 1,
      idempotencyKey: "malformed-edit",
      patch: { status: "monitoring" as const, assignedTo: "Exercise Lead" },
    };
    for (const status of [200, 409]) {
      const controls = controlsFor(
        {
          outcome: 7,
          operation: "edit",
          idempotencyKey: request.idempotencyKey,
          reason: "Invalid outcome type",
        },
        status,
      );
      await expect(controls.edit(request)).rejects.toThrow(/malformed response/i);
      controls.dispose();
    }
    const mismatchedReceipt = controlsFor({
      outcome: "conflict",
      operation: "edit",
      idempotencyKey: "another-request",
      reason: "Mismatched request binding",
    });
    await expect(mismatchedReceipt.edit(request)).rejects.toThrow(/malformed response/i);
    mismatchedReceipt.dispose();

    const safeIncident = INITIAL_INCIDENTS.find((incident) => incident.id === SAFE_DEMO_INCIDENT_ID);
    expect(safeIncident).toBeDefined();
    if (!safeIncident) throw new Error("Test fixture is missing its safe incident.");
    for (const payload of [
      {
        outcome: "applied",
        operation: "edit",
        idempotencyKey: request.idempotencyKey,
        reason: "Missing expected revision evidence",
        actualRevision: 2,
        incident: { ...safeIncident, revision: 2 },
      },
      {
        outcome: "duplicate",
        operation: "edit",
        idempotencyKey: request.idempotencyKey,
        reason: "Missing actual revision evidence",
        expectedRevision: 1,
        incident: { ...safeIncident, revision: 2 },
      },
    ]) {
      const malformedSuccess = controlsFor(payload);
      await expect(malformedSuccess.edit(request)).rejects.toThrow(/malformed response/i);
      malformedSuccess.dispose();
    }

    for (const incident of [
      { ...safeIncident, updatedAt: "2026-02-31T00:00:00Z", revision: 2 },
      { ...safeIncident, reportedAt: "2026-05-05", revision: 2 },
    ]) {
      const malformedTimestamp = controlsFor({
        outcome: "applied",
        operation: "edit",
        idempotencyKey: request.idempotencyKey,
        reason: "Invalid RFC 3339 timestamp evidence",
        expectedRevision: 1,
        actualRevision: 2,
        incident,
      });
      await expect(malformedTimestamp.edit(request)).rejects.toThrow(/malformed response/i);
      malformedTimestamp.dispose();
    }

    const malformedReset = controlsFor({
      outcome: "reset",
      operation: "reset-edit",
      idempotencyKey: "malformed-reset",
      reason: "Invalid operation vocabulary",
    });
    await expect(
      malformedReset.reset({ incidentId: SAFE_DEMO_INCIDENT_ID, idempotencyKey: "malformed-reset" }),
    ).rejects.toThrow(/malformed response/i);
    malformedReset.dispose();

    const malformedResetRevision = controlsFor({
      outcome: "reset",
      operation: "reset",
      idempotencyKey: "malformed-reset-revision",
      reason: "Mismatched reset revision evidence",
      actualRevision: 3,
      incident: { ...safeIncident, revision: 2 },
    });
    await expect(
      malformedResetRevision.reset({
        incidentId: SAFE_DEMO_INCIDENT_ID,
        idempotencyKey: "malformed-reset-revision",
      }),
    ).rejects.toThrow(/malformed response/i);
    malformedResetRevision.dispose();
  });

  it("adapts Honua server stream envelopes to the dashboard's protocol-neutral source", () => {
    expect(
      decodeIncidentServerEvent({
        kind: "change",
        serviceId: "maui-incidents",
        layerId: 0,
        sequence: 42,
        cursor: "server-cursor",
        changes: [{ op: "update", featureId: "INC-1001", feature: INITIAL_INCIDENTS[0] }],
      }),
    ).toMatchObject({
      type: "delta",
      sequence: 42,
      cursor: "server-cursor",
      upserts: [{ id: "INC-1001", sourceId: INCIDENT_SOURCE_ID }],
    });
  });

  it("projects live incident deltas through the linked exploration context", () => {
    let clock = 1_000;
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport({ now: () => clock });
    store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

    expect(store.state.status).toBe("live");
    expect(incidentRecords(store.state)).toHaveLength(6);

    const context = createExplorationContext({
      datasetId: "incident-dashboard-test",
      sourceIds: [INCIDENT_SOURCE_ID],
    });
    const filterView = context.connectView({ id: "filters", role: "filter" });
    filterView.setFilter("severity", {
      field: "severity",
      operator: "=",
      value: "critical",
      appliesTo: [INCIDENT_SOURCE_ID],
    });

    let projection = selectLinkedViewQueryProjection(context.state, { sourceId: INCIDENT_SOURCE_ID });
    expect(applyIncidentProjection(store.state, projection).summary.critical).toBe(1);

    clock += 1_000;
    expect(transport.step()?.label).toBe("Escalate outage");
    expect(store.state.records[realtimeFeatureKey(INCIDENT_SOURCE_ID, "INC-1002")]?.feature.status).toBe("open");
    expect(applyIncidentProjection(store.state, projection).summary.critical).toBe(2);

    clock += 1_000;
    expect(transport.step()?.label).toBe("Create brush response");
    expect(incidentRecords(store.state)).toHaveLength(7);

    clock += 1_000;
    expect(transport.step()?.label).toBe("Resolve signal failure");
    filterView.clearFilter("severity");
    filterView.setFilter("status", {
      field: "status",
      operator: "=",
      value: "resolved",
      appliesTo: [INCIDENT_SOURCE_ID],
    });
    projection = selectLinkedViewQueryProjection(context.state, { sourceId: INCIDENT_SOURCE_ID });
    const resolved = applyIncidentProjection(store.state, projection);
    expect(resolved.incidents.map((incident) => incident.id)).toEqual(["INC-1003"]);

    transport.refresh();
    expect(incidentRecords(store.state)).toHaveLength(7);

    context.dispose();
  });

  it("rejects stale feature-result cache provenance as authoritative live state", () => {
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport();
    store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

    const authority = evaluateIncidentLiveStateAuthority(store.state, {
      featureProvenance: {
        source: "feature-result-cache",
        cacheStatus: "stale",
        ageMs: 3_600_000,
        ttlMs: 300_000,
        keyFingerprint: "incident-query-cache",
      },
      metadataCache: INCIDENT_METADATA_CACHE_STATE,
    });

    expect(authority.authoritative).toBe(false);
    expect(authority.actionsEnabled).toBe(false);
    expect(authority.reason).toContain("feature-result cache");
    expect(authority.metadataCache).toMatchObject({
      scope: "metadata",
      status: "hit",
    });
  });

  it("allows metadata cache freshness without treating it as feature authority", () => {
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport();
    store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

    const metadataCache = {
      ...INCIDENT_METADATA_CACHE_STATE,
      status: "stale" as const,
      ageMs: 1_200_000,
    };
    const authority = evaluateIncidentLiveStateAuthority(store.state, {
      featureProvenance: {
        source: "realtime-delta",
        checkpoint: {
          cursor: store.state.cursor ?? "fixture-cursor",
        },
      },
      metadataCache,
    });

    expect(authority.authoritative).toBe(true);
    expect(authority.actionsEnabled).toBe(true);
    expect(authority.metadataCache?.status).toBe("stale");
    expect(formatIncidentMetadataCacheState(authority.metadataCache)).toContain("Stale metadata");
  });

  it("accepts explicit fresh snapshots only inside the configured freshness budget", () => {
    const state = reduceRealtimeFeatureState(emptyRealtimeFeatureState<IncidentFeature>(), {
      type: "snapshot",
      receivedAt: 1_000,
      features: INITIAL_INCIDENTS.map((incident) => ({
        sourceId: INCIDENT_SOURCE_ID,
        id: incident.id,
        feature: incident,
      })),
    });

    const featureProvenance = {
      source: "fresh-snapshot" as const,
      fetchedAt: 1_000,
      maxAgeMs: 1_000,
    };

    expect(
      evaluateIncidentLiveStateAuthority(state, {
        featureProvenance,
        now: 1_500,
      }).authoritative,
    ).toBe(true);
    expect(
      evaluateIncidentLiveStateAuthority(state, {
        featureProvenance,
        now: 2_500,
      }),
    ).toMatchObject({
      authoritative: false,
      actionsEnabled: false,
    });
  });

  it("represents stale and offline live state separately from metadata cache freshness", () => {
    let clock = 20_000;
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport({ now: () => clock });
    store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

    const metadataCache = {
      ...INCIDENT_METADATA_CACHE_STATE,
      status: "hit" as const,
      ageMs: 500,
    };

    clock += 2_000;
    store.checkStale({ staleAfterMs: 1_000, now: clock });
    const staleAuthority = evaluateIncidentLiveStateAuthority(store.state, {
      metadataCache,
      now: clock,
    });

    expect(staleAuthority).toMatchObject({
      authoritative: false,
      actionsEnabled: false,
      liveStatus: "stale",
      metadataCache: {
        status: "hit",
      },
    });
    expect(staleAuthority.reason).toContain("stale");

    transport.resume();
    expect(
      evaluateIncidentLiveStateAuthority(store.state, {
        metadataCache,
        now: clock,
      }).authoritative,
    ).toBe(true);

    transport.offline();
    const offlineAuthority = evaluateIncidentLiveStateAuthority(store.state, {
      metadataCache,
      now: clock,
    });

    expect(offlineAuthority).toMatchObject({
      authoritative: false,
      actionsEnabled: false,
      liveStatus: "offline",
      metadataCache: {
        status: "hit",
      },
    });
    expect(offlineAuthority.reason).toContain("offline");
  });

  it("marks stale streams and reconciles archived selected incidents", () => {
    let clock = 10_000;
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport({ now: () => clock });
    store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

    const context = createExplorationContext({
      datasetId: "incident-dashboard-selection",
      sourceIds: [INCIDENT_SOURCE_ID],
    });
    const tableView = context.connectView({ id: "table", role: "grid" });
    tableView.select([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, "INC-1005")], { replace: true });

    clock += 2_000;
    store.checkStale({ staleAfterMs: 1_000, now: clock });
    expect(store.state.status).toBe("stale");

    transport.resume();
    expect(store.state.status).toBe("live");

    transport.step();
    transport.step();
    transport.step();
    transport.step();
    transport.step();
    reconcileRealtimeSelection(tableView, store.state, { requireLiveRecord: false });

    expect(store.state.tombstones[realtimeFeatureKey(INCIDENT_SOURCE_ID, "INC-1005")]).toBeDefined();
    expect(context.state.selection).toEqual([]);

    context.dispose();
  });

  it("makes duplicate delivery, stale cursors, reconnect backoff, and resume observable", () => {
    let clock = 50_000;
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport({ now: () => clock });
    store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

    expect(store.state).toMatchObject({ status: "live", lastSequence: 1, ignoredEventCount: 0 });
    const cursorBeforeDuplicate = store.state.cursor;
    transport.duplicateLast();
    expect(store.state.ignoredEventCount).toBe(1);
    expect(store.state.cursor).toBe(cursorBeforeDuplicate);

    transport.staleCursor();
    expect(store.state.ignoredEventCount).toBe(2);
    expect(store.state.lastSequence).toBe(1);

    clock += 1_000;
    transport.reconnect();
    expect(store.state).toMatchObject({
      status: "reconnecting",
      reconnectAttempt: 1,
      retryAfterMs: 750,
      statusReason: "fixture-network-interruption",
    });
    transport.resume();
    expect(store.state.status).toBe("live");
    expect(store.state.cursor).toContain("heartbeat");
  });

  it("reconciles isolated idempotent edits, conflicts, and resets through realtime state", () => {
    let clock = Date.parse("2026-05-05T19:00:00.000Z");
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport({ now: () => clock });
    store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

    const initial = store.state.records[realtimeFeatureKey(INCIDENT_SOURCE_ID, SAFE_DEMO_INCIDENT_ID)]?.feature;
    expect(initial).toMatchObject({ safeDemoRecord: true, revision: 1, assignedTo: "Demo Operations" });

    const request = {
      incidentId: SAFE_DEMO_INCIDENT_ID,
      expectedRevision: 1,
      idempotencyKey: "edit-1",
      patch: { status: "monitoring" as const, assignedTo: "Exercise Lead" },
    };
    const applied = transport.edit(request);
    expect(applied).toMatchObject({ outcome: "applied", actualRevision: 2 });
    expect(store.state.records[realtimeFeatureKey(INCIDENT_SOURCE_ID, SAFE_DEMO_INCIDENT_ID)]?.feature).toMatchObject({
      status: "monitoring",
      assignedTo: "Exercise Lead",
      revision: 2,
    });

    expect(transport.edit(request)).toMatchObject({ outcome: "duplicate", actualRevision: 2 });

    clock += 1_000;
    transport.simulateConcurrentUpdate();
    const conflict = transport.edit({ ...request, idempotencyKey: "edit-conflict", expectedRevision: 2 });
    expect(conflict).toMatchObject({ outcome: "conflict", expectedRevision: 2, actualRevision: 3 });

    clock += 1_000;
    const reset = transport.reset({ incidentId: SAFE_DEMO_INCIDENT_ID, idempotencyKey: "reset-1" });
    expect(reset).toMatchObject({ outcome: "reset", actualRevision: 4 });
    expect(store.state.records[realtimeFeatureKey(INCIDENT_SOURCE_ID, SAFE_DEMO_INCIDENT_ID)]?.feature).toMatchObject({
      status: "assigned",
      assignedTo: "Demo Operations",
      revision: 4,
    });
    expect(transport.reset({ incidentId: SAFE_DEMO_INCIDENT_ID, idempotencyKey: "reset-1" })).toMatchObject({
      outcome: "duplicate",
      actualRevision: 4,
    });
  });

  it("fails closed for replay, stale, unauthorized, non-demo, and unsafe live sources", () => {
    const safeIncident = INITIAL_INCIDENTS.find((incident) => incident.id === SAFE_DEMO_INCIDENT_ID);
    const ordinaryIncident = INITIAL_INCIDENTS.find((incident) => !incident.safeDemoRecord);
    const baseline = {
      lane: "fixture-edit" as const,
      live: true,
      authorized: true,
      safeEditProfile: true,
      sourceIdentity: SAFE_DEMO_EDIT_SOURCE_ID,
      incident: safeIncident,
    };

    expect(evaluateIncidentMutationGuard(baseline)).toEqual({
      enabled: true,
      reason: "Isolated demo editing is enabled.",
    });
    expect(evaluateIncidentMutationGuard({ ...baseline, lane: "replay" })).toMatchObject({ enabled: false });
    expect(evaluateIncidentMutationGuard({ ...baseline, live: false })).toMatchObject({ enabled: false });
    expect(evaluateIncidentMutationGuard({ ...baseline, authorized: false })).toMatchObject({ enabled: false });
    expect(evaluateIncidentMutationGuard({ ...baseline, incident: ordinaryIncident })).toMatchObject({
      enabled: false,
    });
    expect(
      evaluateIncidentMutationGuard({
        ...baseline,
        lane: "live",
        sourceIdentity: "shared-authoritative-incidents",
      }),
    ).toMatchObject({ enabled: false });
  });
});
