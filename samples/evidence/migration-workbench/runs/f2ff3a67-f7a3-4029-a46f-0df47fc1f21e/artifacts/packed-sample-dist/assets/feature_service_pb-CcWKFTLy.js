import { a as messageDesc, t as fileDesc } from "./file-C7ic42ti.js";
//#region node_modules/@bufbuild/protobuf/dist/esm/codegenv2/service.js
/**
* Hydrate a service descriptor.
*
* @private
*/
function serviceDesc(file, path, ...paths) {
	if (paths.length > 0) throw new Error();
	return file.services[path];
}
//#endregion
//#region .tmp/sample-runner/eb988078-d7ea-4867-9f89-7fe0b45ccbee/packed-sdk/extract/package/dist/src/gen/geospatial/v1/common_pb.js
/**
* Describes the file geospatial/v1/common.proto.
*/
var file_geospatial_v1_common = /*@__PURE__*/ fileDesc("ChpnZW9zcGF0aWFsL3YxL2NvbW1vbi5wcm90bxINZ2Vvc3BhdGlhbC52MSKFAgoOQXR0cmlidXRlVmFsdWUSFgoMc3RyaW5nX3ZhbHVlGAEgASgJSAASFQoLaW50MzJfdmFsdWUYAiABKAVIABIVCgtpbnQ2NF92YWx1ZRgDIAEoA0gAEhYKDGRvdWJsZV92YWx1ZRgEIAEoAUgAEhUKC2Zsb2F0X3ZhbHVlGAUgASgCSAASFAoKYm9vbF92YWx1ZRgGIAEoCEgAEhgKDmRhdGV0aW1lX3ZhbHVlGAcgASgDSAASFQoLYnl0ZXNfdmFsdWUYCCABKAxIABIuCgpudWxsX3ZhbHVlGAkgASgOMhguZ2Vvc3BhdGlhbC52MS5OdWxsVmFsdWVIAEIHCgV2YWx1ZSJCChBTcGF0aWFsUmVmZXJlbmNlEgwKBHdraWQYASABKAUSEwoLbGF0ZXN0X3draWQYAiABKAUSCwoDd2t0GAMgASgJIn4KD0ZpZWxkRGVmaW5pdGlvbhIMCgRuYW1lGAEgASgJEiwKCmZpZWxkX3R5cGUYAiABKA4yGC5nZW9zcGF0aWFsLnYxLkZpZWxkVHlwZRIOCgZsZW5ndGgYAyABKAUSEAoIbnVsbGFibGUYBCABKAgSDQoFYWxpYXMYBSABKAkiiQEKE1N0YXRpc3RpY0RlZmluaXRpb24SGgoSb25fc3RhdGlzdGljX2ZpZWxkGAEgASgJEjQKDnN0YXRpc3RpY190eXBlGAIgASgOMhwuZ2Vvc3BhdGlhbC52MS5TdGF0aXN0aWNUeXBlEiAKGG91dF9zdGF0aXN0aWNfZmllbGRfbmFtZRgDIAEoCSJ8CgZFeHRlbnQSDAoEeG1pbhgBIAEoARIMCgR5bWluGAIgASgBEgwKBHhtYXgYAyABKAESDAoEeW1heBgEIAEoARI6ChFzcGF0aWFsX3JlZmVyZW5jZRgFIAEoCzIfLmdlb3NwYXRpYWwudjEuU3BhdGlhbFJlZmVyZW5jZSobCglOdWxsVmFsdWUSDgoKTlVMTF9WQUxVRRAAKtUCCglGaWVsZFR5cGUSGgoWRklFTERfVFlQRV9VTlNQRUNJRklFRBAAEhUKEUZJRUxEX1RZUEVfU1RSSU5HEAESFgoSRklFTERfVFlQRV9JTlRFR0VSEAISGgoWRklFTERfVFlQRV9CSUdfSU5URUdFUhADEhUKEUZJRUxEX1RZUEVfRE9VQkxFEAQSFAoQRklFTERfVFlQRV9GTE9BVBAFEhYKEkZJRUxEX1RZUEVfQk9PTEVBThAGEhgKFEZJRUxEX1RZUEVfREFURV9USU1FEAcSEwoPRklFTERfVFlQRV9EQVRFEAgSEwoPRklFTERfVFlQRV9USU1FEAkSFwoTRklFTERfVFlQRV9HRU9NRVRSWRAKEhMKD0ZJRUxEX1RZUEVfSlNPThALEhUKEUZJRUxEX1RZUEVfQklOQVJZEAwSEwoPRklFTERfVFlQRV9VVUlEEA0qpAIKDEdlb21ldHJ5VHlwZRIdChlHRU9NRVRSWV9UWVBFX1VOU1BFQ0lGSUVEEAASFwoTR0VPTUVUUllfVFlQRV9QT0lOVBABEh0KGUdFT01FVFJZX1RZUEVfTVVMVElfUE9JTlQQAhIdChlHRU9NRVRSWV9UWVBFX0xJTkVfU1RSSU5HEAMSIwofR0VPTUVUUllfVFlQRV9NVUxUSV9MSU5FX1NUUklORxAEEhkKFUdFT01FVFJZX1RZUEVfUE9MWUdPThAFEh8KG0dFT01FVFJZX1RZUEVfTVVMVElfUE9MWUdPThAGEiUKIUdFT01FVFJZX1RZUEVfR0VPTUVUUllfQ09MTEVDVElPThAHEhYKEkdFT01FVFJZX1RZUEVfTk9ORRAIKvwDChNTcGF0aWFsUmVsYXRpb25zaGlwEiQKIFNQQVRJQUxfUkVMQVRJT05TSElQX1VOU1BFQ0lGSUVEEAASIwofU1BBVElBTF9SRUxBVElPTlNISVBfSU5URVJTRUNUUxABEh8KG1NQQVRJQUxfUkVMQVRJT05TSElQX1dJVEhJThACEiEKHVNQQVRJQUxfUkVMQVRJT05TSElQX0NPTlRBSU5TEAMSLAooU1BBVElBTF9SRUxBVElPTlNISVBfRU5WRUxPUEVfSU5URVJTRUNUUxAEEiAKHFNQQVRJQUxfUkVMQVRJT05TSElQX0NST1NTRVMQBRIgChxTUEFUSUFMX1JFTEFUSU9OU0hJUF9UT1VDSEVTEAYSIQodU1BBVElBTF9SRUxBVElPTlNISVBfT1ZFUkxBUFMQBxIhCh1TUEFUSUFMX1JFTEFUSU9OU0hJUF9ESVNKT0lOVBAIEh8KG1NQQVRJQUxfUkVMQVRJT05TSElQX0VRVUFMUxAJEigKJFNQQVRJQUxfUkVMQVRJT05TSElQX1dJVEhJTl9ESVNUQU5DRRAKEigKJFNQQVRJQUxfUkVMQVRJT05TSElQX0JFWU9ORF9ESVNUQU5DRRALEikKJVNQQVRJQUxfUkVMQVRJT05TSElQX05FQVJFU1RfTkVJR0hCT1IQDCqWAQoMRGlzdGFuY2VVbml0Eh0KGURJU1RBTkNFX1VOSVRfVU5TUEVDSUZJRUQQABIYChRESVNUQU5DRV9VTklUX01FVEVSUxABEhYKEkRJU1RBTkNFX1VOSVRfRkVFVBACEhwKGERJU1RBTkNFX1VOSVRfS0lMT01FVEVSUxADEhcKE0RJU1RBTkNFX1VOSVRfTUlMRVMQBCrcAQoNU3RhdGlzdGljVHlwZRIeChpTVEFUSVNUSUNfVFlQRV9VTlNQRUNJRklFRBAAEhgKFFNUQVRJU1RJQ19UWVBFX0NPVU5UEAESFgoSU1RBVElTVElDX1RZUEVfU1VNEAISFgoSU1RBVElTVElDX1RZUEVfTUlOEAMSFgoSU1RBVElTVElDX1RZUEVfTUFYEAQSFgoSU1RBVElTVElDX1RZUEVfQVZHEAUSGQoVU1RBVElTVElDX1RZUEVfU1REREVWEAYSFgoSU1RBVElTVElDX1RZUEVfVkFSEAcqYQoIU2V2ZXJpdHkSGAoUU0VWRVJJVFlfVU5TUEVDSUZJRUQQABIRCg1TRVZFUklUWV9JTkZPEAESFAoQU0VWRVJJVFlfV0FSTklORxACEhIKDlNFVkVSSVRZX0VSUk9SEANiBnByb3RvMw");
/**
* Describes the message geospatial.v1.SpatialReference.
* Use `create(SpatialReferenceSchema)` to create a new message.
*/
var SpatialReferenceSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_common, 1);
/**
* Describes the message geospatial.v1.StatisticDefinition.
* Use `create(StatisticDefinitionSchema)` to create a new message.
*/
var StatisticDefinitionSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_common, 3);
/**
* NullValue represents a null attribute value.
*
* @generated from enum geospatial.v1.NullValue
*/
var NullValue;
(function(NullValue) {
	/**
	* @generated from enum value: NULL_VALUE = 0;
	*/
	NullValue[NullValue["NULL_VALUE"] = 0] = "NULL_VALUE";
})(NullValue || (NullValue = {}));
/**
* FieldType enumerates supported attribute field types.
*
* @generated from enum geospatial.v1.FieldType
*/
var FieldType;
(function(FieldType) {
	/**
	* @generated from enum value: FIELD_TYPE_UNSPECIFIED = 0;
	*/
	FieldType[FieldType["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: FIELD_TYPE_STRING = 1;
	*/
	FieldType[FieldType["STRING"] = 1] = "STRING";
	/**
	* @generated from enum value: FIELD_TYPE_INTEGER = 2;
	*/
	FieldType[FieldType["INTEGER"] = 2] = "INTEGER";
	/**
	* @generated from enum value: FIELD_TYPE_BIG_INTEGER = 3;
	*/
	FieldType[FieldType["BIG_INTEGER"] = 3] = "BIG_INTEGER";
	/**
	* @generated from enum value: FIELD_TYPE_DOUBLE = 4;
	*/
	FieldType[FieldType["DOUBLE"] = 4] = "DOUBLE";
	/**
	* @generated from enum value: FIELD_TYPE_FLOAT = 5;
	*/
	FieldType[FieldType["FLOAT"] = 5] = "FLOAT";
	/**
	* @generated from enum value: FIELD_TYPE_BOOLEAN = 6;
	*/
	FieldType[FieldType["BOOLEAN"] = 6] = "BOOLEAN";
	/**
	* @generated from enum value: FIELD_TYPE_DATE_TIME = 7;
	*/
	FieldType[FieldType["DATE_TIME"] = 7] = "DATE_TIME";
	/**
	* @generated from enum value: FIELD_TYPE_DATE = 8;
	*/
	FieldType[FieldType["DATE"] = 8] = "DATE";
	/**
	* @generated from enum value: FIELD_TYPE_TIME = 9;
	*/
	FieldType[FieldType["TIME"] = 9] = "TIME";
	/**
	* @generated from enum value: FIELD_TYPE_GEOMETRY = 10;
	*/
	FieldType[FieldType["GEOMETRY"] = 10] = "GEOMETRY";
	/**
	* @generated from enum value: FIELD_TYPE_JSON = 11;
	*/
	FieldType[FieldType["JSON"] = 11] = "JSON";
	/**
	* @generated from enum value: FIELD_TYPE_BINARY = 12;
	*/
	FieldType[FieldType["BINARY"] = 12] = "BINARY";
	/**
	* @generated from enum value: FIELD_TYPE_UUID = 13;
	*/
	FieldType[FieldType["UUID"] = 13] = "UUID";
})(FieldType || (FieldType = {}));
/**
* GeometryType enumerates supported geometry types.
*
* @generated from enum geospatial.v1.GeometryType
*/
var GeometryType;
(function(GeometryType) {
	/**
	* @generated from enum value: GEOMETRY_TYPE_UNSPECIFIED = 0;
	*/
	GeometryType[GeometryType["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: GEOMETRY_TYPE_POINT = 1;
	*/
	GeometryType[GeometryType["POINT"] = 1] = "POINT";
	/**
	* @generated from enum value: GEOMETRY_TYPE_MULTI_POINT = 2;
	*/
	GeometryType[GeometryType["MULTI_POINT"] = 2] = "MULTI_POINT";
	/**
	* @generated from enum value: GEOMETRY_TYPE_LINE_STRING = 3;
	*/
	GeometryType[GeometryType["LINE_STRING"] = 3] = "LINE_STRING";
	/**
	* @generated from enum value: GEOMETRY_TYPE_MULTI_LINE_STRING = 4;
	*/
	GeometryType[GeometryType["MULTI_LINE_STRING"] = 4] = "MULTI_LINE_STRING";
	/**
	* @generated from enum value: GEOMETRY_TYPE_POLYGON = 5;
	*/
	GeometryType[GeometryType["POLYGON"] = 5] = "POLYGON";
	/**
	* @generated from enum value: GEOMETRY_TYPE_MULTI_POLYGON = 6;
	*/
	GeometryType[GeometryType["MULTI_POLYGON"] = 6] = "MULTI_POLYGON";
	/**
	* @generated from enum value: GEOMETRY_TYPE_GEOMETRY_COLLECTION = 7;
	*/
	GeometryType[GeometryType["GEOMETRY_COLLECTION"] = 7] = "GEOMETRY_COLLECTION";
	/**
	* @generated from enum value: GEOMETRY_TYPE_NONE = 8;
	*/
	GeometryType[GeometryType["NONE"] = 8] = "NONE";
})(GeometryType || (GeometryType = {}));
/**
* SpatialRelationship enumerates spatial relationship types for filtering.
*
* @generated from enum geospatial.v1.SpatialRelationship
*/
var SpatialRelationship;
(function(SpatialRelationship) {
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_UNSPECIFIED = 0;
	*/
	SpatialRelationship[SpatialRelationship["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_INTERSECTS = 1;
	*/
	SpatialRelationship[SpatialRelationship["INTERSECTS"] = 1] = "INTERSECTS";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_WITHIN = 2;
	*/
	SpatialRelationship[SpatialRelationship["WITHIN"] = 2] = "WITHIN";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_CONTAINS = 3;
	*/
	SpatialRelationship[SpatialRelationship["CONTAINS"] = 3] = "CONTAINS";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_ENVELOPE_INTERSECTS = 4;
	*/
	SpatialRelationship[SpatialRelationship["ENVELOPE_INTERSECTS"] = 4] = "ENVELOPE_INTERSECTS";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_CROSSES = 5;
	*/
	SpatialRelationship[SpatialRelationship["CROSSES"] = 5] = "CROSSES";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_TOUCHES = 6;
	*/
	SpatialRelationship[SpatialRelationship["TOUCHES"] = 6] = "TOUCHES";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_OVERLAPS = 7;
	*/
	SpatialRelationship[SpatialRelationship["OVERLAPS"] = 7] = "OVERLAPS";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_DISJOINT = 8;
	*/
	SpatialRelationship[SpatialRelationship["DISJOINT"] = 8] = "DISJOINT";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_EQUALS = 9;
	*/
	SpatialRelationship[SpatialRelationship["EQUALS"] = 9] = "EQUALS";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_WITHIN_DISTANCE = 10;
	*/
	SpatialRelationship[SpatialRelationship["WITHIN_DISTANCE"] = 10] = "WITHIN_DISTANCE";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_BEYOND_DISTANCE = 11;
	*/
	SpatialRelationship[SpatialRelationship["BEYOND_DISTANCE"] = 11] = "BEYOND_DISTANCE";
	/**
	* @generated from enum value: SPATIAL_RELATIONSHIP_NEAREST_NEIGHBOR = 12;
	*/
	SpatialRelationship[SpatialRelationship["NEAREST_NEIGHBOR"] = 12] = "NEAREST_NEIGHBOR";
})(SpatialRelationship || (SpatialRelationship = {}));
/**
* DistanceUnit enumerates supported distance measurement units.
*
* @generated from enum geospatial.v1.DistanceUnit
*/
var DistanceUnit;
(function(DistanceUnit) {
	/**
	* @generated from enum value: DISTANCE_UNIT_UNSPECIFIED = 0;
	*/
	DistanceUnit[DistanceUnit["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: DISTANCE_UNIT_METERS = 1;
	*/
	DistanceUnit[DistanceUnit["METERS"] = 1] = "METERS";
	/**
	* @generated from enum value: DISTANCE_UNIT_FEET = 2;
	*/
	DistanceUnit[DistanceUnit["FEET"] = 2] = "FEET";
	/**
	* @generated from enum value: DISTANCE_UNIT_KILOMETERS = 3;
	*/
	DistanceUnit[DistanceUnit["KILOMETERS"] = 3] = "KILOMETERS";
	/**
	* @generated from enum value: DISTANCE_UNIT_MILES = 4;
	*/
	DistanceUnit[DistanceUnit["MILES"] = 4] = "MILES";
})(DistanceUnit || (DistanceUnit = {}));
/**
* StatisticType enumerates supported aggregate functions.
*
* @generated from enum geospatial.v1.StatisticType
*/
var StatisticType;
(function(StatisticType) {
	/**
	* @generated from enum value: STATISTIC_TYPE_UNSPECIFIED = 0;
	*/
	StatisticType[StatisticType["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: STATISTIC_TYPE_COUNT = 1;
	*/
	StatisticType[StatisticType["COUNT"] = 1] = "COUNT";
	/**
	* @generated from enum value: STATISTIC_TYPE_SUM = 2;
	*/
	StatisticType[StatisticType["SUM"] = 2] = "SUM";
	/**
	* @generated from enum value: STATISTIC_TYPE_MIN = 3;
	*/
	StatisticType[StatisticType["MIN"] = 3] = "MIN";
	/**
	* @generated from enum value: STATISTIC_TYPE_MAX = 4;
	*/
	StatisticType[StatisticType["MAX"] = 4] = "MAX";
	/**
	* @generated from enum value: STATISTIC_TYPE_AVG = 5;
	*/
	StatisticType[StatisticType["AVG"] = 5] = "AVG";
	/**
	* @generated from enum value: STATISTIC_TYPE_STDDEV = 6;
	*/
	StatisticType[StatisticType["STDDEV"] = 6] = "STDDEV";
	/**
	* @generated from enum value: STATISTIC_TYPE_VAR = 7;
	*/
	StatisticType[StatisticType["VAR"] = 7] = "VAR";
})(StatisticType || (StatisticType = {}));
/**
* Severity is the canonical severity classification shared across the protocol
* (validation issues, diagnostics, quality findings). Values are ordered
* ascending by seriousness so that a numeric comparison or cast preserves the
* INFO < WARNING < ERROR relationship.
*
* @generated from enum geospatial.v1.Severity
*/
var Severity;
(function(Severity) {
	/**
	* @generated from enum value: SEVERITY_UNSPECIFIED = 0;
	*/
	Severity[Severity["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: SEVERITY_INFO = 1;
	*/
	Severity[Severity["INFO"] = 1] = "INFO";
	/**
	* @generated from enum value: SEVERITY_WARNING = 2;
	*/
	Severity[Severity["WARNING"] = 2] = "WARNING";
	/**
	* @generated from enum value: SEVERITY_ERROR = 3;
	*/
	Severity[Severity["ERROR"] = 3] = "ERROR";
})(Severity || (Severity = {}));
//#endregion
//#region .tmp/sample-runner/eb988078-d7ea-4867-9f89-7fe0b45ccbee/packed-sdk/extract/package/dist/src/gen/geospatial/v1/spatial_types_pb.js
/**
* Describes the file geospatial/v1/spatial_types.proto.
*/
var file_geospatial_v1_spatial_types = /*@__PURE__*/ fileDesc("CiFnZW9zcGF0aWFsL3YxL3NwYXRpYWxfdHlwZXMucHJvdG8SDWdlb3NwYXRpYWwudjEiogIKCEdlb21ldHJ5Ei0KBXBvaW50GAEgASgLMhwuZ2Vvc3BhdGlhbC52MS5Qb2ludEdlb21ldHJ5SAASOAoLbXVsdGlfcG9pbnQYAiABKAsyIS5nZW9zcGF0aWFsLnYxLk11bHRpUG9pbnRHZW9tZXRyeUgAEjMKCHBvbHlsaW5lGAMgASgLMh8uZ2Vvc3BhdGlhbC52MS5Qb2x5bGluZUdlb21ldHJ5SAASMQoHcG9seWdvbhgEIAEoCzIeLmdlb3NwYXRpYWwudjEuUG9seWdvbkdlb21ldHJ5SAASPAoNbXVsdGlfcG9seWdvbhgFIAEoCzIjLmdlb3NwYXRpYWwudjEuTXVsdGlQb2x5Z29uR2VvbWV0cnlIAEIHCgVzaGFwZSJRCg1Qb2ludEdlb21ldHJ5EgkKAXgYASABKAESCQoBeRgCIAEoARIOCgF6GAMgASgBSACIAQESDgoBbRgEIAEoAUgBiAEBQgQKAl96QgQKAl9tIkIKEk11bHRpUG9pbnRHZW9tZXRyeRIsCgZwb2ludHMYASADKAsyHC5nZW9zcGF0aWFsLnYxLlBvaW50R2VvbWV0cnkiTgoKQ29vcmRpbmF0ZRIJCgF4GAEgASgBEgkKAXkYAiABKAESDgoBehgDIAEoAUgAiAEBEg4KAW0YBCABKAFIAYgBAUIECgJfekIECgJfbSI/ChJDb29yZGluYXRlU2VxdWVuY2USKQoGY29vcmRzGAEgAygLMhkuZ2Vvc3BhdGlhbC52MS5Db29yZGluYXRlIkQKEFBvbHlsaW5lR2VvbWV0cnkSMAoFcGF0aHMYASADKAsyIS5nZW9zcGF0aWFsLnYxLkNvb3JkaW5hdGVTZXF1ZW5jZSJDCg9Qb2x5Z29uR2VvbWV0cnkSMAoFcmluZ3MYASADKAsyIS5nZW9zcGF0aWFsLnYxLkNvb3JkaW5hdGVTZXF1ZW5jZSJIChRNdWx0aVBvbHlnb25HZW9tZXRyeRIwCghwb2x5Z29ucxgBIAMoCzIeLmdlb3NwYXRpYWwudjEuUG9seWdvbkdlb21ldHJ5Iq4CCg1TcGF0aWFsRmlsdGVyEikKCGdlb21ldHJ5GAEgASgLMhcuZ2Vvc3BhdGlhbC52MS5HZW9tZXRyeRJAChRzcGF0aWFsX3JlbGF0aW9uc2hpcBgCIAEoDjIiLmdlb3NwYXRpYWwudjEuU3BhdGlhbFJlbGF0aW9uc2hpcBI6ChFzcGF0aWFsX3JlZmVyZW5jZRgDIAEoCzIfLmdlb3NwYXRpYWwudjEuU3BhdGlhbFJlZmVyZW5jZRIQCghkaXN0YW5jZRgEIAEoARIyCg1kaXN0YW5jZV91bml0GAUgASgOMhsuZ2Vvc3BhdGlhbC52MS5EaXN0YW5jZVVuaXQSFQoNbmVhcmVzdF9jb3VudBgGIAEoBRIXCg9yZXR1cm5fZGlzdGFuY2UYByABKAgizgEKB0ZlYXR1cmUSCgoCaWQYASABKAMSOgoKYXR0cmlidXRlcxgCIAMoCzImLmdlb3NwYXRpYWwudjEuRmVhdHVyZS5BdHRyaWJ1dGVzRW50cnkSKQoIZ2VvbWV0cnkYAyABKAsyFy5nZW9zcGF0aWFsLnYxLkdlb21ldHJ5GlAKD0F0dHJpYnV0ZXNFbnRyeRILCgNrZXkYASABKAkSLAoFdmFsdWUYAiABKAsyHS5nZW9zcGF0aWFsLnYxLkF0dHJpYnV0ZVZhbHVlOgI4AWIGcHJvdG8z", [file_geospatial_v1_common]);
/**
* Describes the message geospatial.v1.Geometry.
* Use `create(GeometrySchema)` to create a new message.
*/
var GeometrySchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_spatial_types, 0);
/**
* Describes the message geospatial.v1.PointGeometry.
* Use `create(PointGeometrySchema)` to create a new message.
*/
var PointGeometrySchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_spatial_types, 1);
/**
* Describes the message geospatial.v1.MultiPointGeometry.
* Use `create(MultiPointGeometrySchema)` to create a new message.
*/
var MultiPointGeometrySchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_spatial_types, 2);
/**
* Describes the message geospatial.v1.Coordinate.
* Use `create(CoordinateSchema)` to create a new message.
*/
var CoordinateSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_spatial_types, 3);
/**
* Describes the message geospatial.v1.CoordinateSequence.
* Use `create(CoordinateSequenceSchema)` to create a new message.
*/
var CoordinateSequenceSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_spatial_types, 4);
/**
* Describes the message geospatial.v1.PolylineGeometry.
* Use `create(PolylineGeometrySchema)` to create a new message.
*/
var PolylineGeometrySchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_spatial_types, 5);
/**
* Describes the message geospatial.v1.PolygonGeometry.
* Use `create(PolygonGeometrySchema)` to create a new message.
*/
var PolygonGeometrySchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_spatial_types, 6);
/**
* Describes the message geospatial.v1.SpatialFilter.
* Use `create(SpatialFilterSchema)` to create a new message.
*/
var SpatialFilterSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_spatial_types, 8);
//#endregion
//#region .tmp/sample-runner/eb988078-d7ea-4867-9f89-7fe0b45ccbee/packed-sdk/extract/package/dist/src/gen/geospatial/v1/workspace_artifact_types_pb.js
/**
* Describes the file geospatial/v1/workspace_artifact_types.proto.
*/
var file_geospatial_v1_workspace_artifact_types = /*@__PURE__*/ fileDesc("CixnZW9zcGF0aWFsL3YxL3dvcmtzcGFjZV9hcnRpZmFjdF90eXBlcy5wcm90bxINZ2Vvc3BhdGlhbC52MSJVCgxXb3Jrc3BhY2VSZWYSFAoMd29ya3NwYWNlX2lkGAEgASgJEhoKEndvcmtzcGFjZV9yZXZpc2lvbhgCIAEoCRITCgtzY29wZV90b2tlbhgDIAEoCSJUChJSZXRlbnRpb25Qb2xpY3lSZWYSGwoTcmV0ZW50aW9uX3BvbGljeV9pZBgBIAEoCRIhChlyZXRlbnRpb25fcG9saWN5X3JldmlzaW9uGAIgASgJImkKCVF1b3RhU3BlYxIRCgltYXhfYnl0ZXMYASABKAMSFQoNbWF4X2FydGlmYWN0cxgCIAEoAxIYChBzb2Z0X3R0bF9zZWNvbmRzGAMgASgDEhgKEGhhcmRfdHRsX3NlY29uZHMYBCABKAMibgoKUXVvdGFVc2FnZRISCgp1c2VkX2J5dGVzGAEgASgDEhYKDnVzZWRfYXJ0aWZhY3RzGAIgASgDEhcKD2J5dGVzX2F2YWlsYWJsZRgDIAEoAxIbChNhcnRpZmFjdHNfYXZhaWxhYmxlGAQgASgDIrUCCg9SZXRlbnRpb25Qb2xpY3kSLgoDcmVmGAEgASgLMiEuZ2Vvc3BhdGlhbC52MS5SZXRlbnRpb25Qb2xpY3lSZWYSFAoMZGlzcGxheV9uYW1lGAIgASgJEh0KFW1pbl9yZXRlbnRpb25fc2Vjb25kcxgDIAEoAxIdChVtYXhfcmV0ZW50aW9uX3NlY29uZHMYBCABKAMSHwoXaW1tdXRhYmxlX2FmdGVyX3B1Ymxpc2gYBSABKAgSEgoKbGVnYWxfaG9sZBgGIAEoCBI6CgZsYWJlbHMYByADKAsyKi5nZW9zcGF0aWFsLnYxLlJldGVudGlvblBvbGljeS5MYWJlbHNFbnRyeRotCgtMYWJlbHNFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBIsAECglXb3Jrc3BhY2USKAoDcmVmGAEgASgLMhsuZ2Vvc3BhdGlhbC52MS5Xb3Jrc3BhY2VSZWYSNAoJbGlmZWN5Y2xlGAIgASgOMiEuZ2Vvc3BhdGlhbC52MS5Xb3Jrc3BhY2VMaWZlY3ljbGUSNgoPcHJvbW90aW9uX3N0YWdlGAMgASgOMh0uZ2Vvc3BhdGlhbC52MS5Qcm9tb3Rpb25TdGFnZRInCgVxdW90YRgEIAEoCzIYLmdlb3NwYXRpYWwudjEuUXVvdGFTcGVjEigKBXVzYWdlGAUgASgLMhkuZ2Vvc3BhdGlhbC52MS5RdW90YVVzYWdlEjwKEWRlZmF1bHRfcmV0ZW50aW9uGAYgASgLMiEuZ2Vvc3BhdGlhbC52MS5SZXRlbnRpb25Qb2xpY3lSZWYSEgoKY3JlYXRlZF9hdBgHIAEoAxISCgp1cGRhdGVkX2F0GAggASgDEhIKCmV4cGlyZXNfYXQYCSABKAMSNAoGbGFiZWxzGAogAygLMiQuZ2Vvc3BhdGlhbC52MS5Xb3Jrc3BhY2UuTGFiZWxzRW50cnkSOAoIbWV0YWRhdGEYCyADKAsyJi5nZW9zcGF0aWFsLnYxLldvcmtzcGFjZS5NZXRhZGF0YUVudHJ5Gi0KC0xhYmVsc0VudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoCToCOAEaLwoNTWV0YWRhdGFFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBKv8BChJXb3Jrc3BhY2VMaWZlY3ljbGUSIwofV09SS1NQQUNFX0xJRkVDWUNMRV9VTlNQRUNJRklFRBAAEh0KGVdPUktTUEFDRV9MSUZFQ1lDTEVfRFJBRlQQARIeChpXT1JLU1BBQ0VfTElGRUNZQ0xFX0FDVElWRRACEiAKHFdPUktTUEFDRV9MSUZFQ1lDTEVfUFJPTU9URUQQAxIgChxXT1JLU1BBQ0VfTElGRUNZQ0xFX1JFVEFJTkVEEAQSIAocV09SS1NQQUNFX0xJRkVDWUNMRV9SRUxFQVNFRBAFEh8KG1dPUktTUEFDRV9MSUZFQ1lDTEVfRVhQSVJFRBAGKsMBCg5Qcm9tb3Rpb25TdGFnZRIfChtQUk9NT1RJT05fU1RBR0VfVU5TUEVDSUZJRUQQABIZChVQUk9NT1RJT05fU1RBR0VfRFJBRlQQARIaChZQUk9NT1RJT05fU1RBR0VfUkVWSUVXEAISGwoXUFJPTU9USU9OX1NUQUdFX1NUQUdJTkcQAxIeChpQUk9NT1RJT05fU1RBR0VfUFJPRFVDVElPThAEEhwKGFBST01PVElPTl9TVEFHRV9BUkNISVZFRBAFKvYBChRNYXRlcmlhbGl6YXRpb25TdGF0ZRIlCiFNQVRFUklBTElaQVRJT05fU1RBVEVfVU5TUEVDSUZJRUQQABIhCh1NQVRFUklBTElaQVRJT05fU1RBVEVfUEVORElORxABEicKI01BVEVSSUFMSVpBVElPTl9TVEFURV9NQVRFUklBTElaSU5HEAISJgoiTUFURVJJQUxJWkFUSU9OX1NUQVRFX01BVEVSSUFMSVpFRBADEiEKHU1BVEVSSUFMSVpBVElPTl9TVEFURV9FWFBJUkVEEAQSIAocTUFURVJJQUxJWkFUSU9OX1NUQVRFX0ZBSUxFRBAFYgZwcm90bzM");
/**
* WorkspaceLifecycle classifies the lifecycle state of a workspace.
*
* @generated from enum geospatial.v1.WorkspaceLifecycle
*/
var WorkspaceLifecycle;
(function(WorkspaceLifecycle) {
	/**
	* @generated from enum value: WORKSPACE_LIFECYCLE_UNSPECIFIED = 0;
	*/
	WorkspaceLifecycle[WorkspaceLifecycle["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: WORKSPACE_LIFECYCLE_DRAFT = 1;
	*/
	WorkspaceLifecycle[WorkspaceLifecycle["DRAFT"] = 1] = "DRAFT";
	/**
	* @generated from enum value: WORKSPACE_LIFECYCLE_ACTIVE = 2;
	*/
	WorkspaceLifecycle[WorkspaceLifecycle["ACTIVE"] = 2] = "ACTIVE";
	/**
	* @generated from enum value: WORKSPACE_LIFECYCLE_PROMOTED = 3;
	*/
	WorkspaceLifecycle[WorkspaceLifecycle["PROMOTED"] = 3] = "PROMOTED";
	/**
	* @generated from enum value: WORKSPACE_LIFECYCLE_RETAINED = 4;
	*/
	WorkspaceLifecycle[WorkspaceLifecycle["RETAINED"] = 4] = "RETAINED";
	/**
	* @generated from enum value: WORKSPACE_LIFECYCLE_RELEASED = 5;
	*/
	WorkspaceLifecycle[WorkspaceLifecycle["RELEASED"] = 5] = "RELEASED";
	/**
	* @generated from enum value: WORKSPACE_LIFECYCLE_EXPIRED = 6;
	*/
	WorkspaceLifecycle[WorkspaceLifecycle["EXPIRED"] = 6] = "EXPIRED";
})(WorkspaceLifecycle || (WorkspaceLifecycle = {}));
/**
* PromotionStage classifies the environment-tier stage a workspace is
* promoted into. Stages are ordered from least to most durable.
*
* @generated from enum geospatial.v1.PromotionStage
*/
var PromotionStage;
(function(PromotionStage) {
	/**
	* @generated from enum value: PROMOTION_STAGE_UNSPECIFIED = 0;
	*/
	PromotionStage[PromotionStage["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: PROMOTION_STAGE_DRAFT = 1;
	*/
	PromotionStage[PromotionStage["DRAFT"] = 1] = "DRAFT";
	/**
	* @generated from enum value: PROMOTION_STAGE_REVIEW = 2;
	*/
	PromotionStage[PromotionStage["REVIEW"] = 2] = "REVIEW";
	/**
	* @generated from enum value: PROMOTION_STAGE_STAGING = 3;
	*/
	PromotionStage[PromotionStage["STAGING"] = 3] = "STAGING";
	/**
	* @generated from enum value: PROMOTION_STAGE_PRODUCTION = 4;
	*/
	PromotionStage[PromotionStage["PRODUCTION"] = 4] = "PRODUCTION";
	/**
	* @generated from enum value: PROMOTION_STAGE_ARCHIVED = 5;
	*/
	PromotionStage[PromotionStage["ARCHIVED"] = 5] = "ARCHIVED";
})(PromotionStage || (PromotionStage = {}));
/**
* MaterializationState reports whether artifact bytes are actually resident
* in the workspace's storage backend.
*
* @generated from enum geospatial.v1.MaterializationState
*/
var MaterializationState;
(function(MaterializationState) {
	/**
	* @generated from enum value: MATERIALIZATION_STATE_UNSPECIFIED = 0;
	*/
	MaterializationState[MaterializationState["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: MATERIALIZATION_STATE_PENDING = 1;
	*/
	MaterializationState[MaterializationState["PENDING"] = 1] = "PENDING";
	/**
	* @generated from enum value: MATERIALIZATION_STATE_MATERIALIZING = 2;
	*/
	MaterializationState[MaterializationState["MATERIALIZING"] = 2] = "MATERIALIZING";
	/**
	* @generated from enum value: MATERIALIZATION_STATE_MATERIALIZED = 3;
	*/
	MaterializationState[MaterializationState["MATERIALIZED"] = 3] = "MATERIALIZED";
	/**
	* @generated from enum value: MATERIALIZATION_STATE_EXPIRED = 4;
	*/
	MaterializationState[MaterializationState["EXPIRED"] = 4] = "EXPIRED";
	/**
	* @generated from enum value: MATERIALIZATION_STATE_FAILED = 5;
	*/
	MaterializationState[MaterializationState["FAILED"] = 5] = "FAILED";
})(MaterializationState || (MaterializationState = {}));
//#endregion
//#region .tmp/sample-runner/eb988078-d7ea-4867-9f89-7fe0b45ccbee/packed-sdk/extract/package/dist/src/gen/geospatial/v1/execution_types_pb.js
/**
* Describes the file geospatial/v1/execution_types.proto.
*/
var file_geospatial_v1_execution_types = /*@__PURE__*/ fileDesc("CiNnZW9zcGF0aWFsL3YxL2V4ZWN1dGlvbl90eXBlcy5wcm90bxINZ2Vvc3BhdGlhbC52MSKwAQoNRXhlY3V0aW9uUGxhbhIPCgdwbGFuX2lkGAEgASgJEhQKDHNwZWNfdmVyc2lvbhgCIAEoCRI2Cg93b3JrZmxvd19mYW1pbHkYAyABKA4yHS5nZW9zcGF0aWFsLnYxLldvcmtmbG93RmFtaWx5EiYKBXN0ZXBzGAQgAygLMhcuZ2Vvc3BhdGlhbC52MS5QbGFuU3RlcBIYChBleHBlY3RlZF9vdXRwdXRzGAUgAygJIsIBCghQbGFuU3RlcBIPCgdzdGVwX2lkGAEgASgJEgwKBGtpbmQYAiABKAkSMwoGaW5wdXRzGAMgAygLMiMuZ2Vvc3BhdGlhbC52MS5QbGFuU3RlcC5JbnB1dHNFbnRyeRIUCgxkZXBlbmRlbmNpZXMYBCADKAkaTAoLSW5wdXRzRW50cnkSCwoDa2V5GAEgASgJEiwKBXZhbHVlGAIgASgLMh0uZ2Vvc3BhdGlhbC52MS5QYXJhbWV0ZXJWYWx1ZToCOAEi7gIKC0Vycm9yRGV0YWlsEgwKBGNvZGUYASABKAUSDwoHbWVzc2FnZRgCIAEoCRI4CgdkZXRhaWxzGAMgAygLMicuZ2Vvc3BhdGlhbC52MS5FcnJvckRldGFpbC5EZXRhaWxzRW50cnkSLgoIY2F0ZWdvcnkYBCABKA4yHC5nZW9zcGF0aWFsLnYxLkVycm9yQ2F0ZWdvcnkSDQoFcGhhc2UYBSABKAkSDwoHbm9kZV9pZBgGIAEoCRIxCgxyZXRyeWFiaWxpdHkYByABKA4yGy5nZW9zcGF0aWFsLnYxLlJldHJ5YWJpbGl0eRIYChBzdWdnZXN0ZWRfYWN0aW9uGAggASgJEikKCHNldmVyaXR5GAkgASgOMhcuZ2Vvc3BhdGlhbC52MS5TZXZlcml0eRIOCgZyZW1lZHkYCiABKAkaLgoMRGV0YWlsc0VudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoCToCOAEijAMKC0FydGlmYWN0UmVmEhMKC2FydGlmYWN0X2lkGAEgASgJEjQKDmFydGlmYWN0X2NsYXNzGAIgASgOMhwuZ2Vvc3BhdGlhbC52MS5BcnRpZmFjdENsYXNzEhgKEGFydGlmYWN0X3ZlcnNpb24YAyABKAUSFAoMcHJvZHVjZXJfcmVmGAQgASgJEhkKDXdvcmtzcGFjZV9yZWYYBSABKAlCAhgBEiAKFHJldGVudGlvbl9wb2xpY3lfcmVmGAYgASgJQgIYARIhChVtYXRlcmlhbGl6YXRpb25fc3RhdGUYByABKAlCAhgBEi4KCXdvcmtzcGFjZRgIIAEoCzIbLmdlb3NwYXRpYWwudjEuV29ya3NwYWNlUmVmEjQKCXJldGVudGlvbhgJIAEoCzIhLmdlb3NwYXRpYWwudjEuUmV0ZW50aW9uUG9saWN5UmVmEjwKD21hdGVyaWFsaXphdGlvbhgKIAEoDjIjLmdlb3NwYXRpYWwudjEuTWF0ZXJpYWxpemF0aW9uU3RhdGUifAoRRXN0aW1hdGVkQXJ0aWZhY3QSNAoOYXJ0aWZhY3RfY2xhc3MYASABKA4yHC5nZW9zcGF0aWFsLnYxLkFydGlmYWN0Q2xhc3MSHAoUZXN0aW1hdGVkX3NpemVfYnl0ZXMYAiABKAMSEwoLZGVzY3JpcHRpb24YAyABKAkiRgoKU2lkZUVmZmVjdBITCgtlZmZlY3RfdHlwZRgBIAEoCRIOCgZ0YXJnZXQYAiABKAkSEwoLZGVzY3JpcHRpb24YAyABKAkiLQoMQ29zdEVzdGltYXRlEg0KBXVuaXRzGAEgASgJEg4KBmFtb3VudBgCIAEoASLtAgoMRHJ5UnVuUmVzdWx0EiIKGmVzdGltYXRlZF9kdXJhdGlvbl9zZWNvbmRzGAEgASgDEj0KE2VzdGltYXRlZF9hcnRpZmFjdHMYAiADKAsyIC5nZW9zcGF0aWFsLnYxLkVzdGltYXRlZEFydGlmYWN0Ei8KDHNpZGVfZWZmZWN0cxgDIAMoCzIZLmdlb3NwYXRpYWwudjEuU2lkZUVmZmVjdBIyCg1jb3N0X2VzdGltYXRlGAQgASgLMhsuZ2Vvc3BhdGlhbC52MS5Db3N0RXN0aW1hdGUSFgoOZXN0aW1hdGVkX3Jvd3MYBSABKAMSFwoPZXN0aW1hdGVkX2J5dGVzGAYgASgDEh0KFWVzdGltYXRlZF9kdXJhdGlvbl9tcxgHIAEoARITCgthY3R1YWxfcm93cxgIIAEoAxIUCgxhY3R1YWxfYnl0ZXMYCSABKAMSGgoSYWN0dWFsX2R1cmF0aW9uX21zGAogASgBIrEBCgtKb2JQcm9ncmVzcxIOCgZqb2JfaWQYASABKAkSJgoFc3RhdGUYAiABKA4yFy5nZW9zcGF0aWFsLnYxLkpvYlN0YXRlEhgKEHByb2dyZXNzX3BlcmNlbnQYAyABKAUSFwoPY3VycmVudF9ub2RlX2lkGAQgASgJEhIKCnN0YXJ0ZWRfYXQYBSABKAMSEgoKdXBkYXRlZF9hdBgGIAEoAxIPCgdtZXNzYWdlGAcgASgJIqoBCgtTdGFnZVJlc3VsdBIPCgdub2RlX2lkGAEgASgJEigKBXN0YXRlGAIgASgOMhkuZ2Vvc3BhdGlhbC52MS5TdGFnZVN0YXRlEikKBWVycm9yGAMgASgLMhouZ2Vvc3BhdGlhbC52MS5FcnJvckRldGFpbBI1ChFwYXJ0aWFsX2FydGlmYWN0cxgEIAMoCzIaLmdlb3NwYXRpYWwudjEuQXJ0aWZhY3RSZWYicQoTUGxhblZhbGlkYXRpb25Jc3N1ZRIPCgdub2RlX2lkGAEgASgJEg0KBWZpZWxkGAIgASgJEg8KB21lc3NhZ2UYAyABKAkSKQoIc2V2ZXJpdHkYBCABKA4yFy5nZW9zcGF0aWFsLnYxLlNldmVyaXR5ImMKCkFzc3VtcHRpb24SFQoNYXNzdW1wdGlvbl9pZBgBIAEoCRITCgtkZXNjcmlwdGlvbhgCIAEoCRIRCglyYXRpb25hbGUYAyABKAkSFgoOdXNlcl9jb25maXJtZWQYBCABKAgirwEKEFByb3ZlbmFuY2VSZWNvcmQSGwoTc291cmNlX2RhdGFzZXRfcmVmcxgBIAMoCRIfChdwcm9jZXNzX2RlZmluaXRpb25fcmVmcxgCIAMoCRIuCgthc3N1bXB0aW9ucxgDIAMoCzIZLmdlb3NwYXRpYWwudjEuQXNzdW1wdGlvbhITCgtleGVjdXRlZF9hdBgEIAEoAxIYChBkdXJhdGlvbl9zZWNvbmRzGAUgASgDIpgECg5QYXJhbWV0ZXJWYWx1ZRIWCgxzdHJpbmdfdmFsdWUYASABKAlIABIVCgtpbnQ2NF92YWx1ZRgCIAEoA0gAEhYKDGRvdWJsZV92YWx1ZRgDIAEoAUgAEhQKCmJvb2xfdmFsdWUYBCABKAhIABIVCgtieXRlc192YWx1ZRgFIAEoDEgAEjIKCmxpc3RfdmFsdWUYBiABKAsyHC5nZW9zcGF0aWFsLnYxLlBhcmFtZXRlckxpc3RIABIzCgxzdHJ1Y3RfdmFsdWUYByABKAsyGy5nZW9zcGF0aWFsLnYxLlBhcmFtZXRlck1hcEgAEjwKFHNwYXRpYWxfZmlsdGVyX3ZhbHVlGAggASgLMhwuZ2Vvc3BhdGlhbC52MS5TcGF0aWFsRmlsdGVySAASQgoXc3BhdGlhbF9yZWZlcmVuY2VfdmFsdWUYCSABKAsyHy5nZW9zcGF0aWFsLnYxLlNwYXRpYWxSZWZlcmVuY2VIABIxCg5nZW9tZXRyeV92YWx1ZRgKIAEoCzIXLmdlb3NwYXRpYWwudjEuR2VvbWV0cnlIABItCgxleHRlbnRfdmFsdWUYCyABKAsyFS5nZW9zcGF0aWFsLnYxLkV4dGVudEgAEj0KD3N0YXRpc3RpY192YWx1ZRgMIAEoCzIiLmdlb3NwYXRpYWwudjEuU3RhdGlzdGljRGVmaW5pdGlvbkgAQgYKBGtpbmQiPgoNUGFyYW1ldGVyTGlzdBItCgZ2YWx1ZXMYASADKAsyHS5nZW9zcGF0aWFsLnYxLlBhcmFtZXRlclZhbHVlIpUBCgxQYXJhbWV0ZXJNYXASNwoGZmllbGRzGAEgAygLMicuZ2Vvc3BhdGlhbC52MS5QYXJhbWV0ZXJNYXAuRmllbGRzRW50cnkaTAoLRmllbGRzRW50cnkSCwoDa2V5GAEgASgJEiwKBXZhbHVlGAIgASgLMh0uZ2Vvc3BhdGlhbC52MS5QYXJhbWV0ZXJWYWx1ZToCOAEi5wEKEEV4ZWN1dGlvbkNvbnRleHQSGAoMd29ya3NwYWNlX2lkGAEgASgJQgIYARIXCg90aW1lb3V0X3NlY29uZHMYAiABKAMSPwoIbWV0YWRhdGEYAyADKAsyLS5nZW9zcGF0aWFsLnYxLkV4ZWN1dGlvbkNvbnRleHQuTWV0YWRhdGFFbnRyeRIuCgl3b3Jrc3BhY2UYBCABKAsyGy5nZW9zcGF0aWFsLnYxLldvcmtzcGFjZVJlZhovCg1NZXRhZGF0YUVudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoCToCOAEiVQoQVmFsaWRhdGVSZXNwb25zZRINCgV2YWxpZBgBIAEoCBIyCgZpc3N1ZXMYAiADKAsyIi5nZW9zcGF0aWFsLnYxLlBsYW5WYWxpZGF0aW9uSXNzdWUigAEKDkRyeVJ1blJlc3BvbnNlEg0KBXZhbGlkGAEgASgIEjIKBmlzc3VlcxgCIAMoCzIiLmdlb3NwYXRpYWwudjEuUGxhblZhbGlkYXRpb25Jc3N1ZRIrCgZyZXN1bHQYAyABKAsyGy5nZW9zcGF0aWFsLnYxLkRyeVJ1blJlc3VsdCJLChFTdWJtaXRKb2JSZXNwb25zZRIOCgZqb2JfaWQYASABKAkSJgoFc3RhdGUYAiABKA4yFy5nZW9zcGF0aWFsLnYxLkpvYlN0YXRlIh8KDUdldEpvYlJlcXVlc3QSDgoGam9iX2lkGAEgASgJInYKDkdldEpvYlJlc3BvbnNlEg4KBmpvYl9pZBgBIAEoCRImCgVzdGF0ZRgCIAEoDjIXLmdlb3NwYXRpYWwudjEuSm9iU3RhdGUSLAoIcHJvZ3Jlc3MYAyABKAsyGi5nZW9zcGF0aWFsLnYxLkpvYlByb2dyZXNzIiUKE0dldEpvYlJlc3VsdFJlcXVlc3QSDgoGam9iX2lkGAEgASgJIiIKEENhbmNlbEpvYlJlcXVlc3QSDgoGam9iX2lkGAEgASgJIksKEUNhbmNlbEpvYlJlc3BvbnNlEg4KBmpvYl9pZBgBIAEoCRImCgVzdGF0ZRgCIAEoDjIXLmdlb3NwYXRpYWwudjEuSm9iU3RhdGUqogEKDldvcmtmbG93RmFtaWx5Eh8KG1dPUktGTE9XX0ZBTUlMWV9VTlNQRUNJRklFRBAAEhsKF1dPUktGTE9XX0ZBTUlMWV9BTkFMWVpFEAESGwoXV09SS0ZMT1dfRkFNSUxZX1BVQkxJU0gQAhIZChVXT1JLRkxPV19GQU1JTFlfQlVJTEQQAxIaChZXT1JLRkxPV19GQU1JTFlfREVQTE9ZEAQq+QEKCEpvYlN0YXRlEhkKFUpPQl9TVEFURV9VTlNQRUNJRklFRBAAEhMKD0pPQl9TVEFURV9EUkFGVBABEiQKIEpPQl9TVEFURV9BV0FJVElOR19DTEFSSUZJQ0FUSU9OEAISFwoTSk9CX1NUQVRFX1ZBTElEQVRFRBADEh8KG0pPQl9TVEFURV9BV0FJVElOR19BUFBST1ZBTBAEEhUKEUpPQl9TVEFURV9SVU5OSU5HEAUSFwoTSk9CX1NUQVRFX0NPTVBMRVRFRBAGEhQKEEpPQl9TVEFURV9GQUlMRUQQBxIXChNKT0JfU1RBVEVfQ0FOQ0VMTEVEEAgq/QEKClN0YWdlU3RhdGUSGwoXU1RBR0VfU1RBVEVfVU5TUEVDSUZJRUQQABIXChNTVEFHRV9TVEFURV9QRU5ESU5HEAESFwoTU1RBR0VfU1RBVEVfUlVOTklORxACEhkKFVNUQUdFX1NUQVRFX0NPTVBMRVRFRBADEiAKHFNUQUdFX1NUQVRFX05FRURTX1VTRVJfSU5QVVQQBBIXChNTVEFHRV9TVEFURV9CTE9DS0VEEAUSFgoSU1RBR0VfU1RBVEVfRkFJTEVEEAYSFwoTU1RBR0VfU1RBVEVfU0tJUFBFRBAHEhkKFVNUQUdFX1NUQVRFX0NBTkNFTExFRBAIKoMCCg1FcnJvckNhdGVnb3J5Eh4KGkVSUk9SX0NBVEVHT1JZX1VOU1BFQ0lGSUVEEAASHQoZRVJST1JfQ0FURUdPUllfVkFMSURBVElPThABEiAKHEVSUk9SX0NBVEVHT1JZX0FVVEhPUklaQVRJT04QAhIZChVFUlJPUl9DQVRFR09SWV9QT0xJQ1kQAxIcChhFUlJPUl9DQVRFR09SWV9FWEVDVVRJT04QBBIbChdFUlJPUl9DQVRFR09SWV9BUlRJRkFDVBAFEhwKGEVSUk9SX0NBVEVHT1JZX1BBQ0tBR0lORxAGEh0KGUVSUk9SX0NBVEVHT1JZX0RFUExPWU1FTlQQByrpAQoMUmV0cnlhYmlsaXR5EhwKGFJFVFJZQUJJTElUWV9VTlNQRUNJRklFRBAAEiMKH1JFVFJZQUJJTElUWV9GSVhfUExBTl9BTkRfUkVUUlkQARIjCh9SRVRSWUFCSUxJVFlfRklYX0RBVEFfQU5EX1JFVFJZEAISIwofUkVUUllBQklMSVRZX0lOU1VGRklDSUVOVF9RVU9UQRADEigKJFJFVFJZQUJJTElUWV9UUkFOU0lFTlRfQkFDS0VORF9FUlJPUhAEEiIKHlJFVFJZQUJJTElUWV9QRVJNQU5FTlRfRkFJTFVSRRAFKrMCCg1BcnRpZmFjdENsYXNzEh4KGkFSVElGQUNUX0NMQVNTX1VOU1BFQ0lGSUVEEAASGQoVQVJUSUZBQ1RfQ0xBU1NfU0NBTEFSEAESIAocQVJUSUZBQ1RfQ0xBU1NfRkVBVFVSRV9MQVlFUhACEhgKFEFSVElGQUNUX0NMQVNTX1RBQkxFEAMSGQoVQVJUSUZBQ1RfQ0xBU1NfUkFTVEVSEAQSFwoTQVJUSUZBQ1RfQ0xBU1NfRklMRRAFEhkKFUFSVElGQUNUX0NMQVNTX1JFUE9SVBAGEhYKEkFSVElGQUNUX0NMQVNTX01BUBAHEh0KGUFSVElGQUNUX0NMQVNTX0FQUF9CVU5ETEUQCBIlCiFBUlRJRkFDVF9DTEFTU19TRVJWSUNFX0RFRklOSVRJT04QCWIGcHJvdG8z", [
	file_geospatial_v1_common,
	file_geospatial_v1_spatial_types,
	file_geospatial_v1_workspace_artifact_types
]);
/**
* WorkflowFamily identifies the category of operator workflow.
* Values are scoped to families with a defined owning service in this package.
*
* @generated from enum geospatial.v1.WorkflowFamily
*/
var WorkflowFamily;
(function(WorkflowFamily) {
	/**
	* @generated from enum value: WORKFLOW_FAMILY_UNSPECIFIED = 0;
	*/
	WorkflowFamily[WorkflowFamily["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: WORKFLOW_FAMILY_ANALYZE = 1;
	*/
	WorkflowFamily[WorkflowFamily["ANALYZE"] = 1] = "ANALYZE";
	/**
	* @generated from enum value: WORKFLOW_FAMILY_PUBLISH = 2;
	*/
	WorkflowFamily[WorkflowFamily["PUBLISH"] = 2] = "PUBLISH";
	/**
	* @generated from enum value: WORKFLOW_FAMILY_BUILD = 3;
	*/
	WorkflowFamily[WorkflowFamily["BUILD"] = 3] = "BUILD";
	/**
	* @generated from enum value: WORKFLOW_FAMILY_DEPLOY = 4;
	*/
	WorkflowFamily[WorkflowFamily["DEPLOY"] = 4] = "DEPLOY";
})(WorkflowFamily || (WorkflowFamily = {}));
/**
* JobState represents the lifecycle state of an execution job.
*
* @generated from enum geospatial.v1.JobState
*/
var JobState;
(function(JobState) {
	/**
	* @generated from enum value: JOB_STATE_UNSPECIFIED = 0;
	*/
	JobState[JobState["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: JOB_STATE_DRAFT = 1;
	*/
	JobState[JobState["DRAFT"] = 1] = "DRAFT";
	/**
	* @generated from enum value: JOB_STATE_AWAITING_CLARIFICATION = 2;
	*/
	JobState[JobState["AWAITING_CLARIFICATION"] = 2] = "AWAITING_CLARIFICATION";
	/**
	* @generated from enum value: JOB_STATE_VALIDATED = 3;
	*/
	JobState[JobState["VALIDATED"] = 3] = "VALIDATED";
	/**
	* @generated from enum value: JOB_STATE_AWAITING_APPROVAL = 4;
	*/
	JobState[JobState["AWAITING_APPROVAL"] = 4] = "AWAITING_APPROVAL";
	/**
	* @generated from enum value: JOB_STATE_RUNNING = 5;
	*/
	JobState[JobState["RUNNING"] = 5] = "RUNNING";
	/**
	* @generated from enum value: JOB_STATE_COMPLETED = 6;
	*/
	JobState[JobState["COMPLETED"] = 6] = "COMPLETED";
	/**
	* @generated from enum value: JOB_STATE_FAILED = 7;
	*/
	JobState[JobState["FAILED"] = 7] = "FAILED";
	/**
	* @generated from enum value: JOB_STATE_CANCELLED = 8;
	*/
	JobState[JobState["CANCELLED"] = 8] = "CANCELLED";
})(JobState || (JobState = {}));
/**
* StageState represents the state of an individual execution stage.
*
* @generated from enum geospatial.v1.StageState
*/
var StageState;
(function(StageState) {
	/**
	* @generated from enum value: STAGE_STATE_UNSPECIFIED = 0;
	*/
	StageState[StageState["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: STAGE_STATE_PENDING = 1;
	*/
	StageState[StageState["PENDING"] = 1] = "PENDING";
	/**
	* @generated from enum value: STAGE_STATE_RUNNING = 2;
	*/
	StageState[StageState["RUNNING"] = 2] = "RUNNING";
	/**
	* @generated from enum value: STAGE_STATE_COMPLETED = 3;
	*/
	StageState[StageState["COMPLETED"] = 3] = "COMPLETED";
	/**
	* @generated from enum value: STAGE_STATE_NEEDS_USER_INPUT = 4;
	*/
	StageState[StageState["NEEDS_USER_INPUT"] = 4] = "NEEDS_USER_INPUT";
	/**
	* @generated from enum value: STAGE_STATE_BLOCKED = 5;
	*/
	StageState[StageState["BLOCKED"] = 5] = "BLOCKED";
	/**
	* @generated from enum value: STAGE_STATE_FAILED = 6;
	*/
	StageState[StageState["FAILED"] = 6] = "FAILED";
	/**
	* @generated from enum value: STAGE_STATE_SKIPPED = 7;
	*/
	StageState[StageState["SKIPPED"] = 7] = "SKIPPED";
	/**
	* @generated from enum value: STAGE_STATE_CANCELLED = 8;
	*/
	StageState[StageState["CANCELLED"] = 8] = "CANCELLED";
})(StageState || (StageState = {}));
/**
* ErrorCategory classifies the domain of an execution error.
*
* @generated from enum geospatial.v1.ErrorCategory
*/
var ErrorCategory;
(function(ErrorCategory) {
	/**
	* @generated from enum value: ERROR_CATEGORY_UNSPECIFIED = 0;
	*/
	ErrorCategory[ErrorCategory["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: ERROR_CATEGORY_VALIDATION = 1;
	*/
	ErrorCategory[ErrorCategory["VALIDATION"] = 1] = "VALIDATION";
	/**
	* @generated from enum value: ERROR_CATEGORY_AUTHORIZATION = 2;
	*/
	ErrorCategory[ErrorCategory["AUTHORIZATION"] = 2] = "AUTHORIZATION";
	/**
	* @generated from enum value: ERROR_CATEGORY_POLICY = 3;
	*/
	ErrorCategory[ErrorCategory["POLICY"] = 3] = "POLICY";
	/**
	* @generated from enum value: ERROR_CATEGORY_EXECUTION = 4;
	*/
	ErrorCategory[ErrorCategory["EXECUTION"] = 4] = "EXECUTION";
	/**
	* @generated from enum value: ERROR_CATEGORY_ARTIFACT = 5;
	*/
	ErrorCategory[ErrorCategory["ARTIFACT"] = 5] = "ARTIFACT";
	/**
	* @generated from enum value: ERROR_CATEGORY_PACKAGING = 6;
	*/
	ErrorCategory[ErrorCategory["PACKAGING"] = 6] = "PACKAGING";
	/**
	* @generated from enum value: ERROR_CATEGORY_DEPLOYMENT = 7;
	*/
	ErrorCategory[ErrorCategory["DEPLOYMENT"] = 7] = "DEPLOYMENT";
})(ErrorCategory || (ErrorCategory = {}));
/**
* Retryability classifies how a failed operation may be retried.
*
* @generated from enum geospatial.v1.Retryability
*/
var Retryability;
(function(Retryability) {
	/**
	* @generated from enum value: RETRYABILITY_UNSPECIFIED = 0;
	*/
	Retryability[Retryability["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: RETRYABILITY_FIX_PLAN_AND_RETRY = 1;
	*/
	Retryability[Retryability["FIX_PLAN_AND_RETRY"] = 1] = "FIX_PLAN_AND_RETRY";
	/**
	* @generated from enum value: RETRYABILITY_FIX_DATA_AND_RETRY = 2;
	*/
	Retryability[Retryability["FIX_DATA_AND_RETRY"] = 2] = "FIX_DATA_AND_RETRY";
	/**
	* @generated from enum value: RETRYABILITY_INSUFFICIENT_QUOTA = 3;
	*/
	Retryability[Retryability["INSUFFICIENT_QUOTA"] = 3] = "INSUFFICIENT_QUOTA";
	/**
	* @generated from enum value: RETRYABILITY_TRANSIENT_BACKEND_ERROR = 4;
	*/
	Retryability[Retryability["TRANSIENT_BACKEND_ERROR"] = 4] = "TRANSIENT_BACKEND_ERROR";
	/**
	* @generated from enum value: RETRYABILITY_PERMANENT_FAILURE = 5;
	*/
	Retryability[Retryability["PERMANENT_FAILURE"] = 5] = "PERMANENT_FAILURE";
})(Retryability || (Retryability = {}));
/**
* ArtifactClass identifies the type of an execution artifact.
*
* @generated from enum geospatial.v1.ArtifactClass
*/
var ArtifactClass;
(function(ArtifactClass) {
	/**
	* @generated from enum value: ARTIFACT_CLASS_UNSPECIFIED = 0;
	*/
	ArtifactClass[ArtifactClass["UNSPECIFIED"] = 0] = "UNSPECIFIED";
	/**
	* @generated from enum value: ARTIFACT_CLASS_SCALAR = 1;
	*/
	ArtifactClass[ArtifactClass["SCALAR"] = 1] = "SCALAR";
	/**
	* @generated from enum value: ARTIFACT_CLASS_FEATURE_LAYER = 2;
	*/
	ArtifactClass[ArtifactClass["FEATURE_LAYER"] = 2] = "FEATURE_LAYER";
	/**
	* @generated from enum value: ARTIFACT_CLASS_TABLE = 3;
	*/
	ArtifactClass[ArtifactClass["TABLE"] = 3] = "TABLE";
	/**
	* @generated from enum value: ARTIFACT_CLASS_RASTER = 4;
	*/
	ArtifactClass[ArtifactClass["RASTER"] = 4] = "RASTER";
	/**
	* @generated from enum value: ARTIFACT_CLASS_FILE = 5;
	*/
	ArtifactClass[ArtifactClass["FILE"] = 5] = "FILE";
	/**
	* @generated from enum value: ARTIFACT_CLASS_REPORT = 6;
	*/
	ArtifactClass[ArtifactClass["REPORT"] = 6] = "REPORT";
	/**
	* @generated from enum value: ARTIFACT_CLASS_MAP = 7;
	*/
	ArtifactClass[ArtifactClass["MAP"] = 7] = "MAP";
	/**
	* @generated from enum value: ARTIFACT_CLASS_APP_BUNDLE = 8;
	*/
	ArtifactClass[ArtifactClass["APP_BUNDLE"] = 8] = "APP_BUNDLE";
	/**
	* @generated from enum value: ARTIFACT_CLASS_SERVICE_DEFINITION = 9;
	*/
	ArtifactClass[ArtifactClass["SERVICE_DEFINITION"] = 9] = "SERVICE_DEFINITION";
})(ArtifactClass || (ArtifactClass = {}));
//#endregion
//#region .tmp/sample-runner/eb988078-d7ea-4867-9f89-7fe0b45ccbee/packed-sdk/extract/package/dist/src/gen/geospatial/v1/feature_service_pb.js
/**
* Describes the file geospatial/v1/feature_service.proto.
*/
var file_geospatial_v1_feature_service = /*@__PURE__*/ fileDesc("CiNnZW9zcGF0aWFsL3YxL2ZlYXR1cmVfc2VydmljZS5wcm90bxINZ2Vvc3BhdGlhbC52MSLkBAoUUXVlcnlGZWF0dXJlc1JlcXVlc3QSEgoKc2VydmljZV9pZBgBIAEoCRIQCghsYXllcl9pZBgCIAEoBRINCgV3aGVyZRgDIAEoCRISCgpvYmplY3RfaWRzGAQgAygDEhIKCm91dF9maWVsZHMYBSADKAkSFwoPcmV0dXJuX2dlb21ldHJ5GAYgASgIEi8KBm91dF9zchgHIAEoCzIfLmdlb3NwYXRpYWwudjEuU3BhdGlhbFJlZmVyZW5jZRIQCghvcmRlcl9ieRgKIAEoCRIXCg9yZXR1cm5fZGlzdGluY3QYCyABKAgSGQoRcmV0dXJuX2NvdW50X29ubHkYDCABKAgSFwoPcmV0dXJuX2lkc19vbmx5GA0gASgIEhoKEnJldHVybl9leHRlbnRfb25seRgOIAEoCBI6Cg5vdXRfc3RhdGlzdGljcxgPIAMoCzIiLmdlb3NwYXRpYWwudjEuU3RhdGlzdGljRGVmaW5pdGlvbhIQCghncm91cF9ieRgQIAMoCRIaChJnZW9tZXRyeV9wcmVjaXNpb24YESABKAUSHAoUbWF4X2FsbG93YWJsZV9vZmZzZXQYEiABKAESNAoOc3BhdGlhbF9maWx0ZXIYEyABKAsyHC5nZW9zcGF0aWFsLnYxLlNwYXRpYWxGaWx0ZXISGgoScmVzdWx0X29mZnNldF9sb25nGBQgASgDEiAKGHJlc3VsdF9yZWNvcmRfY291bnRfbG9uZxgVIAEoA0oECAgQCUoECAkQClINcmVzdWx0X29mZnNldFITcmVzdWx0X3JlY29yZF9jb3VudCLqAgoVUXVlcnlGZWF0dXJlc1Jlc3BvbnNlEhwKFG9iamVjdF9pZF9maWVsZF9uYW1lGAEgASgJEjIKDWdlb21ldHJ5X3R5cGUYAiABKA4yGy5nZW9zcGF0aWFsLnYxLkdlb21ldHJ5VHlwZRI6ChFzcGF0aWFsX3JlZmVyZW5jZRgDIAEoCzIfLmdlb3NwYXRpYWwudjEuU3BhdGlhbFJlZmVyZW5jZRIuCgZmaWVsZHMYBCADKAsyHi5nZW9zcGF0aWFsLnYxLkZpZWxkRGVmaW5pdGlvbhIoCghmZWF0dXJlcxgFIAMoCzIWLmdlb3NwYXRpYWwudjEuRmVhdHVyZRIfChdleGNlZWRlZF90cmFuc2Zlcl9saW1pdBgGIAEoCBINCgVjb3VudBgHIAEoAxISCgpvYmplY3RfaWRzGAggAygDEiUKBmV4dGVudBgJIAEoCzIVLmdlb3NwYXRpYWwudjEuRXh0ZW50IosCCgtGZWF0dXJlUGFnZRIcChRvYmplY3RfaWRfZmllbGRfbmFtZRgBIAEoCRIyCg1nZW9tZXRyeV90eXBlGAIgASgOMhsuZ2Vvc3BhdGlhbC52MS5HZW9tZXRyeVR5cGUSOgoRc3BhdGlhbF9yZWZlcmVuY2UYAyABKAsyHy5nZW9zcGF0aWFsLnYxLlNwYXRpYWxSZWZlcmVuY2USLgoGZmllbGRzGAQgAygLMh4uZ2Vvc3BhdGlhbC52MS5GaWVsZERlZmluaXRpb24SKAoIZmVhdHVyZXMYBSADKAsyFi5nZW9zcGF0aWFsLnYxLkZlYXR1cmUSFAoMaXNfbGFzdF9wYWdlGAYgASgIIuQBChFBcHBseUVkaXRzUmVxdWVzdBISCgpzZXJ2aWNlX2lkGAEgASgJEhAKCGxheWVyX2lkGAIgASgFEiQKBGFkZHMYAyADKAsyFi5nZW9zcGF0aWFsLnYxLkZlYXR1cmUSJwoHdXBkYXRlcxgEIAMoCzIWLmdlb3NwYXRpYWwudjEuRmVhdHVyZRIPCgdkZWxldGVzGAUgAygDEhsKE3JvbGxiYWNrX29uX2ZhaWx1cmUYBiABKAgSEwoLZm9yY2Vfd3JpdGUYByABKAgSFwoPaWRlbXBvdGVuY3lfa2V5GAggASgJItUBChJBcHBseUVkaXRzUmVzcG9uc2USLgoLYWRkX3Jlc3VsdHMYASADKAsyGS5nZW9zcGF0aWFsLnYxLkVkaXRSZXN1bHQSMQoOdXBkYXRlX3Jlc3VsdHMYAiADKAsyGS5nZW9zcGF0aWFsLnYxLkVkaXRSZXN1bHQSMQoOZGVsZXRlX3Jlc3VsdHMYAyADKAsyGS5nZW9zcGF0aWFsLnYxLkVkaXRSZXN1bHQSKQoFZXJyb3IYBCABKAsyGi5nZW9zcGF0aWFsLnYxLkVycm9yRGV0YWlsIlsKCkVkaXRSZXN1bHQSEQoJb2JqZWN0X2lkGAEgASgDEg8KB3N1Y2Nlc3MYAiABKAgSKQoFZXJyb3IYAyABKAsyGi5nZW9zcGF0aWFsLnYxLkVycm9yRGV0YWlsMpkCCg5GZWF0dXJlU2VydmljZRJaCg1RdWVyeUZlYXR1cmVzEiMuZ2Vvc3BhdGlhbC52MS5RdWVyeUZlYXR1cmVzUmVxdWVzdBokLmdlb3NwYXRpYWwudjEuUXVlcnlGZWF0dXJlc1Jlc3BvbnNlElgKE1F1ZXJ5RmVhdHVyZXNTdHJlYW0SIy5nZW9zcGF0aWFsLnYxLlF1ZXJ5RmVhdHVyZXNSZXF1ZXN0GhouZ2Vvc3BhdGlhbC52MS5GZWF0dXJlUGFnZTABElEKCkFwcGx5RWRpdHMSIC5nZW9zcGF0aWFsLnYxLkFwcGx5RWRpdHNSZXF1ZXN0GiEuZ2Vvc3BhdGlhbC52MS5BcHBseUVkaXRzUmVzcG9uc2ViBnByb3RvMw", [
	file_geospatial_v1_common,
	file_geospatial_v1_execution_types,
	file_geospatial_v1_spatial_types
]);
/**
* Describes the message geospatial.v1.QueryFeaturesRequest.
* Use `create(QueryFeaturesRequestSchema)` to create a new message.
*/
var QueryFeaturesRequestSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_feature_service, 0);
/**
* Describes the message geospatial.v1.QueryFeaturesResponse.
* Use `create(QueryFeaturesResponseSchema)` to create a new message.
*/
var QueryFeaturesResponseSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_feature_service, 1);
/**
* Describes the message geospatial.v1.FeaturePage.
* Use `create(FeaturePageSchema)` to create a new message.
*/
var FeaturePageSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_feature_service, 2);
/**
* Describes the message geospatial.v1.ApplyEditsRequest.
* Use `create(ApplyEditsRequestSchema)` to create a new message.
*/
var ApplyEditsRequestSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_feature_service, 3);
/**
* Describes the message geospatial.v1.ApplyEditsResponse.
* Use `create(ApplyEditsResponseSchema)` to create a new message.
*/
var ApplyEditsResponseSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_feature_service, 4);
/**
* Describes the message geospatial.v1.EditResult.
* Use `create(EditResultSchema)` to create a new message.
*/
var EditResultSchema = /*@__PURE__*/ messageDesc(file_geospatial_v1_feature_service, 5);
/**
* FeatureService provides typed RPC access to geospatial feature queries and editing.
* This service defines the core geospatial operations for feature data access.
*
* @generated from service geospatial.v1.FeatureService
*/
var FeatureService = /*@__PURE__*/ serviceDesc(file_geospatial_v1_feature_service, 0);
//#endregion
export { StatisticType as C, StatisticDefinitionSchema as S, DistanceUnit as _, FeatureService as a, SpatialReferenceSchema as b, file_geospatial_v1_feature_service as c, GeometrySchema as d, MultiPointGeometrySchema as f, SpatialFilterSchema as g, PolylineGeometrySchema as h, FeaturePageSchema as i, CoordinateSchema as l, PolygonGeometrySchema as m, ApplyEditsResponseSchema as n, QueryFeaturesRequestSchema as o, PointGeometrySchema as p, EditResultSchema as r, QueryFeaturesResponseSchema as s, ApplyEditsRequestSchema as t, CoordinateSequenceSchema as u, FieldType as v, SpatialRelationship as x, GeometryType as y };
