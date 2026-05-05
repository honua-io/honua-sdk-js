import { describe, expect, it } from "vitest";

import { INCIDENT_SOURCE_ID } from "../examples/realtime-incident-dashboard/src/fixtures.js";
import { applyIncidentProjection, incidentRecords } from "../examples/realtime-incident-dashboard/src/projection.js";
import { createFixtureIncidentTransport } from "../examples/realtime-incident-dashboard/src/realtime-fixture.js";
import type { IncidentFeature } from "../examples/realtime-incident-dashboard/src/types.js";
import {
  createExplorationContext,
  selectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget,
} from "../src/exploration/index.js";
import { createRealtimeFeatureStore, realtimeFeatureKey, reconcileRealtimeSelection } from "../src/realtime/index.js";

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
