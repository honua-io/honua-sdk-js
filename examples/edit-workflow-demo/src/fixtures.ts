import type { EditFieldDomain, EditWorkflowField, SourceDescriptor } from "@honua/sdk-js/contract";
import { capabilities } from "@honua/sdk-js/contract";
import type {
  EditWorkflowDataset,
  EditWorkflowMapArea,
  InspectionFeature,
  InspectionPriority,
  InspectionStatus,
  MapAreaId,
} from "./types.js";

export const EDIT_WORKFLOW_SOURCE_ID = "honua-cloud:field-inspections";
export const EDIT_WORKFLOW_READONLY_SOURCE_ID = "honua-cloud:field-inspections-readonly";
export const EDIT_WORKFLOW_GENERATED_AT = "2026-05-06T18:00:00.000Z";

export const EDIT_WORKFLOW_STATUS_DOMAIN: EditFieldDomain = {
  type: "coded-value",
  name: "Inspection status",
  codedValues: [
    { name: "Open", code: "open" },
    { name: "In progress", code: "in-progress" },
    { name: "Closed", code: "closed" },
  ],
};

export const EDIT_WORKFLOW_PRIORITY_DOMAIN: EditFieldDomain = {
  type: "coded-value",
  name: "Operational priority",
  codedValues: [
    { name: "Critical", code: "critical" },
    { name: "High", code: "high" },
    { name: "Medium", code: "medium" },
    { name: "Low", code: "low" },
  ],
};

export const EDIT_WORKFLOW_SCORE_DOMAIN: EditFieldDomain = {
  type: "range",
  name: "Inspection score",
  range: [0, 100],
};

export const EDIT_WORKFLOW_FIELDS: readonly EditWorkflowField[] = [
  { name: "OBJECTID", type: "esriFieldTypeOID", alias: "Object ID", nullable: false, editable: false },
  { name: "asset_id", type: "esriFieldTypeString", alias: "Asset ID", nullable: false, editable: true, length: 24 },
  { name: "asset_name", type: "esriFieldTypeString", alias: "Asset name", nullable: false, editable: true, length: 80 },
  {
    name: "status",
    type: "esriFieldTypeString",
    alias: "Status",
    nullable: false,
    editable: true,
    length: 16,
    domain: EDIT_WORKFLOW_STATUS_DOMAIN,
  },
  {
    name: "priority",
    type: "esriFieldTypeString",
    alias: "Priority",
    nullable: false,
    editable: true,
    length: 16,
    domain: EDIT_WORKFLOW_PRIORITY_DOMAIN,
  },
  {
    name: "inspection_score",
    type: "esriFieldTypeInteger",
    alias: "Inspection score",
    nullable: false,
    editable: true,
    domain: EDIT_WORKFLOW_SCORE_DOMAIN,
  },
  {
    name: "assigned_to",
    type: "esriFieldTypeString",
    alias: "Assigned to",
    nullable: false,
    editable: true,
    length: 64,
  },
  { name: "notes", type: "esriFieldTypeString", alias: "Notes", nullable: true, editable: true, length: 240 },
  { name: "version", type: "esriFieldTypeInteger", alias: "Version", nullable: false, editable: true },
  {
    name: "last_edited_date",
    type: "esriFieldTypeDate",
    alias: "Last edited",
    nullable: false,
    editable: false,
  },
];

export const EDIT_WORKFLOW_DOMAINS = {
  status: EDIT_WORKFLOW_STATUS_DOMAIN,
  priority: EDIT_WORKFLOW_PRIORITY_DOMAIN,
  inspection_score: EDIT_WORKFLOW_SCORE_DOMAIN,
} as const;

export const EDIT_WORKFLOW_RELATIONSHIPS = [
  { relationshipId: 1, name: "work_orders", relatedSourceId: "honua-cloud:work-orders", cardinality: "one-to-many" },
] as const;

export const EDIT_WORKFLOW_AREAS: readonly EditWorkflowMapArea[] = [
  {
    id: "honolulu-harbor",
    title: "Honolulu Harbor",
    cacheKey: "metadata:field-inspections:v1:harbor",
    extent: { xmin: -157.91, ymin: 21.29, xmax: -157.86, ymax: 21.34, spatialReference: { wkid: 4326 } },
  },
  {
    id: "airport-corridor",
    title: "Airport Corridor",
    cacheKey: "metadata:field-inspections:v1:airport",
    extent: { xmin: -157.96, ymin: 21.31, xmax: -157.89, ymax: 21.36, spatialReference: { wkid: 4326 } },
  },
  {
    id: "kakaako-grid",
    title: "Kakaako Grid",
    cacheKey: "metadata:field-inspections:v1:kakaako",
    extent: { xmin: -157.87, ymin: 21.28, xmax: -157.82, ymax: 21.33, spatialReference: { wkid: 4326 } },
  },
];

export function createEditWorkflowDataset(): EditWorkflowDataset {
  const features: InspectionFeature[] = [
    makeFeature({
      id: 4101,
      areaId: "honolulu-harbor",
      title: "Pier 2 pump station",
      x: -157.875,
      y: 21.311,
      position: { x: 46, y: 44 },
      assetId: "PUMP-HBR-02",
      status: "open",
      priority: "critical",
      score: 62,
      assignedTo: "M. Akana",
      notes: "Seal inspection needed before the next high tide cycle.",
      version: 4,
      lastEdited: "2026-05-06T17:21:00.000Z",
    }),
    makeFeature({
      id: 4102,
      areaId: "airport-corridor",
      title: "Lagoon relief valve",
      x: -157.925,
      y: 21.335,
      position: { x: 25, y: 56 },
      assetId: "VALVE-AIR-17",
      status: "in-progress",
      priority: "high",
      score: 74,
      assignedTo: "K. Lee",
      notes: "Crew confirmed access, pending pressure reading.",
      version: 8,
      lastEdited: "2026-05-06T17:36:00.000Z",
    }),
    makeFeature({
      id: 4103,
      areaId: "kakaako-grid",
      title: "Keawe feeder cabinet",
      x: -157.848,
      y: 21.301,
      position: { x: 69, y: 50 },
      assetId: "CAB-KAK-09",
      status: "closed",
      priority: "medium",
      score: 91,
      assignedTo: "L. Santos",
      notes: "Thermal image attached and cabinet secured.",
      version: 3,
      lastEdited: "2026-05-06T17:05:00.000Z",
    }),
  ];

  return {
    id: "honua-edit-workflow-demo",
    title: "Field Inspection Editing",
    sourceId: EDIT_WORKFLOW_SOURCE_ID,
    readonlySourceId: EDIT_WORKFLOW_READONLY_SOURCE_ID,
    generatedAt: EDIT_WORKFLOW_GENERATED_AT,
    mapAreas: EDIT_WORKFLOW_AREAS,
    features,
    fields: EDIT_WORKFLOW_FIELDS,
    attachments: {
      "4101": [
        { id: 9101, parentId: 4101, name: "pump-seal-before.jpg", contentType: "image/jpeg", size: 183_000 },
        { id: 9102, parentId: 4101, name: "crew-note.pdf", contentType: "application/pdf", size: 28_000 },
      ],
      "4102": [{ id: 9201, parentId: 4102, name: "pressure-log.csv", contentType: "text/csv", size: 12_400 }],
      "4103": [{ id: 9301, parentId: 4103, name: "thermal-after.png", contentType: "image/png", size: 210_500 }],
    },
  };
}

export function createEditableSourceDescriptor(sourceId = EDIT_WORKFLOW_SOURCE_ID): SourceDescriptor {
  return {
    id: sourceId,
    protocol: "geoservices-feature-service",
    locator: {
      url: "https://cloud.honua.io/mock/FieldInspections/FeatureServer/0",
      serviceId: "FieldInspections",
      layerId: 0,
    },
    capabilities: capabilities(["query", "queryExtent", "queryObjectIds", "queryRelated", "applyEdits", "attachments"]),
    schema: {
      primaryKey: "OBJECTID",
      fields: EDIT_WORKFLOW_FIELDS.map((field) => ({
        name: field.name,
        type: field.type ?? "esriFieldTypeString",
        alias: field.alias,
        length: field.length,
        nullable: field.nullable,
        editable: field.editable,
        defaultValue: field.defaultValue,
      })) as NonNullable<SourceDescriptor["schema"]>["fields"],
    },
    attribution: "Honua Cloud fixture",
  };
}

export function createReadonlySourceDescriptor(sourceId = EDIT_WORKFLOW_READONLY_SOURCE_ID): SourceDescriptor {
  return {
    ...createEditableSourceDescriptor(sourceId),
    capabilities: capabilities(["query", "queryExtent", "queryObjectIds"]),
  };
}

function makeFeature(input: {
  readonly id: number;
  readonly areaId: MapAreaId;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly position: { readonly x: number; readonly y: number };
  readonly assetId: string;
  readonly status: InspectionStatus;
  readonly priority: InspectionPriority;
  readonly score: number;
  readonly assignedTo: string;
  readonly notes: string;
  readonly version: number;
  readonly lastEdited: string;
}): InspectionFeature {
  return {
    id: input.id,
    sourceId: EDIT_WORKFLOW_SOURCE_ID,
    title: input.title,
    areaId: input.areaId,
    mapPosition: input.position,
    geometry: { type: "point", x: input.x, y: input.y, spatialReference: { wkid: 4326 } },
    attributes: {
      OBJECTID: input.id,
      asset_id: input.assetId,
      asset_name: input.title,
      status: input.status,
      priority: input.priority,
      inspection_score: input.score,
      assigned_to: input.assignedTo,
      notes: input.notes,
      version: input.version,
      last_edited_date: input.lastEdited,
    },
  };
}
