import { a as enumDesc, o as messageDesc, t as fileDesc } from "./file-Cyyt2sFU.js";
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
//#region .tmp/sample-runner/8ef3a506-07f4-430a-b10e-bfb9e6c9bd05/packed-sdk/extract/package/dist/src/gen/honua/v1/feature_service_pb.js
/**
* Describes the file honua/v1/feature_service.proto.
*/
var file_honua_v1_feature_service = /*@__PURE__*/ fileDesc("Ch5ob251YS92MS9mZWF0dXJlX3NlcnZpY2UucHJvdG8SCGhvbnVhLnYxIpsEChRRdWVyeUZlYXR1cmVzUmVxdWVzdBISCgpzZXJ2aWNlX2lkGAEgASgJEhAKCGxheWVyX2lkGAIgASgFEg0KBXdoZXJlGAMgASgJEhIKCm9iamVjdF9pZHMYBCADKAMSEgoKb3V0X2ZpZWxkcxgFIAMoCRIXCg9yZXR1cm5fZ2VvbWV0cnkYBiABKAgSKgoGb3V0X3NyGAcgASgLMhouaG9udWEudjEuU3BhdGlhbFJlZmVyZW5jZRIVCg1yZXN1bHRfb2Zmc2V0GAggASgFEhsKE3Jlc3VsdF9yZWNvcmRfY291bnQYCSABKAUSEAoIb3JkZXJfYnkYCiABKAkSFwoPcmV0dXJuX2Rpc3RpbmN0GAsgASgIEhkKEXJldHVybl9jb3VudF9vbmx5GAwgASgIEhcKD3JldHVybl9pZHNfb25seRgNIAEoCBIaChJyZXR1cm5fZXh0ZW50X29ubHkYDiABKAgSNQoOb3V0X3N0YXRpc3RpY3MYDyADKAsyHS5ob251YS52MS5TdGF0aXN0aWNEZWZpbml0aW9uEhAKCGdyb3VwX2J5GBAgAygJEhoKEmdlb21ldHJ5X3ByZWNpc2lvbhgRIAEoBRIcChRtYXhfYWxsb3dhYmxlX29mZnNldBgSIAEoARIvCg5zcGF0aWFsX2ZpbHRlchgTIAEoCzIXLmhvbnVhLnYxLlNwYXRpYWxGaWx0ZXIi0QIKFVF1ZXJ5RmVhdHVyZXNSZXNwb25zZRIcChRvYmplY3RfaWRfZmllbGRfbmFtZRgBIAEoCRItCg1nZW9tZXRyeV90eXBlGAIgASgOMhYuaG9udWEudjEuR2VvbWV0cnlUeXBlEjUKEXNwYXRpYWxfcmVmZXJlbmNlGAMgASgLMhouaG9udWEudjEuU3BhdGlhbFJlZmVyZW5jZRIpCgZmaWVsZHMYBCADKAsyGS5ob251YS52MS5GaWVsZERlZmluaXRpb24SIwoIZmVhdHVyZXMYBSADKAsyES5ob251YS52MS5GZWF0dXJlEh8KF2V4Y2VlZGVkX3RyYW5zZmVyX2xpbWl0GAYgASgIEg0KBWNvdW50GAcgASgDEhIKCm9iamVjdF9pZHMYCCADKAMSIAoGZXh0ZW50GAkgASgLMhAuaG9udWEudjEuRXh0ZW50IvcBCgtGZWF0dXJlUGFnZRIcChRvYmplY3RfaWRfZmllbGRfbmFtZRgBIAEoCRItCg1nZW9tZXRyeV90eXBlGAIgASgOMhYuaG9udWEudjEuR2VvbWV0cnlUeXBlEjUKEXNwYXRpYWxfcmVmZXJlbmNlGAMgASgLMhouaG9udWEudjEuU3BhdGlhbFJlZmVyZW5jZRIpCgZmaWVsZHMYBCADKAsyGS5ob251YS52MS5GaWVsZERlZmluaXRpb24SIwoIZmVhdHVyZXMYBSADKAsyES5ob251YS52MS5GZWF0dXJlEhQKDGlzX2xhc3RfcGFnZRgGIAEoCCK/AQoHRmVhdHVyZRIKCgJpZBgBIAEoAxI1CgphdHRyaWJ1dGVzGAIgAygLMiEuaG9udWEudjEuRmVhdHVyZS5BdHRyaWJ1dGVzRW50cnkSJAoIZ2VvbWV0cnkYAyABKAsyEi5ob251YS52MS5HZW9tZXRyeRpLCg9BdHRyaWJ1dGVzRW50cnkSCwoDa2V5GAEgASgJEicKBXZhbHVlGAIgASgLMhguaG9udWEudjEuQXR0cmlidXRlVmFsdWU6AjgBIoACCg5BdHRyaWJ1dGVWYWx1ZRIWCgxzdHJpbmdfdmFsdWUYASABKAlIABIVCgtpbnQzMl92YWx1ZRgCIAEoBUgAEhUKC2ludDY0X3ZhbHVlGAMgASgDSAASFgoMZG91YmxlX3ZhbHVlGAQgASgBSAASFQoLZmxvYXRfdmFsdWUYBSABKAJIABIUCgpib29sX3ZhbHVlGAYgASgISAASGAoOZGF0ZXRpbWVfdmFsdWUYByABKANIABIVCgtieXRlc192YWx1ZRgIIAEoDEgAEikKCm51bGxfdmFsdWUYCSABKA4yEy5ob251YS52MS5OdWxsVmFsdWVIAEIHCgV2YWx1ZSKJAgoIR2VvbWV0cnkSKAoFcG9pbnQYASABKAsyFy5ob251YS52MS5Qb2ludEdlb21ldHJ5SAASMwoLbXVsdGlfcG9pbnQYAiABKAsyHC5ob251YS52MS5NdWx0aVBvaW50R2VvbWV0cnlIABIuCghwb2x5bGluZRgDIAEoCzIaLmhvbnVhLnYxLlBvbHlsaW5lR2VvbWV0cnlIABIsCgdwb2x5Z29uGAQgASgLMhkuaG9udWEudjEuUG9seWdvbkdlb21ldHJ5SAASNwoNbXVsdGlfcG9seWdvbhgFIAEoCzIeLmhvbnVhLnYxLk11bHRpUG9seWdvbkdlb21ldHJ5SABCBwoFc2hhcGUiUQoNUG9pbnRHZW9tZXRyeRIJCgF4GAEgASgBEgkKAXkYAiABKAESDgoBehgDIAEoAUgAiAEBEg4KAW0YBCABKAFIAYgBAUIECgJfekIECgJfbSI9ChJNdWx0aVBvaW50R2VvbWV0cnkSJwoGcG9pbnRzGAEgAygLMhcuaG9udWEudjEuUG9pbnRHZW9tZXRyeSJOCgpDb29yZGluYXRlEgkKAXgYASABKAESCQoBeRgCIAEoARIOCgF6GAMgASgBSACIAQESDgoBbRgEIAEoAUgBiAEBQgQKAl96QgQKAl9tIjoKEkNvb3JkaW5hdGVTZXF1ZW5jZRIkCgZjb29yZHMYASADKAsyFC5ob251YS52MS5Db29yZGluYXRlIj8KEFBvbHlsaW5lR2VvbWV0cnkSKwoFcGF0aHMYASADKAsyHC5ob251YS52MS5Db29yZGluYXRlU2VxdWVuY2UiPgoPUG9seWdvbkdlb21ldHJ5EisKBXJpbmdzGAEgAygLMhwuaG9udWEudjEuQ29vcmRpbmF0ZVNlcXVlbmNlIkMKFE11bHRpUG9seWdvbkdlb21ldHJ5EisKCHBvbHlnb25zGAEgAygLMhkuaG9udWEudjEuUG9seWdvbkdlb21ldHJ5IkIKEFNwYXRpYWxSZWZlcmVuY2USDAoEd2tpZBgBIAEoBRITCgtsYXRlc3Rfd2tpZBgCIAEoBRILCgN3a3QYAyABKAkiagoPRmllbGREZWZpbml0aW9uEgwKBG5hbWUYASABKAkSJwoKZmllbGRfdHlwZRgCIAEoDjITLmhvbnVhLnYxLkZpZWxkVHlwZRIOCgZsZW5ndGgYAyABKAUSEAoIbnVsbGFibGUYBCABKAgimgIKDVNwYXRpYWxGaWx0ZXISJAoIZ2VvbWV0cnkYASABKAsyEi5ob251YS52MS5HZW9tZXRyeRI7ChRzcGF0aWFsX3JlbGF0aW9uc2hpcBgCIAEoDjIdLmhvbnVhLnYxLlNwYXRpYWxSZWxhdGlvbnNoaXASNQoRc3BhdGlhbF9yZWZlcmVuY2UYAyABKAsyGi5ob251YS52MS5TcGF0aWFsUmVmZXJlbmNlEhAKCGRpc3RhbmNlGAQgASgBEi0KDWRpc3RhbmNlX3VuaXQYBSABKA4yFi5ob251YS52MS5EaXN0YW5jZVVuaXQSFQoNbmVhcmVzdF9jb3VudBgGIAEoBRIXCg9yZXR1cm5fZGlzdGFuY2UYByABKAgihAEKE1N0YXRpc3RpY0RlZmluaXRpb24SGgoSb25fc3RhdGlzdGljX2ZpZWxkGAEgASgJEi8KDnN0YXRpc3RpY190eXBlGAIgASgOMhcuaG9udWEudjEuU3RhdGlzdGljVHlwZRIgChhvdXRfc3RhdGlzdGljX2ZpZWxkX25hbWUYAyABKAkidwoGRXh0ZW50EgwKBHhtaW4YASABKAESDAoEeW1pbhgCIAEoARIMCgR4bWF4GAMgASgBEgwKBHltYXgYBCABKAESNQoRc3BhdGlhbF9yZWZlcmVuY2UYBSABKAsyGi5ob251YS52MS5TcGF0aWFsUmVmZXJlbmNlKhsKCU51bGxWYWx1ZRIOCgpOVUxMX1ZBTFVFEAAq1QIKCUZpZWxkVHlwZRIaChZGSUVMRF9UWVBFX1VOU1BFQ0lGSUVEEAASFQoRRklFTERfVFlQRV9TVFJJTkcQARIWChJGSUVMRF9UWVBFX0lOVEVHRVIQAhIaChZGSUVMRF9UWVBFX0JJR19JTlRFR0VSEAMSFQoRRklFTERfVFlQRV9ET1VCTEUQBBIUChBGSUVMRF9UWVBFX0ZMT0FUEAUSFgoSRklFTERfVFlQRV9CT09MRUFOEAYSGAoURklFTERfVFlQRV9EQVRFX1RJTUUQBxITCg9GSUVMRF9UWVBFX0RBVEUQCBITCg9GSUVMRF9UWVBFX1RJTUUQCRIXChNGSUVMRF9UWVBFX0dFT01FVFJZEAoSEwoPRklFTERfVFlQRV9KU09OEAsSFQoRRklFTERfVFlQRV9CSU5BUlkQDBITCg9GSUVMRF9UWVBFX1VVSUQQDSqkAgoMR2VvbWV0cnlUeXBlEh0KGUdFT01FVFJZX1RZUEVfVU5TUEVDSUZJRUQQABIXChNHRU9NRVRSWV9UWVBFX1BPSU5UEAESHQoZR0VPTUVUUllfVFlQRV9NVUxUSV9QT0lOVBACEh0KGUdFT01FVFJZX1RZUEVfTElORV9TVFJJTkcQAxIjCh9HRU9NRVRSWV9UWVBFX01VTFRJX0xJTkVfU1RSSU5HEAQSGQoVR0VPTUVUUllfVFlQRV9QT0xZR09OEAUSHwobR0VPTUVUUllfVFlQRV9NVUxUSV9QT0xZR09OEAYSJQohR0VPTUVUUllfVFlQRV9HRU9NRVRSWV9DT0xMRUNUSU9OEAcSFgoSR0VPTUVUUllfVFlQRV9OT05FEAgq/AMKE1NwYXRpYWxSZWxhdGlvbnNoaXASJAogU1BBVElBTF9SRUxBVElPTlNISVBfVU5TUEVDSUZJRUQQABIjCh9TUEFUSUFMX1JFTEFUSU9OU0hJUF9JTlRFUlNFQ1RTEAESHwobU1BBVElBTF9SRUxBVElPTlNISVBfV0lUSElOEAISIQodU1BBVElBTF9SRUxBVElPTlNISVBfQ09OVEFJTlMQAxIsCihTUEFUSUFMX1JFTEFUSU9OU0hJUF9FTlZFTE9QRV9JTlRFUlNFQ1RTEAQSIAocU1BBVElBTF9SRUxBVElPTlNISVBfQ1JPU1NFUxAFEiAKHFNQQVRJQUxfUkVMQVRJT05TSElQX1RPVUNIRVMQBhIhCh1TUEFUSUFMX1JFTEFUSU9OU0hJUF9PVkVSTEFQUxAHEiEKHVNQQVRJQUxfUkVMQVRJT05TSElQX0RJU0pPSU5UEAgSHwobU1BBVElBTF9SRUxBVElPTlNISVBfRVFVQUxTEAkSKAokU1BBVElBTF9SRUxBVElPTlNISVBfV0lUSElOX0RJU1RBTkNFEAoSKAokU1BBVElBTF9SRUxBVElPTlNISVBfQkVZT05EX0RJU1RBTkNFEAsSKQolU1BBVElBTF9SRUxBVElPTlNISVBfTkVBUkVTVF9ORUlHSEJPUhAMKpYBCgxEaXN0YW5jZVVuaXQSHQoZRElTVEFOQ0VfVU5JVF9VTlNQRUNJRklFRBAAEhgKFERJU1RBTkNFX1VOSVRfTUVURVJTEAESFgoSRElTVEFOQ0VfVU5JVF9GRUVUEAISHAoYRElTVEFOQ0VfVU5JVF9LSUxPTUVURVJTEAMSFwoTRElTVEFOQ0VfVU5JVF9NSUxFUxAEKtwBCg1TdGF0aXN0aWNUeXBlEh4KGlNUQVRJU1RJQ19UWVBFX1VOU1BFQ0lGSUVEEAASGAoUU1RBVElTVElDX1RZUEVfQ09VTlQQARIWChJTVEFUSVNUSUNfVFlQRV9TVU0QAhIWChJTVEFUSVNUSUNfVFlQRV9NSU4QAxIWChJTVEFUSVNUSUNfVFlQRV9NQVgQBBIWChJTVEFUSVNUSUNfVFlQRV9BVkcQBRIZChVTVEFUSVNUSUNfVFlQRV9TVERERVYQBhIWChJTVEFUSVNUSUNfVFlQRV9WQVIQBzKyAQoORmVhdHVyZVNlcnZpY2USUAoNUXVlcnlGZWF0dXJlcxIeLmhvbnVhLnYxLlF1ZXJ5RmVhdHVyZXNSZXF1ZXN0Gh8uaG9udWEudjEuUXVlcnlGZWF0dXJlc1Jlc3BvbnNlEk4KE1F1ZXJ5RmVhdHVyZXNTdHJlYW0SHi5ob251YS52MS5RdWVyeUZlYXR1cmVzUmVxdWVzdBoVLmhvbnVhLnYxLkZlYXR1cmVQYWdlMAFCI6oCIEhvbnVhLlNlcnZlci5GZWF0dXJlcy5HcnBjLlByb3RvYgZwcm90bzM");
/**
* Describes the message honua.v1.QueryFeaturesRequest.
* Use `create(QueryFeaturesRequestSchema)` to create a new message.
*/
var QueryFeaturesRequestSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 0);
/**
* Describes the message honua.v1.QueryFeaturesResponse.
* Use `create(QueryFeaturesResponseSchema)` to create a new message.
*/
var QueryFeaturesResponseSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 1);
/**
* Describes the message honua.v1.FeaturePage.
* Use `create(FeaturePageSchema)` to create a new message.
*/
var FeaturePageSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 2);
/**
* Describes the message honua.v1.Feature.
* Use `create(FeatureSchema)` to create a new message.
*/
var FeatureSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 3);
/**
* Describes the message honua.v1.AttributeValue.
* Use `create(AttributeValueSchema)` to create a new message.
*/
var AttributeValueSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 4);
/**
* Describes the message honua.v1.Geometry.
* Use `create(GeometrySchema)` to create a new message.
*/
var GeometrySchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 5);
/**
* Describes the message honua.v1.PointGeometry.
* Use `create(PointGeometrySchema)` to create a new message.
*/
var PointGeometrySchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 6);
/**
* Describes the message honua.v1.MultiPointGeometry.
* Use `create(MultiPointGeometrySchema)` to create a new message.
*/
var MultiPointGeometrySchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 7);
/**
* Describes the message honua.v1.Coordinate.
* Use `create(CoordinateSchema)` to create a new message.
*/
var CoordinateSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 8);
/**
* Describes the message honua.v1.CoordinateSequence.
* Use `create(CoordinateSequenceSchema)` to create a new message.
*/
var CoordinateSequenceSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 9);
/**
* Describes the message honua.v1.PolylineGeometry.
* Use `create(PolylineGeometrySchema)` to create a new message.
*/
var PolylineGeometrySchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 10);
/**
* Describes the message honua.v1.PolygonGeometry.
* Use `create(PolygonGeometrySchema)` to create a new message.
*/
var PolygonGeometrySchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 11);
/**
* Describes the message honua.v1.MultiPolygonGeometry.
* Use `create(MultiPolygonGeometrySchema)` to create a new message.
*/
var MultiPolygonGeometrySchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 12);
/**
* Describes the message honua.v1.SpatialReference.
* Use `create(SpatialReferenceSchema)` to create a new message.
*/
var SpatialReferenceSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 13);
/**
* Describes the message honua.v1.FieldDefinition.
* Use `create(FieldDefinitionSchema)` to create a new message.
*/
var FieldDefinitionSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 14);
/**
* Describes the message honua.v1.SpatialFilter.
* Use `create(SpatialFilterSchema)` to create a new message.
*/
var SpatialFilterSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 15);
/**
* Describes the message honua.v1.StatisticDefinition.
* Use `create(StatisticDefinitionSchema)` to create a new message.
*/
var StatisticDefinitionSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 16);
/**
* Describes the message honua.v1.Extent.
* Use `create(ExtentSchema)` to create a new message.
*/
var ExtentSchema = /*@__PURE__*/ messageDesc(file_honua_v1_feature_service, 17);
/**
* NullValue represents a null attribute value.
*
* @generated from enum honua.v1.NullValue
*/
var NullValue;
(function(NullValue) {
	/**
	* @generated from enum value: NULL_VALUE = 0;
	*/
	NullValue[NullValue["NULL_VALUE"] = 0] = "NULL_VALUE";
})(NullValue || (NullValue = {}));
/**
* Describes the enum honua.v1.NullValue.
*/
var NullValueSchema = /*@__PURE__*/ enumDesc(file_honua_v1_feature_service, 0);
/**
* FieldType enumerates supported attribute field types.
*
* @generated from enum honua.v1.FieldType
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
* Describes the enum honua.v1.FieldType.
*/
var FieldTypeSchema = /*@__PURE__*/ enumDesc(file_honua_v1_feature_service, 1);
/**
* GeometryType enumerates supported geometry types.
*
* @generated from enum honua.v1.GeometryType
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
* Describes the enum honua.v1.GeometryType.
*/
var GeometryTypeSchema = /*@__PURE__*/ enumDesc(file_honua_v1_feature_service, 2);
/**
* SpatialRelationship enumerates spatial relationship types for filtering.
*
* @generated from enum honua.v1.SpatialRelationship
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
* Describes the enum honua.v1.SpatialRelationship.
*/
var SpatialRelationshipSchema = /*@__PURE__*/ enumDesc(file_honua_v1_feature_service, 3);
/**
* DistanceUnit enumerates supported distance measurement units.
*
* @generated from enum honua.v1.DistanceUnit
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
* Describes the enum honua.v1.DistanceUnit.
*/
var DistanceUnitSchema = /*@__PURE__*/ enumDesc(file_honua_v1_feature_service, 4);
/**
* StatisticType enumerates supported aggregate functions.
*
* @generated from enum honua.v1.StatisticType
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
* Describes the enum honua.v1.StatisticType.
*/
var StatisticTypeSchema = /*@__PURE__*/ enumDesc(file_honua_v1_feature_service, 5);
/**
* FeatureService provides typed RPC access to geospatial feature queries.
*
* @generated from service honua.v1.FeatureService
*/
var FeatureService = /*@__PURE__*/ serviceDesc(file_honua_v1_feature_service, 0);
//#endregion
export { StatisticType as A, QueryFeaturesRequestSchema as C, SpatialRelationship as D, SpatialReferenceSchema as E, file_honua_v1_feature_service as M, SpatialRelationshipSchema as O, PolylineGeometrySchema as S, SpatialFilterSchema as T, MultiPolygonGeometrySchema as _, DistanceUnitSchema as a, PointGeometrySchema as b, FeatureSchema as c, FieldType as d, FieldTypeSchema as f, MultiPointGeometrySchema as g, GeometryTypeSchema as h, DistanceUnit as i, StatisticTypeSchema as j, StatisticDefinitionSchema as k, FeatureService as l, GeometryType as m, CoordinateSchema as n, ExtentSchema as o, GeometrySchema as p, CoordinateSequenceSchema as r, FeaturePageSchema as s, AttributeValueSchema as t, FieldDefinitionSchema as u, NullValue as v, QueryFeaturesResponseSchema as w, PolygonGeometrySchema as x, NullValueSchema as y };
