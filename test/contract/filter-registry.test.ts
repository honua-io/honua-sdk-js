import { describe, expect, it, vi } from "vitest";

import { capabilities } from "../../src/contract/index.js";
import {
  createFilterRegistry,
  parseFilterRegistry,
  projectFilterRegistryToLinkedView,
  projectFilterRegistryToQuery,
  projectFilterRegistryToWidgetProjection,
  selectActiveFilterClauses,
  serializeFilterRegistry,
} from "../../src/filter-registry/index.js";

describe("filter registry", () => {
  it("clears one owner's filters without disturbing unrelated filters", () => {
    const registry = createFilterRegistry();
    registry.upsert({
      id: "chart:severity",
      owner: { kind: "chart", id: "severity-chart" },
      field: "SEVERITY",
      operator: "=",
      value: "high",
    });
    registry.upsert({
      id: "controls:status",
      owner: { kind: "control", id: "filter-bar" },
      field: "STATUS",
      operator: "=",
      value: "open",
    });

    registry.clearOwner({ kind: "chart", id: "severity-chart" });

    expect(registry.snapshot.clauses.map((clause) => clause.id)).toEqual(["controls:status"]);
  });

  it("composes only source-scoped filters for the requested source", () => {
    const registry = createFilterRegistry({
      initialClauses: [
        {
          id: "global-status",
          owner: { kind: "control", id: "filters" },
          field: "STATUS",
          operator: "=",
          value: "open",
        },
        {
          id: "incidents-severity",
          owner: { kind: "chart", id: "severity" },
          sourceScope: ["incidents"],
          field: "SEVERITY",
          operator: "in",
          value: ["high", "critical"],
        },
        {
          id: "assets-type",
          owner: { kind: "table", id: "assets" },
          sourceScope: ["assets"],
          field: "TYPE",
          operator: "=",
          value: "hydrant",
        },
      ],
    });

    const projection = projectFilterRegistryToQuery(registry.snapshot, { sourceId: "incidents" });

    expect(Object.keys(projection.projection.filters ?? {})).toEqual(["global-status", "incidents-severity"]);
    expect(projection.query.where).toBe("(STATUS = 'open') AND (SEVERITY IN ('high', 'critical'))");
    expect(projection.runtimeFilter).toEqual([
      "all",
      ["==", ["get", "STATUS"], "open"],
      ["in", ["get", "SEVERITY"], ["literal", ["high", "critical"]]],
    ]);

    registry.clearSource("incidents");

    expect(registry.snapshot.clauses.map((clause) => clause.id)).toEqual(["assets-type", "global-status"]);
  });

  it("projects registry state into linked-view and widget projection shapes", () => {
    const registry = createFilterRegistry({
      initialClauses: [
        {
          id: "map-extent",
          owner: { kind: "map", id: "main" },
          effect: "spatial-mask",
          spatialScope: { extent: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 } },
        },
        {
          id: "search",
          owner: { kind: "search", id: "global" },
          effect: "search",
          field: "NAME",
          operator: "like",
          value: "%park%",
        },
      ],
    });

    const linkedView = projectFilterRegistryToLinkedView(registry.snapshot);
    const widgetProjection = projectFilterRegistryToWidgetProjection(registry.snapshot);

    expect(linkedView.filters.search).toEqual({ field: "NAME", operator: "like", value: "%park%" });
    expect(linkedView.spatialFilter).toMatchObject({
      geometryType: "esriGeometryEnvelope",
      geometry: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 },
    });
    expect(widgetProjection).toEqual({
      filters: { search: { field: "NAME", operator: "like", value: "%park%" } },
      spatialFilter: linkedView.spatialFilter,
    });
  });

  it("emits selector changes only when selected output changes", () => {
    const registry = createFilterRegistry();
    const listener = vi.fn();
    registry.select(
      (snapshot) => selectActiveFilterClauses(snapshot, { sourceId: "incidents" }).map((clause) => clause.id),
      listener,
    );

    registry.upsert({
      id: "assets-only",
      owner: { kind: "table", id: "assets" },
      sourceScope: ["assets"],
      field: "TYPE",
      operator: "=",
      value: "hydrant",
    });
    registry.upsert({
      id: "incidents-only",
      owner: { kind: "chart", id: "incidents" },
      sourceScope: ["incidents"],
      field: "SEVERITY",
      operator: "=",
      value: "high",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(["incidents-only"], expect.any(Object));
  });

  it("serializes deterministically and omits disabled, transient, secret, and large values", () => {
    const registry = createFilterRegistry({
      initialClauses: [
        {
          id: "b",
          owner: { kind: "search", id: "global" },
          field: "TOKEN",
          operator: "=",
          value: "secret",
          valuePolicy: { secret: true },
        },
        {
          id: "a",
          owner: { kind: "control", id: "filters" },
          field: "STATUS",
          operator: "=",
          value: "open",
          lifecycle: "persistent",
        },
        {
          id: "disabled",
          owner: { kind: "control", id: "filters" },
          field: "STATUS",
          operator: "=",
          value: "closed",
          enabled: false,
        },
        {
          id: "large",
          owner: { kind: "component", id: "upload" },
          field: "OPAQUE",
          operator: "=",
          value: "x".repeat(32),
          valuePolicy: { maxSerializedBytes: 8 },
        },
        {
          id: "transient",
          owner: { kind: "map", id: "hover" },
          field: "OBJECTID",
          operator: "=",
          value: 101,
          lifecycle: "transient",
        },
      ],
    });

    const serialized = serializeFilterRegistry(registry.snapshot);
    const parsed = parseFilterRegistry(serialized);

    expect(serialized).toBe(serializeFilterRegistry(registry.snapshot));
    expect(parsed.clauses.map((clause) => clause.id)).toEqual(["a", "b", "large"]);
    expect(parsed.clauses.find((clause) => clause.id === "a")?.value).toBe("open");
    expect(parsed.clauses.find((clause) => clause.id === "b")?.value).toBeUndefined();
    expect(parsed.clauses.find((clause) => clause.id === "large")?.value).toBeUndefined();
  });

  it("preserves degraded reasons when a source cannot apply filters server-side", () => {
    const registry = createFilterRegistry({
      initialClauses: [
        {
          id: "status",
          owner: { kind: "control", id: "filters" },
          sourceScope: ["tiles"],
          field: "STATUS",
          operator: "=",
          value: "open",
        },
      ],
    });

    const projection = projectFilterRegistryToQuery(registry.snapshot, {
      sourceId: "tiles",
      source: {
        id: "tiles",
        protocol: "maplibre-vector",
        capabilities: capabilities(["render", "tiles"]),
      },
    });

    expect(projection.degraded).toEqual([
      {
        capability: "query",
        protocol: "maplibre-vector",
        sourceId: "tiles",
        reason:
          "Filter registry kept 1 field filter(s) for runtime/client evaluation because maplibre-vector cannot apply them server-side.",
      },
    ]);
  });
});
