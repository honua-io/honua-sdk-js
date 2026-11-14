import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { grpcSourceSchemaV2 } from "../src/connect-grpc-schema.js";
import { LayerDescriptorSchema } from "../src/gen/geospatial/v1/metadata_types_pb.js";

const context = { source: "https://example.test/geospatial.v1.FeatureService/DescribeLayer#parcels/0" };
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
