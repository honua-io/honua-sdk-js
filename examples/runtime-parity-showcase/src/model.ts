import { capabilities } from "@honua/sdk-js/contract";
import type {
  AdapterFor,
  AdapterKind,
  AttachmentApi,
  EditEnvelope,
  EditResult,
  Query,
  RelatedQuery,
  RelatedResult,
  Result,
  Source,
  SourceDescriptor,
} from "@honua/sdk-js/contract";
import type { HonuaExtent, HonuaTypedFeature } from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import type { HonuaChartModel, HonuaFeatureRecord } from "@honua/sdk-js/web-components";

export const INCIDENT_SOURCE_ID = "ops-incidents";

export type IncidentStatus = "Open" | "Monitoring" | "Resolved";

export interface IncidentAttributes {
  readonly id: string;
  readonly name: string;
  readonly status: IncidentStatus;
  readonly priority: "Critical" | "High" | "Medium" | "Low";
  readonly district: string;
  readonly team: string;
  readonly responseMinutes: number;
  readonly updatedAt: string;
}

export interface RuntimeParityFeature {
  readonly type: "Feature";
  readonly id: string;
  readonly properties: IncidentAttributes;
  readonly geometry: {
    readonly type: "Point";
    readonly coordinates: readonly [number, number];
  };
}

export interface RuntimeParityFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: readonly RuntimeParityFeature[];
}

export interface RuntimeParityFixturePayload {
  readonly sourceId: string;
  readonly generatedAt: string;
  readonly fields: readonly string[];
  readonly features: RuntimeParityFeatureCollection;
}

export type IncidentFeatureRecord = HonuaFeatureRecord<IncidentAttributes> & {
  readonly geometry: RuntimeParityFeature["geometry"];
};

const STATUS_COLORS: Readonly<Record<IncidentStatus, string>> = {
  Open: "#d93f3f",
  Monitoring: "#d9902f",
  Resolved: "#2f8f75",
};

const EMPTY_ATTACHMENTS: AttachmentApi = {
  async query() {
    throw unsupported("attachments");
  },
  async list() {
    throw unsupported("attachments");
  },
  async add() {
    throw unsupported("attachments");
  },
  async update() {
    throw unsupported("attachments");
  },
  async delete() {
    throw unsupported("attachments");
  },
};

export function recordsFromFeatureCollection(
  collection: RuntimeParityFeatureCollection,
  sourceId = INCIDENT_SOURCE_ID,
): IncidentFeatureRecord[] {
  return collection.features.map((feature) => ({
    id: feature.id,
    sourceId,
    title: feature.properties.name,
    attributes: feature.properties,
    geometry: feature.geometry,
  }));
}

export function statusChartModel(records: readonly IncidentFeatureRecord[]): HonuaChartModel {
  const counts = new Map<IncidentStatus, number>([
    ["Open", 0],
    ["Monitoring", 0],
    ["Resolved", 0],
  ]);
  for (const record of records) {
    counts.set(record.attributes.status, (counts.get(record.attributes.status) ?? 0) + 1);
  }
  return {
    id: "runtime-parity-status",
    title: "Status by linked view",
    kind: "bar",
    status: "ready",
    sourceId: INCIDENT_SOURCE_ID,
    data: [...counts.entries()].map(([status, value]) => ({
      label: status,
      value,
      color: STATUS_COLORS[status],
    })),
  };
}

export function filterRecordsByProjection(
  records: readonly IncidentFeatureRecord[],
  projection: Pick<LinkedViewQueryProjection, "filters" | "spatialFilter" | "extent">,
): IncidentFeatureRecord[] {
  return records.filter(
    (record) => matchesProjectionFilters(record, projection.filters) && matchesSpatialState(record, projection),
  );
}

export function createFixtureWidgetSource(
  records: readonly IncidentFeatureRecord[],
  sourceId = INCIDENT_SOURCE_ID,
): Source<IncidentAttributes> {
  const descriptor: SourceDescriptor = {
    id: sourceId,
    protocol: "maplibre-geojson",
    locator: { url: "fixture://runtime-parity-showcase/incidents" },
    capabilities: capabilities(["query", "queryExtent", "queryObjectIds"]),
    schema: {
      primaryKey: "id",
      fields: [
        { name: "id", type: "esriFieldTypeString" },
        { name: "name", type: "esriFieldTypeString" },
        { name: "status", type: "esriFieldTypeString" },
        { name: "priority", type: "esriFieldTypeString" },
        { name: "district", type: "esriFieldTypeString" },
        { name: "team", type: "esriFieldTypeString" },
        { name: "responseMinutes", type: "esriFieldTypeInteger" },
        { name: "updatedAt", type: "esriFieldTypeDate" },
      ],
    },
    attribution: "Runtime parity showcase fixtures",
  };

  return {
    descriptor,
    capabilities: descriptor.capabilities,
    async query(request: Query<IncidentAttributes> = {}) {
      return queryRecords(records, request);
    },
    async queryAll(request: Query<IncidentAttributes> = {}) {
      return queryRecords(records, request);
    },
    async queryAggregate() {
      throw unsupported("queryAggregate");
    },
    async queryExtent(request: Query<IncidentAttributes> = {}) {
      const result = await queryRecords(records, { ...request, pagination: undefined });
      return { extent: extentForFeatures(result.features), count: result.totalCount };
    },
    async *stream(request: Query<IncidentAttributes> = {}) {
      yield await queryRecords(records, request);
    },
    async queryObjectIds(request: Query<IncidentAttributes> = {}) {
      const result = await queryRecords(records, request);
      return result.features.map((feature) => feature.attributes.id);
    },
    async applyEdits(_envelope: EditEnvelope<IncidentAttributes>): Promise<EditResult> {
      throw unsupported("applyEdits");
    },
    async queryRelated<R = Record<string, unknown>>(_request: RelatedQuery): Promise<RelatedResult<R>> {
      throw unsupported("queryRelated");
    },
    attachments: EMPTY_ATTACHMENTS,
    protocol<K extends AdapterKind>(_kind: K): AdapterFor<K> | undefined {
      return undefined;
    },
    adapter<K extends AdapterKind>(_kind: K): AdapterFor<K> | undefined {
      return undefined;
    },
  };
}

function queryRecords(
  records: readonly IncidentFeatureRecord[],
  request: Query<IncidentAttributes>,
): Result<IncidentAttributes> {
  const filtered = records
    .filter((record) => matchesWhere(record, request.where))
    .filter((record) => matchesSpatialFilter(record, request.spatialFilter))
    .sort((left, right) => compareRecords(left, right, request.orderBy));
  const offset = Math.max(0, request.pagination?.offset ?? 0);
  const limit = request.pagination?.limit;
  const paged = limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + Math.max(0, limit));

  return {
    features: paged.map(toTypedFeature),
    exceededTransferLimit: limit !== undefined && offset + limit < filtered.length,
    totalCount: filtered.length,
    fields: [
      { name: "id", type: "esriFieldTypeString" },
      { name: "name", type: "esriFieldTypeString" },
      { name: "status", type: "esriFieldTypeString" },
      { name: "priority", type: "esriFieldTypeString" },
      { name: "district", type: "esriFieldTypeString" },
      { name: "team", type: "esriFieldTypeString" },
      { name: "responseMinutes", type: "esriFieldTypeInteger" },
      { name: "updatedAt", type: "esriFieldTypeDate" },
    ],
  };
}

function toTypedFeature(record: IncidentFeatureRecord): HonuaTypedFeature<IncidentAttributes> {
  return {
    attributes: record.attributes,
    geometry: record.geometry,
  };
}

function matchesProjectionFilters(
  record: IncidentFeatureRecord,
  filters: LinkedViewQueryProjection["filters"],
): boolean {
  for (const clause of Object.values(filters)) {
    if (clause.appliesTo && clause.appliesTo.length > 0 && !clause.appliesTo.includes(record.sourceId)) continue;
    const value = readAttribute(record, clause.field);
    switch (clause.operator) {
      case "=":
        if (value !== clause.value) return false;
        break;
      case "!=":
        if (value === clause.value) return false;
        break;
      case "in":
        if (!Array.isArray(clause.value) || !clause.value.includes(value)) return false;
        break;
      case "not-in":
        if (Array.isArray(clause.value) && clause.value.includes(value)) return false;
        break;
      case ">":
      case ">=":
      case "<":
      case "<=":
        if (!compareNumeric(value, clause.operator, clause.value)) return false;
        break;
      case "like":
        if (
          !String(value ?? "")
            .toLowerCase()
            .includes(String(clause.value ?? "").toLowerCase())
        )
          return false;
        break;
      case "between":
        if (!matchesBetween(value, clause.value)) return false;
        break;
      case "is-null":
        if (value !== null && value !== undefined) return false;
        break;
      case "is-not-null":
        if (value === null || value === undefined) return false;
        break;
    }
  }
  return true;
}

function matchesWhere(record: IncidentFeatureRecord, where: string | undefined): boolean {
  if (!where) return true;
  const comparisons = [...where.matchAll(/([a-zA-Z][\w]*)\s*(=|<>)\s*'([^']*)'/g)];
  if (comparisons.length === 0) return true;
  return comparisons.every((match) => {
    const [, field, operator, expected] = match;
    const actual = String(readAttribute(record, field) ?? "");
    return operator === "=" ? actual === expected : actual !== expected;
  });
}

function matchesSpatialState(
  record: IncidentFeatureRecord,
  projection: Pick<LinkedViewQueryProjection, "spatialFilter" | "extent">,
): boolean {
  return matchesSpatialFilter(record, projection.spatialFilter) && matchesExtent(record, projection.extent);
}

function matchesSpatialFilter(record: IncidentFeatureRecord, spatialFilter: Query["spatialFilter"]): boolean {
  if (!spatialFilter) return true;
  const envelope = readEnvelope(spatialFilter);
  return envelope ? pointInExtent(record.geometry.coordinates, envelope) : true;
}

function matchesExtent(record: IncidentFeatureRecord, extent: HonuaExtent | undefined): boolean {
  return extent ? pointInExtent(record.geometry.coordinates, extent) : true;
}

function pointInExtent(point: readonly [number, number], extent: HonuaExtent): boolean {
  return point[0] >= extent.xmin && point[0] <= extent.xmax && point[1] >= extent.ymin && point[1] <= extent.ymax;
}

function readEnvelope(spatialFilter: Query["spatialFilter"]): HonuaExtent | undefined {
  const geometry = (spatialFilter as { readonly geometry?: Partial<HonuaExtent> } | undefined)?.geometry;
  if (
    geometry &&
    typeof geometry.xmin === "number" &&
    typeof geometry.ymin === "number" &&
    typeof geometry.xmax === "number" &&
    typeof geometry.ymax === "number"
  ) {
    return {
      xmin: geometry.xmin,
      ymin: geometry.ymin,
      xmax: geometry.xmax,
      ymax: geometry.ymax,
      spatialReference: geometry.spatialReference,
    };
  }
  return undefined;
}

function extentForFeatures(features: readonly HonuaTypedFeature<IncidentAttributes>[]): HonuaExtent | null {
  const points = features
    .map((feature) => (feature.geometry as RuntimeParityFeature["geometry"] | undefined)?.coordinates)
    .filter((point): point is readonly [number, number] => Array.isArray(point) && point.length >= 2);
  if (points.length === 0) return null;
  return {
    xmin: Math.min(...points.map((point) => point[0])),
    ymin: Math.min(...points.map((point) => point[1])),
    xmax: Math.max(...points.map((point) => point[0])),
    ymax: Math.max(...points.map((point) => point[1])),
    spatialReference: { wkid: 4326 },
  };
}

function compareRecords(
  left: IncidentFeatureRecord,
  right: IncidentFeatureRecord,
  orderBy: Query<IncidentAttributes>["orderBy"],
): number {
  for (const sort of orderBy ?? []) {
    const direction = sort.direction === "desc" ? -1 : 1;
    const compared = compareValues(readAttribute(left, sort.field), readAttribute(right, sort.field));
    if (compared !== 0) return compared * direction;
  }
  return 0;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function compareNumeric(value: unknown, operator: ">" | ">=" | "<" | "<=", expected: unknown): boolean {
  const left = Number(value);
  const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  switch (operator) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
  }
}

function matchesBetween(value: unknown, expected: unknown): boolean {
  if (!Array.isArray(expected) || expected.length < 2) return false;
  const numeric = Number(value);
  const min = Number(expected[0]);
  const max = Number(expected[1]);
  return Number.isFinite(numeric) && Number.isFinite(min) && Number.isFinite(max) && numeric >= min && numeric <= max;
}

function readAttribute(record: IncidentFeatureRecord, field: string): unknown {
  return record.attributes[field as keyof IncidentAttributes];
}

function unsupported(operation: string): Error {
  return new Error(`Runtime parity fixture source does not support ${operation}.`);
}
