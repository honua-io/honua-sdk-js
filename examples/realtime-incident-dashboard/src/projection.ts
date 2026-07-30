import type { FilterClause } from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import type { RealtimeFeatureState } from "@honua/sdk-js/realtime";

import { INCIDENT_SOURCE_ID } from "./fixtures.js";
import type { IncidentFeature, IncidentProjectionResult, IncidentSeverity, IncidentStatus } from "./types.js";

export interface IncidentPointFeature {
  readonly type: "Feature";
  readonly id: string;
  readonly properties: Readonly<Record<string, string | number>>;
  readonly geometry: {
    readonly type: "Point";
    readonly coordinates: readonly [number, number];
  };
}

export interface IncidentFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: IncidentPointFeature[];
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const STATUS_RANK: Record<IncidentStatus, number> = {
  open: 0,
  assigned: 1,
  monitoring: 2,
  resolved: 3,
};

export function incidentRecords(state: RealtimeFeatureState<IncidentFeature>): IncidentFeature[] {
  return Object.values(state.records)
    .map((record) => record.feature)
    .sort(compareIncidents);
}

export function applyIncidentProjection(
  state: RealtimeFeatureState<IncidentFeature>,
  projection: LinkedViewQueryProjection,
): IncidentProjectionResult {
  const filters = Object.values(projection.filters);
  const incidents = incidentRecords(state).filter(
    (incident) =>
      incidentInExtent(incident, projection.extent) && filters.every((clause) => matchesClause(incident, clause)),
  );

  return {
    incidents,
    summary: summarizeIncidents(incidents),
  };
}

export function summarizeIncidents(incidents: readonly IncidentFeature[]) {
  const activeIncidents = incidents.filter((incident) => incident.status !== "resolved");
  const etaTotal = activeIncidents.reduce((sum, incident) => sum + incident.etaMinutes, 0);
  return {
    total: incidents.length,
    active: activeIncidents.length,
    critical: incidents.filter((incident) => incident.severity === "critical").length,
    resolved: incidents.filter((incident) => incident.status === "resolved").length,
    etaAverage: activeIncidents.length > 0 ? Math.round(etaTotal / activeIncidents.length) : 0,
  };
}

export function incidentFeatureCollection(incidents: readonly IncidentFeature[]): IncidentFeatureCollection {
  return {
    type: "FeatureCollection",
    features: incidents.map((incident) => ({
      type: "Feature",
      id: incident.id,
      properties: {
        id: incident.id,
        title: incident.title,
        type: incident.type,
        severity: incident.severity,
        status: incident.status,
        assignedTo: incident.assignedTo,
        updatedAt: incident.updatedAt,
        etaMinutes: incident.etaMinutes,
        affectedAssets: incident.affectedAssets,
      },
      geometry: {
        type: "Point",
        coordinates: incident.coordinate,
      },
    })),
  };
}

export function createIncidentLayerFilter(projection: LinkedViewQueryProjection): unknown[] {
  const filters = Object.values(projection.filters).map(clauseToMapLibreFilter).filter(isMapLibreFilter);
  return filters.length === 0 ? ["==", "$type", "Point"] : ["all", ["==", "$type", "Point"], ...filters];
}

export function formatIncidentExtent(extent: HonuaExtent | undefined): string {
  if (!extent) return "No map extent";
  return `${formatCoordinate(extent.xmin)}, ${formatCoordinate(extent.ymin)} to ${formatCoordinate(
    extent.xmax,
  )}, ${formatCoordinate(extent.ymax)}`;
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function statusLabel(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compareIncidents(left: IncidentFeature, right: IncidentFeature): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function incidentInExtent(incident: IncidentFeature, extent: HonuaExtent | undefined): boolean {
  if (!extent) return true;
  const [x, y] = incident.coordinate;
  return x >= extent.xmin && x <= extent.xmax && y >= extent.ymin && y <= extent.ymax;
}

function matchesClause(incident: IncidentFeature, clause: FilterClause): boolean {
  if (clause.appliesTo && clause.appliesTo.length > 0 && !clause.appliesTo.includes(INCIDENT_SOURCE_ID)) {
    return true;
  }
  const value = incidentValue(incident, clause.field);
  switch (clause.operator) {
    case "=":
      return value === clause.value;
    case "!=":
      return value !== clause.value;
    case "in":
      return Array.isArray(clause.value) && clause.value.includes(value);
    case "not-in":
      return Array.isArray(clause.value) && !clause.value.includes(value);
    case "like":
      return typeof value === "string" && typeof clause.value === "string" && value.includes(clause.value);
    case "is-null":
      return value === undefined || value === null;
    case "is-not-null":
      return value !== undefined && value !== null;
    case "<":
      return typeof value === "number" && typeof clause.value === "number" && value < clause.value;
    case "<=":
      return typeof value === "number" && typeof clause.value === "number" && value <= clause.value;
    case ">":
      return typeof value === "number" && typeof clause.value === "number" && value > clause.value;
    case ">=":
      return typeof value === "number" && typeof clause.value === "number" && value >= clause.value;
    case "between":
      return (
        typeof value === "number" &&
        Array.isArray(clause.value) &&
        typeof clause.value[0] === "number" &&
        typeof clause.value[1] === "number" &&
        value >= clause.value[0] &&
        value <= clause.value[1]
      );
  }
}

function incidentValue(incident: IncidentFeature, field: string): unknown {
  if (field in incident) {
    return incident[field as keyof IncidentFeature];
  }
  return undefined;
}

function clauseToMapLibreFilter(clause: FilterClause): unknown[] | undefined {
  switch (clause.operator) {
    case "=":
      return ["==", clause.field, clause.value];
    case "!=":
      return ["!=", clause.field, clause.value];
    case "in":
      return Array.isArray(clause.value) ? ["in", clause.field, ...clause.value] : undefined;
    case "not-in":
      return Array.isArray(clause.value) ? ["!in", clause.field, ...clause.value] : undefined;
    case "is-null":
      return ["==", clause.field, null];
    case "is-not-null":
      return ["!=", clause.field, null];
    case "<":
      return typeof clause.value === "number" ? ["<", clause.field, clause.value] : undefined;
    case "<=":
      return typeof clause.value === "number" ? ["<=", clause.field, clause.value] : undefined;
    case ">":
      return typeof clause.value === "number" ? [">", clause.field, clause.value] : undefined;
    case ">=":
      return typeof clause.value === "number" ? [">=", clause.field, clause.value] : undefined;
    case "between":
      return Array.isArray(clause.value) &&
        clause.value.length === 2 &&
        typeof clause.value[0] === "number" &&
        typeof clause.value[1] === "number"
        ? ["all", [">=", clause.field, clause.value[0]], ["<=", clause.field, clause.value[1]]]
        : undefined;
    default:
      return undefined;
  }
}

function isMapLibreFilter(value: unknown[] | undefined): value is unknown[] {
  return Array.isArray(value);
}

function formatCoordinate(value: number): string {
  return value.toFixed(4);
}
