import { describe, expect, it } from "vitest";

import { INCIDENT_SOURCE_ID, INITIAL_INCIDENTS } from "../examples/realtime-incident-dashboard/src/fixtures.js";
import {
  INCIDENT_METADATA_CACHE_STATE,
  evaluateIncidentLiveStateAuthority,
  formatIncidentMetadataCacheState,
} from "../examples/realtime-incident-dashboard/src/live-state.js";
import { applyIncidentProjection, incidentRecords } from "../examples/realtime-incident-dashboard/src/projection.js";
import { createFixtureIncidentTransport } from "../examples/realtime-incident-dashboard/src/realtime-fixture.js";
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

describe("realtime incident dashboard fixture", () => {
  it("projects live incident deltas through the linked exploration context", () => {
    let clock = 1_000;
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport({ now: () => clock });
    store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

    expect(store.state.status).toBe("live");
    expect(incidentRecords(store.state)).toHaveLength(5);

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
    expect(incidentRecords(store.state)).toHaveLength(6);

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
    expect(incidentRecords(store.state)).toHaveLength(6);

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
});
