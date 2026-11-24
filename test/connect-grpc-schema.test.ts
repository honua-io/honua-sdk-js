import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { grpcSourceSchemaV2 } from "../src/connect-grpc-schema.js";
import { LayerDescriptorSchema } from "../src/gen/geospatial/v1/metadata_types_pb.js";

const context = { source: "https://example.test/geospatial.v1.FeatureService/DescribeLayer#parcels/0" };
it("projects epoch timestamp defaults and range bounds into UTC timestamps", () => {
  const schema = grpcSourceSchemaV2(
    create(LayerDescriptorSchema, {
      fields: [
        {
          definition: { name: "created", fieldType: 7 },
          defaultValue: { value: { case: "datetimeValue", value: 0n } },
          domain: {
            constraint: {
              case: "range",
              value: {
                minimum: { value: { case: "datetimeValue", value: 0n } },
                maximum: { value: { case: "datetimeValue", value: 86400000n } },
              },
            },
          },
        },
      ],
    }),
    context,
  );
  expect(schema.fields[0]).toMatchObject({
    defaultValue: "1970-01-01T00:00:00.000Z",
    domain: {
      state: "range",
      minimum: { value: "1970-01-01T00:00:00.000Z" },
      maximum: { value: "1970-01-02T00:00:00.000Z" },
    },
  });
});
it("normalizes small int32 wire values on int64 fields to decimal strings", () => {
  const schema = grpcSourceSchemaV2(
    create(LayerDescriptorSchema, {
      fields: [
        {
          definition: { name: "count", fieldType: 3 },
          defaultValue: { value: { case: "int32Value", value: 0 } },
          domain: {
            constraint: {
              case: "codedValues",
              value: { values: [{ name: "Zero", code: { value: { case: "int32Value", value: 0 } } }] },
            },
          },
        },
      ],
    }),
    context,
  );
  expect(schema.fields[0]).toMatchObject({
    defaultValue: "0",
    domain: { state: "coded", values: [{ value: "0", label: "Zero" }] },
  });
});
it("normalizes int64 wire values on floating fields to numeric defaults and bounds", () => {
  const schema = grpcSourceSchemaV2(
    create(LayerDescriptorSchema, {
      fields: [
        {
          definition: { name: "area", fieldType: 4 },
          defaultValue: { value: { case: "int64Value", value: 2147483648n } },
          domain: {
            constraint: {
              case: "range",
              value: {
                minimum: { value: { case: "int32Value", value: 0 } },
                maximum: { value: { case: "int64Value", value: 4294967296n } },
              },
            },
          },
        },
      ],
    }),
    context,
  );
  expect(schema.fields[0]).toMatchObject({
    defaultValue: 2147483648,
    domain: { state: "range", minimum: { value: 0 }, maximum: { value: 4294967296 } },
  });
});
it("preserves int64 defaults and domains without narrowing to JavaScript numbers", () => {
  const descriptor = create(LayerDescriptorSchema, {
    objectIdField: "id",
    geometryType: 8,
    fields: [
      {
        definition: { name: "id", fieldType: 3 },
        editable: false,
        defaultValue: { value: { case: "int64Value", value: 9007199254740993n } },
        domain: {
          constraint: {
            case: "codedValues",
            value: { values: [{ name: "Large", code: { value: { case: "int64Value", value: 9007199254740993n } } }] },
          },
        },
      },
    ],
  });
  const schema = grpcSourceSchemaV2(descriptor, context);
  expect(schema.fields[0]).toMatchObject({
    type: { kind: "integer", bits: 64, jsonEncoding: "string" },
    defaultValue: "9007199254740993",
    mutability: "read-only",
    roles: ["feature-id", "primary-key"],
    domain: { state: "coded", values: [{ value: "9007199254740993", label: "Large" }] },
  });
  expect(schema.geometry).toEqual({ state: "none", reason: "declared-non-spatial" });
  expect(() => JSON.stringify(schema)).not.toThrow();
});
it("retains explicit null defaults, temporal roles, and unknown editability", () => {
  const schema = grpcSourceSchemaV2(
    create(LayerDescriptorSchema, {
      fields: [
        {
          definition: { name: "created", fieldType: 7, nullable: true },
          defaultValue: { value: { case: "nullValue", value: 0 } },
        },
      ],
      timeInfo: { startField: "created" },
    }),
    context,
  );
  expect(schema.fields[0]).toMatchObject({
    defaultValue: null,
    mutability: "unknown",
    roles: ["time-instant"],
    type: { kind: "timestamp" },
  });
  expect(schema.temporal).toEqual({ state: "instant", field: "created" });
});
it("describes native geometry without assuming axis or coordinate order", () => {
  const schema = grpcSourceSchemaV2(
    create(LayerDescriptorSchema, {
      geometryType: 1,
      hasM: true,
      spatialReference: { wkid: 4326 },
      fields: [{ definition: { name: "shape", fieldType: 10 } }],
    }),
    context,
  );
  expect(schema.geometry).toMatchObject({
    state: "known",
    fields: [
      {
        field: "shape",
        geometryTypes: { type: "Point" },
        layout: "xym",
        crs: { definition: { kind: "authority", code: "4326" }, coordinateOrder: { state: "unknown" } },
      },
    ],
  });
});
it("rejects duplicate fields and dangling temporal or key references", () => {
  for (const descriptor of [
    { fields: [{ definition: { name: "id" } }, { definition: { name: "id" } }] },
    { objectIdField: "missing" },
    { timeInfo: { startField: "missing" } },
  ])
    expect(() => grpcSourceSchemaV2(create(LayerDescriptorSchema, descriptor), context)).toThrow();
});
