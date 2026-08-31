import { v as create } from "./file-C7ic42ti.js";
import { C as StatisticType, S as StatisticDefinitionSchema, _ as DistanceUnit, b as SpatialReferenceSchema, d as GeometrySchema, f as MultiPointGeometrySchema, g as SpatialFilterSchema, h as PolylineGeometrySchema, l as CoordinateSchema, m as PolygonGeometrySchema, o as QueryFeaturesRequestSchema, p as PointGeometrySchema, u as CoordinateSequenceSchema, v as FieldType, x as SpatialRelationship, y as GeometryType } from "./feature_service_pb-BgDACB2_.js";
import { r as HonuaGrpcError } from "./errors-CqfCSo_y.js";
//#region .tmp/sample-runner/1abf67c5-8f5a-4178-a68a-0cf116a4f0ef/packed-sdk/extract/package/dist/src/core/grpc-adapter.js
/**
* Maps proto FieldType enum values to Esri-style field type strings
* used in the JSON response shape.
*/
var FIELD_TYPE_MAP = {
	[FieldType.STRING]: "esriFieldTypeString",
	[FieldType.INTEGER]: "esriFieldTypeInteger",
	[FieldType.BIG_INTEGER]: "esriFieldTypeBigInteger",
	[FieldType.DOUBLE]: "esriFieldTypeDouble",
	[FieldType.FLOAT]: "esriFieldTypeSingle",
	[FieldType.BOOLEAN]: "esriFieldTypeSmallInteger",
	[FieldType.DATE_TIME]: "esriFieldTypeDate",
	[FieldType.DATE]: "esriFieldTypeDate",
	[FieldType.TIME]: "esriFieldTypeDate",
	[FieldType.GEOMETRY]: "esriFieldTypeGeometry",
	[FieldType.JSON]: "esriFieldTypeString",
	[FieldType.BINARY]: "esriFieldTypeBlob",
	[FieldType.UUID]: "esriFieldTypeGUID"
};
/**
* Maps proto GeometryType enum values to Esri-style geometry type strings.
*/
var GEOMETRY_TYPE_MAP = {
	[GeometryType.POINT]: "esriGeometryPoint",
	[GeometryType.MULTI_POINT]: "esriGeometryMultipoint",
	[GeometryType.LINE_STRING]: "esriGeometryPolyline",
	[GeometryType.MULTI_LINE_STRING]: "esriGeometryPolyline",
	[GeometryType.POLYGON]: "esriGeometryPolygon",
	[GeometryType.MULTI_POLYGON]: "esriGeometryPolygon",
	[GeometryType.NONE]: "esriGeometryNull"
};
var ESRI_TO_PROTO_SPATIAL_REL_MAP = {
	esriSpatialRelIntersects: SpatialRelationship.INTERSECTS,
	esriSpatialRelContains: SpatialRelationship.CONTAINS,
	esriSpatialRelWithin: SpatialRelationship.WITHIN,
	esriSpatialRelEnvelopeIntersects: SpatialRelationship.ENVELOPE_INTERSECTS,
	esriSpatialRelIndexIntersects: SpatialRelationship.ENVELOPE_INTERSECTS,
	esriSpatialRelCrosses: SpatialRelationship.CROSSES,
	esriSpatialRelTouches: SpatialRelationship.TOUCHES,
	esriSpatialRelOverlaps: SpatialRelationship.OVERLAPS,
	esriSpatialRelDisjoint: SpatialRelationship.DISJOINT
};
var ESRI_TO_PROTO_DISTANCE_UNIT_MAP = {
	esrisrunit_meter: DistanceUnit.METERS,
	meter: DistanceUnit.METERS,
	meters: DistanceUnit.METERS,
	m: DistanceUnit.METERS,
	esrisrunit_foot: DistanceUnit.FEET,
	esrisrunit_usfoot: DistanceUnit.FEET,
	foot: DistanceUnit.FEET,
	feet: DistanceUnit.FEET,
	ft: DistanceUnit.FEET,
	esrisrunit_kilometer: DistanceUnit.KILOMETERS,
	kilometer: DistanceUnit.KILOMETERS,
	kilometers: DistanceUnit.KILOMETERS,
	km: DistanceUnit.KILOMETERS,
	esrisrunit_statutemile: DistanceUnit.MILES,
	mile: DistanceUnit.MILES,
	miles: DistanceUnit.MILES,
	mi: DistanceUnit.MILES
};
var STATISTIC_TYPE_MAP = {
	count: StatisticType.COUNT,
	sum: StatisticType.SUM,
	min: StatisticType.MIN,
	max: StatisticType.MAX,
	avg: StatisticType.AVG,
	stddev: StatisticType.STDDEV,
	var: StatisticType.VAR
};
var MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
var MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
var MIN_PROTO_INT64 = -(1n << 63n);
var MAX_PROTO_INT64 = (1n << 63n) - 1n;
function toProtoObjectId(value) {
	const token = value.trim();
	if (!/^(?:0|-?[1-9][0-9]*)$/.test(token)) throw new RangeError("string objectIds must contain canonical decimal int64 values");
	const parsed = BigInt(token);
	if (parsed < MIN_PROTO_INT64 || parsed > MAX_PROTO_INT64) throw new RangeError("string objectIds must remain within the signed int64 range");
	return parsed;
}
function toProtoPageInt64(field, value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer for the gRPC int64 contract`);
	return BigInt(value);
}
/**
* Converts a SDK QueryFeaturesRequest into a proto QueryFeaturesRequest message.
*/
function toProtoQueryRequest(request) {
	const msg = create(QueryFeaturesRequestSchema);
	msg.serviceId = request.serviceId;
	msg.layerId = request.layerId;
	msg.where = request.where ?? "1=1";
	msg.returnGeometry = request.returnGeometry ?? true;
	const outSpatialReference = toProtoSpatialReference(request.outSr) ?? toProtoSpatialReference(request.extraParams?.outSR) ?? toProtoSpatialReference(request.extraParams?.outSr);
	if (outSpatialReference) msg.outSr = outSpatialReference;
	if (request.outFields !== void 0) msg.outFields = typeof request.outFields === "string" ? request.outFields.split(",").map((f) => f.trim()).filter(Boolean) : request.outFields;
	if (request.objectIds !== void 0) msg.objectIds = typeof request.objectIds === "string" ? request.objectIds.split(",").map(toProtoObjectId) : request.objectIds.map((id) => {
		if (!Number.isSafeInteger(id)) throw new RangeError("objectIds must contain only safe integers for the gRPC int64 contract");
		return BigInt(id);
	});
	if (request.resultOffset !== void 0) msg.resultOffsetLong = toProtoPageInt64("resultOffset", request.resultOffset);
	if (request.resultRecordCount !== void 0) msg.resultRecordCountLong = toProtoPageInt64("resultRecordCount", request.resultRecordCount);
	if (request.orderByFields !== void 0) msg.orderBy = request.orderByFields;
	if (request.returnDistinctValues !== void 0) msg.returnDistinct = request.returnDistinctValues;
	if (request.groupByFieldsForStatistics !== void 0) msg.groupBy = request.groupByFieldsForStatistics.split(",").map((field) => field.trim()).filter(Boolean);
	if (request.outStatistics !== void 0) msg.outStatistics = toProtoStatistics(request.outStatistics);
	if (request.geometry !== void 0) {
		const filter = create(SpatialFilterSchema);
		const { geometry, spatialReference } = toProtoGeometry(request.geometry);
		filter.geometry = geometry;
		if (request.spatialRel) {
			const mapped = ESRI_TO_PROTO_SPATIAL_REL_MAP[request.spatialRel];
			if (!mapped) throw new Error(`Unsupported spatial relationship for gRPC transport: ${request.spatialRel}`);
			filter.spatialRelationship = mapped;
		} else filter.spatialRelationship = SpatialRelationship.INTERSECTS;
		if (spatialReference) filter.spatialReference = spatialReference;
		const distance = request.distance ?? parseExtraNumber(request.extraParams ?? {}, "distance");
		if (distance !== void 0) filter.distance = distance;
		const nearestCountRaw = request.nearestCount ?? parseExtraNumber(request.extraParams ?? {}, "nearestCount");
		if (nearestCountRaw !== void 0) filter.nearestCount = Math.trunc(nearestCountRaw);
		const returnDistance = request.returnDistance ?? parseExtraBoolean(request.extraParams ?? {}, "returnDistance");
		if (returnDistance !== void 0) filter.returnDistance = returnDistance;
		const unit = request.units ?? parseExtraString(request.extraParams ?? {}, "units");
		if (unit !== void 0) {
			const mappedUnit = ESRI_TO_PROTO_DISTANCE_UNIT_MAP[unit.trim().toLowerCase()];
			if (!mappedUnit) throw new Error(`Unsupported distance unit for gRPC transport: ${unit}`);
			filter.distanceUnit = mappedUnit;
		}
		msg.spatialFilter = filter;
	}
	if (request.extraParams) {
		const returnCountOnly = parseExtraBoolean(request.extraParams, "returnCountOnly");
		if (returnCountOnly !== void 0) msg.returnCountOnly = returnCountOnly;
		const returnIdsOnly = parseExtraBoolean(request.extraParams, "returnIdsOnly");
		if (returnIdsOnly !== void 0) msg.returnIdsOnly = returnIdsOnly;
		const returnExtentOnly = parseExtraBoolean(request.extraParams, "returnExtentOnly");
		if (returnExtentOnly !== void 0) msg.returnExtentOnly = returnExtentOnly;
		const geometryPrecision = parseExtraNumber(request.extraParams, "geometryPrecision");
		if (geometryPrecision !== void 0) msg.geometryPrecision = geometryPrecision;
		const maxAllowableOffset = parseExtraNumber(request.extraParams, "maxAllowableOffset");
		if (maxAllowableOffset !== void 0) msg.maxAllowableOffset = maxAllowableOffset;
	}
	return msg;
}
/**
* Converts a proto QueryFeaturesResponse into the JSON-compatible shape
* matching the `f=json` response format.
*/
function fromProtoQueryResponse(response) {
	const hasFeatureMetadata = response.fields.length > 0 || response.objectIdFieldName.length > 0 || response.geometryType !== GeometryType.UNSPECIFIED || response.spatialReference !== void 0 || response.exceededTransferLimit;
	if (response.features.length === 0 && response.objectIds.length === 0 && response.extent === void 0 && (response.count !== 0n || !hasFeatureMetadata)) return { count: toSafeNumberOrString(response.count) };
	if (isIdsOnlyResponse(response)) return {
		objectIdFieldName: response.objectIdFieldName,
		objectIds: response.objectIds.map(toSafeNumberOrString)
	};
	if (response.extent && response.features.length === 0) {
		const ext = response.extent;
		return {
			extent: {
				xmin: ext.xmin,
				ymin: ext.ymin,
				xmax: ext.xmax,
				ymax: ext.ymax,
				spatialReference: ext.spatialReference ? convertSpatialReference(ext.spatialReference) : void 0
			},
			...response.count !== 0n ? { count: toSafeNumberOrString(response.count) } : {}
		};
	}
	return {
		objectIdFieldName: response.objectIdFieldName,
		geometryType: GEOMETRY_TYPE_MAP[response.geometryType] ?? "esriGeometryPoint",
		spatialReference: response.spatialReference ? convertSpatialReference(response.spatialReference) : void 0,
		fields: response.fields.map(convertField),
		features: response.features.map(convertFeature),
		exceededTransferLimit: response.exceededTransferLimit || void 0
	};
}
function isIdsOnlyResponse(response) {
	if (response.features.length > 0 || response.extent !== void 0) return false;
	if (response.objectIds.length > 0) return true;
	return response.objectIdFieldName.length > 0 && response.fields.length === 0 && response.geometryType === GeometryType.UNSPECIFIED && response.spatialReference === void 0 && response.count === 0n && !response.exceededTransferLimit;
}
function parseExtraBoolean(params, key) {
	const value = params[key];
	if (value === void 0) return;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
}
function parseExtraNumber(params, key) {
	const value = params[key];
	if (value === void 0 || typeof value === "boolean") return;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : void 0;
}
function parseExtraString(params, key) {
	const value = params[key];
	if (value === void 0 || typeof value === "boolean") return;
	return String(value);
}
function toProtoStatistics(value) {
	return (typeof value === "string" ? parseStatisticsString(value) : value).map((item, index) => {
		const statisticTypeValue = item.statisticType;
		if (typeof statisticTypeValue !== "string") throw new Error(`Invalid outStatistics[${index}].statisticType`);
		const statisticType = STATISTIC_TYPE_MAP[statisticTypeValue.toLowerCase()];
		if (!statisticType) throw new Error(`Unsupported statisticType for gRPC transport: ${statisticTypeValue}`);
		const onStatisticFieldValue = item.onStatisticField;
		if (typeof onStatisticFieldValue !== "string" || onStatisticFieldValue.trim().length === 0) throw new Error(`Invalid outStatistics[${index}].onStatisticField`);
		const outStatisticFieldNameValue = item.outStatisticFieldName;
		const outStatisticFieldName = typeof outStatisticFieldNameValue === "string" && outStatisticFieldNameValue.trim().length > 0 ? outStatisticFieldNameValue.trim() : `${statisticTypeValue}_${onStatisticFieldValue}`;
		const definition = create(StatisticDefinitionSchema);
		definition.onStatisticField = onStatisticFieldValue;
		definition.statisticType = statisticType;
		definition.outStatisticFieldName = outStatisticFieldName;
		return definition;
	});
}
function parseStatisticsString(value) {
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Invalid outStatistics JSON for gRPC transport.");
	}
	if (!Array.isArray(parsed)) throw new Error("outStatistics JSON must be an array for gRPC transport.");
	return parsed;
}
function toProtoGeometry(geometryValue) {
	const source = parseGeometryValue(geometryValue);
	const geometry = create(GeometrySchema);
	if (isPoint(source)) {
		const point = create(PointGeometrySchema);
		point.x = source.x;
		point.y = source.y;
		if (typeof source.z === "number" && Number.isFinite(source.z)) point.z = source.z;
		if (typeof source.m === "number" && Number.isFinite(source.m)) point.m = source.m;
		geometry.shape = {
			case: "point",
			value: point
		};
	} else if (isEnvelope(source)) {
		const polygon = create(PolygonGeometrySchema);
		polygon.rings = [toCoordinateSequence([
			[source.xmin, source.ymin],
			[source.xmax, source.ymin],
			[source.xmax, source.ymax],
			[source.xmin, source.ymax],
			[source.xmin, source.ymin]
		])];
		geometry.shape = {
			case: "polygon",
			value: polygon
		};
	} else if (isMultipoint(source)) {
		const multipoint = create(MultiPointGeometrySchema);
		multipoint.points = source.points.map((point, index) => toPointGeometryFromArray(point, `points[${index}]`));
		geometry.shape = {
			case: "multiPoint",
			value: multipoint
		};
	} else if (isPolyline(source)) {
		const polyline = create(PolylineGeometrySchema);
		polyline.paths = source.paths.map((path, index) => toCoordinateSequence(path, `paths[${index}]`));
		geometry.shape = {
			case: "polyline",
			value: polyline
		};
	} else if (isPolygon(source)) {
		const polygon = create(PolygonGeometrySchema);
		polygon.rings = source.rings.map((ring, index) => toCoordinateSequence(ring, `rings[${index}]`));
		geometry.shape = {
			case: "polygon",
			value: polygon
		};
	} else throw new Error("Unsupported geometry shape for gRPC transport.");
	return {
		geometry,
		spatialReference: toProtoSpatialReference(source.spatialReference)
	};
}
function parseGeometryValue(value) {
	if (typeof value === "string") {
		let parsed;
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new Error("Geometry must be a JSON object for gRPC transport.");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Geometry JSON must parse to an object for gRPC transport.");
		return parsed;
	}
	return value;
}
function toProtoSpatialReference(value) {
	if (value === void 0 || value === null) return;
	if (typeof value === "number" && Number.isFinite(value)) {
		const spatialReference = create(SpatialReferenceSchema);
		spatialReference.wkid = value;
		return spatialReference;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return;
		const asNumber = Number(trimmed);
		if (Number.isFinite(asNumber)) {
			const spatialReference = create(SpatialReferenceSchema);
			spatialReference.wkid = asNumber;
			return spatialReference;
		}
		if (trimmed.startsWith("{")) try {
			return toProtoSpatialReference(JSON.parse(trimmed));
		} catch {
			throw new Error("Invalid outSr JSON for gRPC transport.");
		}
		const spatialReference = create(SpatialReferenceSchema);
		spatialReference.wkt = trimmed;
		return spatialReference;
	}
	if (typeof value !== "object" || Array.isArray(value)) return;
	const spatialReference = create(SpatialReferenceSchema);
	const source = value;
	const wkid = source.wkid;
	if (typeof wkid === "number" && Number.isFinite(wkid)) spatialReference.wkid = wkid;
	const latestWkid = source.latestWkid;
	if (typeof latestWkid === "number" && Number.isFinite(latestWkid)) spatialReference.latestWkid = latestWkid;
	const wkt = source.wkt;
	if (typeof wkt === "string" && wkt.length > 0) spatialReference.wkt = wkt;
	if (spatialReference.wkid === 0 && spatialReference.latestWkid === 0 && !spatialReference.wkt) return;
	return spatialReference;
}
function toPointGeometryFromArray(value, context) {
	if (!Array.isArray(value) || value.length < 2) throw new Error(`Invalid coordinate array at ${context}`);
	const x = Number(value[0]);
	const y = Number(value[1]);
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid coordinate values at ${context}`);
	const point = create(PointGeometrySchema);
	point.x = x;
	point.y = y;
	const z = value[2];
	if (typeof z === "number" && Number.isFinite(z)) point.z = z;
	const m = value[3];
	if (typeof m === "number" && Number.isFinite(m)) point.m = m;
	return point;
}
function toCoordinateSequence(value, context = "coords") {
	if (!Array.isArray(value)) throw new Error(`Invalid coordinate sequence at ${context}`);
	const sequence = create(CoordinateSequenceSchema);
	sequence.coords = value.map((coord, index) => toCoordinate(coord, `${context}[${index}]`));
	return sequence;
}
function toCoordinate(value, context) {
	if (!Array.isArray(value) || value.length < 2) throw new Error(`Invalid coordinate at ${context}`);
	const x = Number(value[0]);
	const y = Number(value[1]);
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid coordinate values at ${context}`);
	const coordinate = create(CoordinateSchema);
	coordinate.x = x;
	coordinate.y = y;
	const z = value[2];
	if (typeof z === "number" && Number.isFinite(z)) coordinate.z = z;
	const m = value[3];
	if (typeof m === "number" && Number.isFinite(m)) coordinate.m = m;
	return coordinate;
}
function isPoint(value) {
	return typeof value.x === "number" && typeof value.y === "number";
}
function isEnvelope(value) {
	return typeof value.xmin === "number" && typeof value.ymin === "number" && typeof value.xmax === "number" && typeof value.ymax === "number";
}
function isMultipoint(value) {
	return Array.isArray(value.points);
}
function isPolyline(value) {
	return Array.isArray(value.paths);
}
function isPolygon(value) {
	return Array.isArray(value.rings);
}
/**
* Converts a stream of proto FeaturePages into an async generator
* that yields arrays of JSON-compatible features, matching the
* existing queryFeaturesStream yield type.
*/
async function* streamProtoPages(stream) {
	try {
		for await (const page of stream) {
			if (page.features.length === 0 && page.isLastPage) break;
			const features = page.features.map(convertFeature);
			if (features.length > 0) yield features;
			if (page.isLastPage) break;
		}
	} catch (error) {
		throw wrapConnectError(error);
	}
}
/**
* Wraps a ConnectError (or any error from the gRPC transport) in a
* HonuaGrpcError for consistent `instanceof` discrimination.
*/
function wrapConnectError(error) {
	if (error instanceof Error && "code" in error && typeof error.code === "number") return new HonuaGrpcError(error.code, error.message, "rawMessage" in error ? error.rawMessage : void 0);
	if (error instanceof Error) return error;
	return new Error(String(error));
}
function convertSpatialReference(sr) {
	const result = {};
	if (sr.wkid !== 0) result.wkid = sr.wkid;
	if (sr.latestWkid !== 0) result.latestWkid = sr.latestWkid;
	if (sr.wkt) result.wkt = sr.wkt;
	return result;
}
function convertField(field) {
	return {
		name: field.name,
		type: FIELD_TYPE_MAP[field.fieldType] ?? "esriFieldTypeString",
		alias: field.alias || field.name,
		length: field.length || void 0,
		nullable: field.nullable
	};
}
function convertFeature(feature) {
	const attributes = {};
	for (const [key, attrValue] of Object.entries(feature.attributes)) attributes[key] = convertAttributeValue(attrValue);
	const result = { attributes };
	if (feature.geometry) result.geometry = convertGeometry(feature.geometry);
	return result;
}
function convertAttributeValue(attr) {
	switch (attr.value.case) {
		case "stringValue": return attr.value.value;
		case "int32Value": return attr.value.value;
		case "int64Value": return toSafeNumberOrString(attr.value.value);
		case "doubleValue": return attr.value.value;
		case "floatValue": return attr.value.value;
		case "boolValue": return attr.value.value;
		case "datetimeValue": return toSafeNumberOrString(attr.value.value);
		case "bytesValue": return attr.value.value;
		case "nullValue": return null;
		default: return null;
	}
}
function toSafeNumberOrString(value) {
	if (value <= MAX_SAFE_INTEGER_BIGINT && value >= MIN_SAFE_INTEGER_BIGINT) return Number(value);
	return value.toString();
}
/**
* Builds an Esri-JSON coordinate array from a proto coordinate. Z and M are
* appended only when present, matching `f=json` / PBF output:
*   - `[x, y]`        (2D)
*   - `[x, y, z]`     (Z only)
*   - `[x, y, m]`     (M only — Esri's M-without-Z convention)
*   - `[x, y, z, m]`  (Z and M)
*
* A `NaN` placeholder is never emitted: `JSON.stringify` would serialize it to
* `null`, which is invalid Esri-JSON/GeoJSON and diverges from the other
* transports.
*/
function coordToArray(x, y, z, m) {
	const coords = [x, y];
	if (z !== void 0) coords.push(z);
	if (m !== void 0) coords.push(m);
	return coords;
}
function convertGeometry(geometry) {
	switch (geometry.shape.case) {
		case "point": {
			const p = geometry.shape.value;
			const result = {
				x: p.x,
				y: p.y
			};
			if (p.z !== void 0) result.z = p.z;
			if (p.m !== void 0) result.m = p.m;
			return result;
		}
		case "multiPoint": return { points: geometry.shape.value.points.map((p) => coordToArray(p.x, p.y, p.z, p.m)) };
		case "polyline": return { paths: geometry.shape.value.paths.map((path) => path.coords.map((c) => coordToArray(c.x, c.y, c.z, c.m))) };
		case "polygon": return { rings: geometry.shape.value.rings.map((ring) => ring.coords.map((c) => coordToArray(c.x, c.y, c.z, c.m))) };
		case "multiPolygon": {
			const mpg = geometry.shape.value;
			const rings = [];
			for (const poly of mpg.polygons) for (const ring of poly.rings) rings.push(ring.coords.map((c) => coordToArray(c.x, c.y, c.z, c.m)));
			return { rings };
		}
		default: return null;
	}
}
//#endregion
export { fromProtoQueryResponse, streamProtoPages, toProtoQueryRequest, wrapConnectError };
