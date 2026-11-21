import {
  type AttributeValue,
  FieldType,
  GeometryType,
  type Feature as ProtoFeature,
  type FieldDefinition as ProtoFieldDefinition,
} from "../gen/geospatial/v1/index.js";
import { toProtoObjectId, toSafeNumberOrString } from "./grpc-int64.js";
import type { HonuaFeature, HonuaFieldInfo, HonuaSpatialReference } from "./types.js";

/**
 * Maps proto FieldType enum values to Esri-style field type strings
 * used in the JSON response shape.
 */
export const FIELD_TYPE_MAP: Record<number, string> = {
  [FieldType.STRING]: "esriFieldTypeString",
  [FieldType.INTEGER]: "esriFieldTypeInteger",
  [FieldType.BIG_INTEGER]: "esriFieldTypeBigInteger",
  [FieldType.DOUBLE]: "esriFieldTypeDouble",
  [FieldType.FLOAT]: "esriFieldTypeSingle",
  [FieldType.BOOLEAN]: "esriFieldTypeSmallInteger",
  [FieldType.DATE_TIME]: "esriFieldTypeDate",
  [FieldType.DATE]: "esriFieldTypeDateOnly",
  [FieldType.TIME]: "esriFieldTypeTimeOnly",
  [FieldType.TIMESTAMP_OFFSET]: "esriFieldTypeTimestampOffset",
  [FieldType.DECIMAL]: "esriFieldTypeString",
  [FieldType.GEOMETRY]: "esriFieldTypeGeometry",
  [FieldType.JSON]: "esriFieldTypeString",
  [FieldType.BINARY]: "esriFieldTypeBlob",
  [FieldType.UUID]: "esriFieldTypeGUID",
};

/**
 * Maps proto GeometryType enum values to Esri-style geometry type strings.
 */
export const GEOMETRY_TYPE_MAP: Record<number, string> = {
  [GeometryType.POINT]: "esriGeometryPoint",
  [GeometryType.MULTI_POINT]: "esriGeometryMultipoint",
  [GeometryType.LINE_STRING]: "esriGeometryPolyline",
  [GeometryType.MULTI_LINE_STRING]: "esriGeometryPolyline",
  [GeometryType.POLYGON]: "esriGeometryPolygon",
  [GeometryType.MULTI_POLYGON]: "esriGeometryPolygon",
  [GeometryType.NONE]: "esriGeometryNull",
};

export function convertSpatialReference(sr: { wkid: number; latestWkid: number; wkt: string }): HonuaSpatialReference {
  const result: HonuaSpatialReference = {};
  if (sr.wkid !== 0) {
    result.wkid = sr.wkid;
  }
  if (sr.latestWkid !== 0) {
    result.latestWkid = sr.latestWkid;
  }
  if (sr.wkt) {
    result.wkt = sr.wkt;
  }
  return result;
}

export function convertField(field: ProtoFieldDefinition): HonuaFieldInfo {
  return {
    name: field.name,
    type: FIELD_TYPE_MAP[field.fieldType] ?? "esriFieldTypeString",
    alias: field.alias || field.name,
    length: field.length || undefined,
    nullable: field.nullable,
  };
}

/**
 * Restore `Feature.id` and `Feature.global_id` under their declared field names
 * to match `f=json` output when the server omits them from `Feature.attributes`.
 */
export function convertFeature(
  feature: ProtoFeature,
  { objectIdFieldName, globalIdFieldName }: { objectIdFieldName: string; globalIdFieldName: string },
): HonuaFeature {
  let attributes: Record<string, unknown> = {};
  for (const [key, attrValue] of Object.entries(feature.attributes)) {
    attributes[key] = convertAttributeValue(attrValue);
  }

  if (objectIdFieldName.length > 0 && feature.id !== 0n) {
    attributes = withBackfilledIdentity(attributes, objectIdFieldName, toSafeNumberOrString(feature.id));
  }
  if (globalIdFieldName.length > 0 && feature.globalId) {
    attributes = withBackfilledIdentity(attributes, globalIdFieldName, feature.globalId);
  }

  const result: HonuaFeature = { attributes };

  if (feature.geometry) {
    result.geometry = convertGeometry(feature.geometry);
  }

  return result;
}

/** Object-ID selectors for the int64 contract: safe integers or exact decimal strings. */
export function toProtoObjectIds(objectIds: number[] | string): bigint[] {
  if (typeof objectIds === "string") return objectIds.split(",").map(toProtoObjectId);
  return objectIds.map((id) => {
    if (!Number.isSafeInteger(id)) {
      throw new RangeError("objectIds must contain only safe integers for the gRPC int64 contract");
    }
    return BigInt(id);
  });
}

export function splitOutFields(outFields: string | readonly string[]): string[] {
  return typeof outFields === "string"
    ? outFields
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean)
    : [...outFields];
}

function withBackfilledIdentity(
  attributes: Record<string, unknown>,
  name: string,
  identity: unknown,
): Record<string, unknown> {
  const lowered = name.toLowerCase();
  const matches = Object.keys(attributes).filter((key) => key.toLowerCase() === lowered);
  if (matches.some((key) => attributes[key] !== null && attributes[key] !== undefined)) {
    return attributes;
  }
  return { ...attributes, [matches[0] ?? name]: identity };
}

function convertAttributeValue(attr: AttributeValue): unknown {
  switch (attr.value.case) {
    case "stringValue":
      return attr.value.value;
    case "int32Value":
      return attr.value.value;
    case "int64Value":
      return toSafeNumberOrString(attr.value.value);
    case "doubleValue":
      return attr.value.value;
    case "floatValue":
      return attr.value.value;
    case "boolValue":
      return attr.value.value;
    case "datetimeValue":
      return toSafeNumberOrString(attr.value.value);
    case "bytesValue":
      return attr.value.value;
    case "nullValue":
      return null;
    case "dateValue":
    case "timeValue":
    case "timestampOffsetValue":
    case "decimalValue":
      return attr.value.value;
    default:
      return null;
  }
}

function coordToArray(
  coordinate: { x: number; y: number; z?: number; m?: number },
  dimensions: Record<string, boolean>,
): (number | null)[] {
  const coords: (number | null)[] = [coordinate.x, coordinate.y];
  if (dimensions.hasZ) coords.push(coordinate.z ?? null);
  if (dimensions.hasM) coords.push(coordinate.m ?? null);
  return coords;
}

function coordinateDimensionFlags(coordinates: { z?: number; m?: number }[]): Record<string, boolean> {
  const hasZ = coordinates.some((coordinate) => coordinate.z !== undefined);
  const hasM = coordinates.some((coordinate) => coordinate.m !== undefined);
  return hasZ || hasM ? { hasZ, hasM } : {};
}

function convertGeometry(geometry: NonNullable<ProtoFeature["geometry"]>): Record<string, unknown> | null {
  switch (geometry.shape.case) {
    case "point": {
      const p = geometry.shape.value;
      const result: Record<string, unknown> = { x: p.x, y: p.y };
      if (p.z !== undefined) result.z = p.z;
      if (p.m !== undefined) result.m = p.m;
      return result;
    }
    case "multiPoint": {
      const mp = geometry.shape.value;
      const dimensions = coordinateDimensionFlags(mp.points);
      return {
        points: mp.points.map((p) => coordToArray(p, dimensions)),
        ...dimensions,
      };
    }
    case "polyline": {
      const pl = geometry.shape.value;
      const dimensions = coordinateDimensionFlags(pl.paths.flatMap((path) => path.coords));
      return {
        paths: pl.paths.map((path) => path.coords.map((c) => coordToArray(c, dimensions))),
        ...dimensions,
      };
    }
    case "polygon": {
      const pg = geometry.shape.value;
      const dimensions = coordinateDimensionFlags(pg.rings.flatMap((ring) => ring.coords));
      return {
        rings: pg.rings.map((ring) => ring.coords.map((c) => coordToArray(c, dimensions))),
        ...dimensions,
      };
    }
    case "multiPolygon": {
      return convertMultiPolygon(geometry.shape.value);
    }
    default:
      return null;
  }
}

function convertMultiPolygon(mpg: {
  polygons: { rings: { coords: { x: number; y: number; z?: number; m?: number }[] }[] }[];
}) {
  const dimensions = coordinateDimensionFlags(
    mpg.polygons.flatMap((polygon) => polygon.rings.flatMap((ring) => ring.coords)),
  );
  const rings: (number | null)[][][] = [];
  for (const poly of mpg.polygons) {
    for (const ring of poly.rings) {
      rings.push(ring.coords.map((c) => coordToArray(c, dimensions)));
    }
  }
  return {
    rings,
    ...dimensions,
  };
}
