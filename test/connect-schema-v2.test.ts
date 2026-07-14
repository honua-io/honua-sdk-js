import { describe, expect, it, vi } from "vitest";

import { type ConnectDiscoverySnapshot, HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION, connect } from "../src/connect.js";
import { type SourceDescriptor, capabilities } from "../src/contract/types.js";
import {
  type HonuaOdataMetadata,
  getOdataSourceSchemaProjectionDetails,
  parseOdataMetadata,
} from "../src/core/odata.js";
import { buildSourceProfile } from "../src/geoparquet/metadata.js";
import { createQueryIr, hashQueryIr, queryIrSourceIdentity } from "../src/query-planner/ir.js";
import {
  type JsonValue,
  type LogicalType,
  connectWithSourceSchemaV2,
  createSourceSchemaV2,
  geoParquetSourceSchemaV2,
  geoServicesSourceSchemaV2,
  odataSourceSchemaV2,
  sourceSchemaV2QueryContext,
} from "../src/source-schema.js";

const context = { source: "https://example.test/metadata", observedAt: "2026-07-13T00:00:00Z" };

describe("source schema v2 discovery adapters", () => {
  it("normalizes equivalent GeoServices, OData, and GeoParquet fields to one semantic fingerprint", () => {
    const geoservices = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Counts",
        fields: [{ name: "Count", type: "esriFieldTypeInteger", nullable: true }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    )!;
    const odata = odataSourceSchemaV2(
      parseOdataMetadata(`
        <edmx:Edmx Version="4.0">
          <Schema Namespace="Example">
            <EntityType Name="Count"><Property Name="Count" Type="Edm.Int32" Nullable="true"/></EntityType>
            <EntityContainer Name="Container"><EntitySet Name="Counts" EntityType="Example.Count"/></EntityContainer>
          </Schema>
        </edmx:Edmx>
      `),
      "Counts",
      context,
    )!;
    const geoparquet = geoParquetSourceSchemaV2(
      {
        columns: ["Count"],
        fields: [{ name: "Count", type: "INTEGER", nullable: true }],
      },
      context,
    );

    expect(geoservices.fields[0]?.type).toEqual(odata.fields[0]?.type);
    expect(odata.fields[0]?.type).toEqual(geoparquet.fields[0]?.type);
    expect(new Set([geoservices.fingerprint, odata.fingerprint, geoparquet.fingerprint]).size).toBe(1);
  });

  it("projects omitted OData and GeoServices key nullability as non-nullable", () => {
    const odata = odataSourceSchemaV2(
      parseOdataMetadata(`
        <Schema Namespace="Example">
          <EntityType Name="Asset">
            <Key><PropertyRef Name="Id"/></Key>
            <Property Name="Id" Type="Edm.Int64"/>
          </EntityType>
          <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
        </Schema>
      `),
      "Assets",
      context,
    )!;
    const geoservices = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Assets",
        objectIdField: "OBJECTID",
        fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    )!;

    expect(odata.fields[0]).toMatchObject({ nullability: "non-nullable", roles: ["feature-id", "primary-key"] });
    expect(geoservices.fields[0]).toMatchObject({
      nullability: "non-nullable",
      roles: ["feature-id", "primary-key"],
    });
  });

  it.each(["odata", "geoservices"] as const)("rejects an explicitly nullable %s key", (adapter) => {
    const project = () =>
      adapter === "odata"
        ? odataSourceSchemaV2(
            parseOdataMetadata(`
              <Schema Namespace="Example">
                <EntityType Name="Asset">
                  <Key><PropertyRef Name="Id"/></Key>
                  <Property Name="Id" Type="Edm.Int32" Nullable="true"/>
                </EntityType>
                <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
              </Schema>
            `),
            "Assets",
            context,
          )
        : geoServicesSourceSchemaV2(
            {
              id: 0,
              name: "Assets",
              objectIdField: "OBJECTID",
              fields: [{ name: "OBJECTID", type: "esriFieldTypeOID", nullable: true }],
            },
            { ...context, protocol: "geoservices-feature-service" },
          );

    expect(project).toThrow(/Known key field (Id|OBJECTID) must be non-nullable/);
  });

  it("infers only a unique GeoServices OID and degrades ambiguous or mistyped declarations", () => {
    const project = (metadata: Parameters<typeof geoServicesSourceSchemaV2>[0]) =>
      geoServicesSourceSchemaV2(metadata, { ...context, protocol: "geoservices-feature-service" })!;
    const unique = project({
      id: 0,
      name: "Unique",
      fields: [
        { name: "OBJECTID", type: "esriFieldTypeOID" },
        { name: "Name", type: "esriFieldTypeString" },
      ],
    });
    expect(unique.key).toEqual({ state: "known", fields: ["OBJECTID"] });
    expect(unique.fields.find((field) => field.name === "OBJECTID")).toMatchObject({
      nullability: "non-nullable",
      roles: ["feature-id", "primary-key"],
    });

    const ambiguous = project({
      id: 0,
      name: "Ambiguous",
      fields: [
        { name: "FirstId", type: "esriFieldTypeOID" },
        { name: "SecondId", type: "esriFieldTypeOID" },
      ],
    });
    expect(ambiguous.key).toEqual({ state: "unknown", reason: "conflicting" });
    expect(ambiguous.fields.every((field) => !field.roles.includes("primary-key"))).toBe(true);

    const mistyped = project({
      id: 0,
      name: "Mistyped",
      objectIdField: "Id",
      fields: [{ name: "Id", type: "esriFieldTypeString", nullable: false }],
    });
    expect(mistyped.key).toEqual({ state: "unknown", reason: "conflicting" });
    expect(mistyped.fields[0]?.roles).not.toContain("primary-key");
  });

  it("does not trust caller-constructed v2 fingerprints at the generic planner boundary", () => {
    const schemaFor = (type: "esriFieldTypeInteger" | "esriFieldTypeString") =>
      geoServicesSourceSchemaV2(
        { id: 0, name: "Counts", fields: [{ name: "Count", type }] },
        { ...context, protocol: "geoservices-feature-service" },
      )!;
    const firstSchema = schemaFor("esriFieldTypeInteger");
    const secondSchema = schemaFor("esriFieldTypeString");
    const descriptor = (schemaV2: typeof firstSchema): SourceDescriptor => ({
      id: "counts",
      protocol: "geoservices-feature-service",
      locator: { url: "https://example.test/rest/services/counts/FeatureServer", serviceId: "counts", layerId: 0 },
      capabilities: capabilities(["query"]),
      schemaV2,
    });
    const first = createQueryIr({ descriptor: descriptor(firstSchema), schemaVersion: "legacy-v1" });
    const second = createQueryIr({ descriptor: descriptor(secondSchema), schemaVersion: "legacy-v1" });

    expect(first.source.schemaVersion).toBe("legacy-v1");
    expect(second.source.schemaVersion).toBe("legacy-v1");
    expect(first.source).not.toHaveProperty("schemaFingerprint");
    expect(second.source).not.toHaveProperty("schemaFingerprint");
    expect(first.source).toEqual(second.source);
    expect(hashQueryIr(first)).toBe(hashQueryIr(second));

    const verifiedFirst = createQueryIr({
      descriptor: descriptor(firstSchema),
      ...sourceSchemaV2QueryContext(descriptor(firstSchema)),
    });
    const verifiedSecond = createQueryIr({
      descriptor: descriptor(secondSchema),
      ...sourceSchemaV2QueryContext(descriptor(secondSchema)),
    });
    expect(verifiedFirst.source.schemaVersion).toBe(firstSchema.fingerprint);
    expect(verifiedSecond.source.schemaVersion).toBe(secondSchema.fingerprint);
    expect(hashQueryIr(verifiedFirst)).not.toBe(hashQueryIr(verifiedSecond));

    const forged = {
      ...descriptor(firstSchema),
      schemaV2: { ...firstSchema, fingerprint: secondSchema.fingerprint },
    };
    expect(() => sourceSchemaV2QueryContext(forged)).toThrow(/fingerprint/i);
  });

  it("preserves unknown native scalar types instead of coercing them to string", () => {
    const geoservices = geoServicesSourceSchemaV2(
      { id: 0, name: "Unknown", fields: [{ name: "value", type: "esriFieldTypeVendorThing" }] },
      { ...context, protocol: "geoservices-feature-service" },
    )!;
    const odata = odataSourceSchemaV2(
      {
        entitySets: { Unknown: "Example.Unknown" },
        keys: {},
        fields: { "Example.Unknown": [{ name: "value", type: "Example.CustomScalar" }] },
        capabilities: {},
      },
      "Unknown",
      context,
    )!;
    const geoparquet = geoParquetSourceSchemaV2(
      { columns: ["value"], fields: [{ name: "value", type: "VENDOR_SCALAR" }] },
      context,
    );

    for (const schema of [geoservices, odata, geoparquet]) {
      expect(schema.fields[0]?.type).toMatchObject({ kind: "unknown", reason: "unrecognized" });
      expect(schema.fields[0]?.native[0]?.name).toBeTruthy();
    }
  });

  it("does not erase timezone semantics from DuckDB TIME values", () => {
    const schema = geoParquetSourceSchemaV2(
      {
        columns: ["timetz", "time_with_zone", "timestamp_with_zone"],
        fields: [
          { name: "timetz", type: "TIMETZ" },
          { name: "time_with_zone", type: "TIME WITH TIME ZONE" },
          { name: "timestamp_with_zone", type: "TIMESTAMP WITH TIME ZONE" },
        ],
      },
      context,
    );

    expect(schema.fields.find((field) => field.name === "timetz")?.type).toMatchObject({
      kind: "unknown",
      reason: "unsupported",
    });
    expect(schema.fields.find((field) => field.name === "time_with_zone")?.type).toMatchObject({
      kind: "unknown",
      reason: "unsupported",
    });
    expect(schema.fields.find((field) => field.name === "timestamp_with_zone")?.type).toEqual({
      kind: "timestamp",
      unit: "microsecond",
      timezone: "utc",
    });
  });

  it("bounds recursively nested remote scalar types", () => {
    const nestedOdata = `${"Collection(".repeat(1_000)}Edm.Int32${")".repeat(1_000)}`;
    const metadata = parseOdataMetadata(`
      <edmx:Edmx Version="4.0">
        <Schema Namespace="Example">
          <EntityType Name="Asset"><Property Name="Nested" Type="${nestedOdata}"/></EntityType>
          <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
        </Schema>
      </edmx:Edmx>
    `);
    expect(() => odataSourceSchemaV2(metadata, "Assets", context)).toThrow(/nesting exceeds/);

    const nestedDuckDb = `INTEGER${"[]".repeat(1_000)}`;
    const schema = geoParquetSourceSchemaV2(
      { columns: ["nested"], fields: [{ name: "nested", type: nestedDuckDb }] },
      context,
    );
    let type: LogicalType | undefined = schema.fields[0]?.type;
    for (let depth = 0; depth < 31; depth += 1) {
      expect(type?.kind).toBe("list");
      type = type?.kind === "list" ? type.element : undefined;
    }
    expect(type).toMatchObject({ kind: "unknown", reason: "unsupported" });
  });

  it("normalizes GeoServices defaults and domains to logical JSON encodings", () => {
    const guid = "550E8400-E29B-41D4-A716-446655440000";
    const schema = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Typed values",
        fields: [
          {
            name: "Id64",
            type: "esriFieldTypeBigInteger",
            defaultValue: 42,
            domain: {
              type: "codedValue",
              codedValues: [
                { name: "Forty two", code: 42 },
                { name: "Forty three", code: "43" },
              ],
            },
          },
          {
            name: "ObservedAt",
            type: "esriFieldTypeDate",
            defaultValue: 0,
            domain: { type: "range", range: [0, 1000] },
          },
          {
            name: "GlobalId",
            type: "esriFieldTypeGUID",
            defaultValue: `{${guid}}`,
            domain: { type: "codedValue", codedValues: [{ code: `{${guid}}` }] },
          },
          {
            name: "OversizedId",
            type: "esriFieldTypeBigInteger",
            defaultValue: "9".repeat(100_000),
          },
        ],
      },
      { ...context, protocol: "geoservices-feature-service" },
    )!;

    expect(schema.fields.find((field) => field.name === "Id64")).toMatchObject({
      type: { kind: "integer", bits: 64, jsonEncoding: "string" },
      defaultValue: "42",
      domain: { state: "coded", values: [{ value: "42" }, { value: "43" }] },
      native: [{ definition: { defaultValue: 42, domain: { codedValues: [{ code: 42 }, { code: "43" }] } } }],
    });
    expect(schema.fields.find((field) => field.name === "ObservedAt")).toMatchObject({
      defaultValue: "1970-01-01T00:00:00.000Z",
      domain: {
        state: "range",
        minimum: { value: "1970-01-01T00:00:00.000Z" },
        maximum: { value: "1970-01-01T00:00:01.000Z" },
      },
    });
    expect(schema.fields.find((field) => field.name === "GlobalId")).toMatchObject({
      defaultValue: guid.toLowerCase(),
      domain: { state: "coded", values: [{ value: guid.toLowerCase() }] },
    });
    expect(schema.fields.find((field) => field.name === "OversizedId")).not.toHaveProperty("defaultValue");
  });

  it("degrades invalid or oversized GeoServices value metadata without dropping v2", () => {
    const oversizedValues = Array.from({ length: 600 }, (_, index) => ({
      code: index,
      name: `${index}-${"x".repeat(2048)}`,
    }));
    const schema = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Defensive values",
        fields: [
          { name: "BadDefault", type: "esriFieldTypeInteger", defaultValue: "not-an-integer" },
          {
            name: "BadDomain",
            type: "esriFieldTypeInteger",
            domain: { type: "codedValue", codedValues: [{ code: "not-an-integer" }] },
          },
          {
            name: "ReversedTime",
            type: "esriFieldTypeDate",
            domain: { type: "range", range: [1000, 0] },
          },
          {
            name: "LargeDomain",
            type: "esriFieldTypeInteger",
            domain: { type: "codedValue", codedValues: oversizedValues },
          },
        ],
      },
      { ...context, protocol: "geoservices-feature-service" },
    )!;

    expect(schema).toBeDefined();
    expect(schema.fields.find((field) => field.name === "BadDefault")).not.toHaveProperty("defaultValue");
    expect(schema.fields.find((field) => field.name === "BadDomain")?.domain).toMatchObject({
      state: "unknown",
      reason: "unrecognized",
    });
    expect(schema.fields.find((field) => field.name === "ReversedTime")?.domain).toMatchObject({
      state: "unknown",
      reason: "conflicting",
    });
    expect(schema.fields.find((field) => field.name === "LargeDomain")?.domain).toMatchObject({
      state: "unknown",
      reason: "limit-exceeded",
      native: { protocol: "geoservices-feature-service", name: "esriFieldTypeInteger" },
    });
  });

  it("keeps adapter domain and constraint knowledge states honest", () => {
    const geoServices = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Knowledge states",
        geometryType: "esriGeometryPoint",
        fields: [
          { name: "AbsentDomain", type: "esriFieldTypeInteger" },
          { name: "ExplicitNoDomain", type: "esriFieldTypeInteger", domain: null },
          { name: "Shape", type: "esriFieldTypeGeometry" },
        ],
      },
      { ...context, protocol: "geoservices-feature-service" },
    )!;
    expect(geoServices.fields.find((field) => field.name === "AbsentDomain")).toMatchObject({
      domain: { state: "unknown", reason: "not-reported" },
      constraints: { state: "unknown", reason: "not-reported" },
    });
    expect(geoServices.fields.find((field) => field.name === "ExplicitNoDomain")).toMatchObject({
      domain: { state: "none", reason: "unconstrained" },
      constraints: { state: "unknown", reason: "not-reported" },
    });
    expect(geoServices.fields.find((field) => field.name === "Shape")?.domain).toEqual({
      state: "none",
      reason: "not-applicable",
    });

    const odata = odataSourceSchemaV2(
      {
        entitySets: { Assets: "Example.Asset" },
        keys: { "Example.Asset": [] },
        fields: {
          "Example.Asset": [
            { name: "Name", type: "Edm.String" },
            { name: "Shape", type: "Edm.GeographyPoint", isSpatial: true },
          ],
        },
        capabilities: {},
      },
      "Assets",
      context,
    )!;
    expect(odata.fields.find((field) => field.name === "Name")).toMatchObject({
      domain: { state: "unknown", reason: "not-reported" },
      constraints: { state: "unknown", reason: "not-reported" },
    });
    expect(odata.fields.find((field) => field.name === "Shape")).toMatchObject({
      domain: { state: "none", reason: "not-applicable" },
      constraints: { state: "unknown", reason: "not-reported" },
    });

    const geoParquet = geoParquetSourceSchemaV2(
      {
        columns: ["id"],
        fields: [
          { name: "id", type: "INTEGER" },
          { name: "geometry", type: "BLOB" },
        ],
        geometry: {
          column: "geometry",
          encoding: "wkb",
          metadataState: "missing",
          geometryTypesState: "missing",
          crsState: "missing-metadata",
        },
      },
      context,
    );
    expect(geoParquet.fields.find((field) => field.name === "id")).toMatchObject({
      domain: { state: "unknown", reason: "not-reported" },
      constraints: { state: "unknown", reason: "not-reported" },
    });
    expect(geoParquet.fields.find((field) => field.name === "geometry")).toMatchObject({
      domain: { state: "none", reason: "not-applicable" },
      constraints: { state: "unknown", reason: "not-reported" },
    });
  });

  it("degrades malformed OData enum members without dropping the source schema", () => {
    const schema = odataSourceSchemaV2(
      {
        entitySets: { Assets: "Example.Asset" },
        keys: { "Example.Asset": [] },
        fields: { "Example.Asset": [{ name: "Status", type: "Example.BadStatus" }] },
        enumTypes: {
          BadStatus: {
            underlyingType: "Edm.Int32",
            isFlags: false,
            members: [{ name: "Malformed", value: "not-an-integer" }],
          },
        },
        capabilities: {},
      },
      "Assets",
      context,
    );

    expect(schema).toBeDefined();
    expect(schema?.fields[0]).toMatchObject({
      type: { kind: "string" },
      domain: { state: "unknown", reason: "unrecognized" },
    });
  });

  it("does not infer semantic time roles from scalar date/timestamp types", () => {
    const odata = odataSourceSchemaV2(
      {
        entitySets: { Events: "Example.Event" },
        keys: { "Example.Event": [] },
        fields: {
          "Example.Event": [
            { name: "BusinessDate", type: "Edm.Date" },
            { name: "RecordedAt", type: "Edm.DateTimeOffset" },
          ],
        },
        capabilities: {},
      },
      "Events",
      context,
    )!;
    const geoparquet = geoParquetSourceSchemaV2(
      {
        columns: ["business_date", "recorded_at"],
        fields: [
          { name: "business_date", type: "DATE" },
          { name: "recorded_at", type: "TIMESTAMP_NS" },
        ],
      },
      context,
    );
    const geoservices = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Explicit time",
        timeInfo: { startTimeField: "ObservedAt" },
        fields: [{ name: "ObservedAt", type: "esriFieldTypeDate" }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    )!;

    expect(odata.temporal).toEqual({ state: "none" });
    expect(odata.fields.every((field) => field.roles.length === 0)).toBe(true);
    expect(geoparquet.temporal).toEqual({ state: "none" });
    expect(geoparquet.fields.every((field) => field.roles.length === 0)).toBe(true);
    expect(geoservices.temporal).toEqual({ state: "instant", field: "ObservedAt" });
    expect(geoservices.fields[0]?.roles).toContain("time-instant");
  });

  it("isolates GeoServices timeInfo references to non-temporal fields", () => {
    const schema = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Invalid time field",
        timeInfo: { startTimeField: "Status" },
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID" },
          { name: "Status", type: "esriFieldTypeString" },
        ],
      },
      { ...context, protocol: "geoservices-feature-service" },
    );

    expect(schema).toBeDefined();
    expect(schema?.fields.map((field) => field.name)).toEqual(["OBJECTID", "Status"]);
    expect(schema?.temporal).toEqual({ state: "unknown", reason: "conflicting" });
    expect(schema?.fields.every((field) => field.roles.every((role) => !role.startsWith("time-")))).toBe(true);
  });

  it("keeps empty and invalid GeoParquet geometry metadata explicitly unknown", () => {
    const empty = geoParquetSourceSchemaV2(
      {
        columns: [],
        fields: [{ name: "geometry", type: "GEOMETRY", nullable: true }],
        geometry: {
          column: "geometry",
          encoding: "native",
          metadataState: "valid",
          geometryTypesState: "valid",
          geometryTypes: [],
          crsState: "absent",
          epochState: "absent",
        },
      },
      context,
    );
    const invalid = geoParquetSourceSchemaV2(
      {
        columns: [],
        fields: [{ name: "geometry", type: "GEOMETRY", nullable: true }],
        geometry: {
          column: "geometry",
          encoding: "native",
          metadataState: "invalid",
          geometryTypesState: "invalid",
          crsState: "invalid-metadata",
          epochState: "absent",
        },
      },
      context,
    );

    expect(empty.geometry).toMatchObject({
      state: "known",
      fields: [{ geometryTypes: { state: "unknown", reason: "missing" } }],
    });
    expect(invalid.geometry).toMatchObject({
      state: "known",
      fields: [
        {
          geometryTypes: { state: "unknown", reason: "unrecognized" },
          crs: { definition: { kind: "unknown", reason: "conflicting" } },
        },
      ],
    });
  });

  it("synthesizes fallback GeoParquet geometry fields without inventing CRS84", () => {
    const legacyProfile = {
      columns: ["name"],
      fields: [{ name: "name", type: "VARCHAR" }],
      geometry: {
        column: "geometry",
        encoding: "wkb" as const,
        metadataState: "missing" as const,
        geometryTypesState: "missing" as const,
        crsState: "missing-metadata" as const,
        epochState: "absent" as const,
      },
    };
    const schema = geoParquetSourceSchemaV2(legacyProfile, context);
    expect(schema.fields.map((field) => field.name)).toEqual(["geometry", "name"]);
    expect(schema.fields[0]).toMatchObject({ name: "geometry", type: { kind: "geometry" }, roles: ["geometry"] });
    expect(schema.geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "unknown", reason: "missing" } } }],
    });

    const discovered = buildSourceProfile({
      describe: [
        { column_name: "name", column_type: "VARCHAR" },
        { column_name: "geometry", column_type: "BLOB" },
      ],
    });
    expect(discovered.geometry?.crsState).toBe("missing-metadata");
    expect(discovered.crs).toBeUndefined();
    expect(geoParquetSourceSchemaV2(discovered, context).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "unknown", reason: "missing" } } }],
    });
  });

  it("applies the GeoParquet CRS84 default only to a present primary-column metadata object", () => {
    const describe = [{ column_name: "geometry", column_type: "BLOB" }];
    const incomplete = buildSourceProfile({
      describe,
      geoJson: JSON.stringify({ version: "1.1.0", primary_column: "geometry", columns: {} }),
    });
    expect(incomplete.geometry?.crsState).toBe("invalid-metadata");
    expect(incomplete.crs).toBeUndefined();
    expect(geoParquetSourceSchemaV2(incomplete, context).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "unknown", reason: "conflicting" } } }],
    });

    const incompleteColumn = buildSourceProfile({
      describe,
      geoJson: JSON.stringify({ version: "1.1.0", primary_column: "geometry", columns: { geometry: {} } }),
    });
    expect(incompleteColumn.geometry).toMatchObject({
      metadataState: "invalid",
      geometryTypesState: "invalid",
      crsState: "invalid-metadata",
    });
    expect(incompleteColumn.crs).toBeUndefined();
    expect(geoParquetSourceSchemaV2(incompleteColumn, context).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "unknown", reason: "conflicting" } } }],
    });

    const omittedCrs = buildSourceProfile({
      describe,
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: [] } },
      }),
    });
    expect(omittedCrs.geometry).toMatchObject({
      metadataState: "valid",
      geometryTypesState: "valid",
      crsState: "absent",
    });
    expect(omittedCrs.crs).toBe("OGC:CRS84");
    expect(geoParquetSourceSchemaV2(omittedCrs, context).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "authority", authority: "OGC", code: "CRS84" } } }],
    });

    const unknownFutureVersion = buildSourceProfile({
      describe,
      geoJson: JSON.stringify({
        version: "1.2.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "point", geometry_types: ["Point"] } },
      }),
    });
    expect(unknownFutureVersion.geometry?.metadataState).toBe("invalid");
    expect(unknownFutureVersion.crs).toBeUndefined();
  });

  it("validates GeoParquet encodings against the declared minor version", () => {
    const describe = [{ column_name: "geometry", column_type: "STRUCT<x DOUBLE, y DOUBLE>" }];
    const profile = (version: string) =>
      buildSourceProfile({
        describe,
        geoJson: JSON.stringify({
          version,
          primary_column: "geometry",
          columns: { geometry: { encoding: "point", geometry_types: ["Point"] } },
        }),
      });

    expect(profile("1.0.0").geometry?.metadataState).toBe("invalid");
    expect(profile("1.1.0").geometry).toMatchObject({
      metadataState: "valid",
      encoding: "native",
      runtimeSupported: false,
    });

    const wkbProfile = (version: string) =>
      buildSourceProfile({
        describe: [{ column_name: "geometry", column_type: "BLOB" }],
        geoJson: JSON.stringify({
          version,
          primary_column: "geometry",
          columns: { geometry: { encoding: "WKB", geometry_types: ["GeometryCollection Z"] } },
        }),
      });
    expect(wkbProfile("1.0.0").geometry).toMatchObject({
      metadataState: "valid",
      geometryTypesState: "valid",
      geometryTypes: ["GeometryCollection Z"],
    });
    expect(wkbProfile("1.1.0").geometry?.metadataState).toBe("valid");
    expect(wkbProfile("1.0.1").geometry?.metadataState).toBe("invalid");
    expect(wkbProfile("1.1.1").geometry?.metadataState).toBe("invalid");
  });

  it("fails GeoParquet metadata closed on contradictory encoding declarations", () => {
    const profile = (encoding: string, geometryTypes: readonly string[], columnType: string) =>
      buildSourceProfile({
        describe: [{ column_name: "geometry", column_type: columnType }],
        geoJson: JSON.stringify({
          version: "1.1.0",
          primary_column: "geometry",
          columns: { geometry: { encoding, geometry_types: geometryTypes } },
        }),
      });

    expect(profile("WKB", ["Point"], "STRUCT<x DOUBLE, y DOUBLE>").geometry).toMatchObject({
      metadataState: "invalid",
      runtimeSupported: false,
    });
    expect(profile("point", ["Polygon"], "STRUCT<x DOUBLE, y DOUBLE>").geometry).toMatchObject({
      metadataState: "invalid",
      runtimeSupported: false,
    });
  });

  it("preserves secondary geometry columns as v1 query attributes", () => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "geometry", column_type: "BLOB" },
        { column_name: "alternate_geometry", column_type: "BLOB" },
        { column_name: "name", column_type: "VARCHAR" },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: { encoding: "WKB", geometry_types: ["Point"] },
          alternate_geometry: { encoding: "WKB", geometry_types: ["Point"] },
        },
      }),
    });

    expect(profile.geometry?.column).toBe("geometry");
    expect(profile.geometries?.map((geometry) => geometry.column)).toEqual(["geometry", "alternate_geometry"]);
    expect(profile.columns).toEqual(["alternate_geometry", "name"]);
  });

  it.each([
    ["point", "Point", "STRUCT(x DOUBLE, y DOUBLE)"],
    ["linestring", "LineString", "STRUCT(x DOUBLE, y DOUBLE)[]"],
    ["multipoint", "MultiPoint", "LIST(STRUCT(x DOUBLE, y DOUBLE))"],
    ["polygon", "Polygon", "STRUCT<x DOUBLE, y DOUBLE>[][]"],
    ["multilinestring", "MultiLineString", "LIST<LIST<STRUCT<x DOUBLE, y DOUBLE>>>"],
    ["multipolygon", "MultiPolygon", "STRUCT(x DOUBLE, y DOUBLE)[][][]"],
    ["point", "Point Z", "STRUCT(x DOUBLE, y DOUBLE, z DOUBLE)"],
  ])("accepts the exact GeoParquet native layout for %s", (encoding, geometryType, columnType) => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: columnType }],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding, geometry_types: [geometryType] } },
      }),
    });
    expect(profile.geometry).toMatchObject({ metadataState: "valid", runtimeSupported: false });
  });

  it.each([
    ["polygon", "Polygon", "STRUCT(x DOUBLE, y DOUBLE)[]"],
    ["linestring", "LineString", "STRUCT(x DOUBLE, y DOUBLE)[][]"],
    ["multipolygon", "MultiPolygon", "STRUCT(x DOUBLE, y DOUBLE)[][]"],
    ["point", "Point Z", "STRUCT(x DOUBLE, y DOUBLE)"],
    ["point", "Point", "STRUCT(x DOUBLE, y DOUBLE, z DOUBLE)"],
    ["point", "Point", "STRUCT(x DOUBLE, y DOUBLE, m DOUBLE)"],
    ["point", "Point", "STRUCT(x FLOAT, y FLOAT)"],
    ["point", "Point", "STRUCT(X DOUBLE, y DOUBLE)"],
    ["point", "Point Z", "STRUCT(x DOUBLE, y DOUBLE, z FLOAT)"],
  ])("rejects a contradictory GeoParquet native layout for %s", (encoding, geometryType, columnType) => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: columnType }],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding, geometry_types: [geometryType] } },
      }),
    });
    expect(profile.geometry).toMatchObject({ metadataState: "invalid" });
  });

  it.each([
    ["point", "GEOMETRY_VENDOR"],
    ["point", "STRUCT(payload GEOMETRY)"],
    ["WKB", "STRUCT(payload BLOB)"],
  ])("does not let broad runtime type detection certify %s metadata over %s", (encoding, columnType) => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: columnType }],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding, geometry_types: ["Point"] } },
      }),
    });
    expect(profile.geometry).toMatchObject({ metadataState: "invalid" });
  });

  it("rejects mixed 2D and 3D declarations against one native coordinate layout", () => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "STRUCT(x DOUBLE, y DOUBLE, z DOUBLE)" }],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "point", geometry_types: ["Point", "Point Z"] } },
      }),
    });
    expect(profile.geometry).toMatchObject({ metadataState: "invalid" });
  });

  it("rejects deeply nested GeoParquet metadata without recursive traversal", () => {
    let crs: JsonValue = { name: "leaf" };
    for (let depth = 0; depth < 40; depth += 1) crs = { nested: crs };
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "BLOB" }],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: ["Point"], crs } },
      }),
    });
    expect(profile.geometry).toMatchObject({ metadataState: "invalid" });
  });

  it.each([
    {
      name: "unsupported major version",
      geo: {
        version: "2.0.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: [] } },
      },
    },
    {
      name: "missing version",
      geo: { primary_column: "geometry", columns: { geometry: { encoding: "WKB", geometry_types: [] } } },
    },
    {
      name: "primary absent from metadata columns",
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: { other: { encoding: "WKB", geometry_types: [] } },
      },
    },
    {
      name: "missing encoding",
      geo: { version: "1.1.0", primary_column: "geometry", columns: { geometry: { geometry_types: [] } } },
    },
    {
      name: "missing geometry_types",
      geo: { version: "1.1.0", primary_column: "geometry", columns: { geometry: { encoding: "WKB" } } },
    },
    {
      name: "non-PROJJSON CRS scalar",
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: [], crs: "EPSG:4326" } },
      },
    },
    {
      name: "invalid edge model",
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: [], edges: "rhumb" } },
      },
    },
    {
      name: "clockwise orientation",
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: [], orientation: "clockwise" } },
      },
    },
    {
      name: "malformed bbox",
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: [], bbox: [0, 0, 1] } },
      },
    },
    {
      name: "incomplete covering",
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: [],
            covering: { bbox: { xmin: ["bbox", "xmin"] } },
          },
        },
      },
    },
    {
      name: "unknown column metadata member",
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: [], vendor_hint: true } },
      },
    },
    {
      name: "1.0 covering extension",
      geo: {
        version: "1.0.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: [],
            covering: {
              bbox: {
                xmin: ["bounds", "xmin"],
                xmax: ["bounds", "xmax"],
                ymin: ["bounds", "ymin"],
                ymax: ["bounds", "ymax"],
              },
            },
          },
        },
      },
    },
    {
      name: "covering paths name different columns",
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: [],
            covering: {
              bbox: {
                xmin: ["bounds", "xmin"],
                xmax: ["other_bounds", "xmax"],
                ymin: ["bounds", "ymin"],
                ymax: ["bounds", "ymax"],
              },
            },
          },
        },
      },
    },
  ])("does not grant conformance-derived defaults for $name", ({ geo }) => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "geometry", column_type: "BLOB" },
        { column_name: "other", column_type: "BLOB" },
      ],
      geoJson: JSON.stringify(geo),
    });
    expect(profile.geometry?.column).toBe("geometry");
    expect(profile.geometry?.metadataState).toBe("invalid");
    expect(profile.geometry?.bboxColumn).toBeUndefined();
    expect(profile.crs).toBeUndefined();
    const schema = geoParquetSourceSchemaV2(profile, context);
    expect(schema.geometry.state).toBe("known");
    if (schema.geometry.state !== "known") throw new Error("expected known geometry inventory");
    expect(schema.geometry.fields.find((field) => field.field === "geometry")).toMatchObject({
      geometryTypes: { state: "unknown" },
      crs: { definition: { kind: "unknown", reason: "conflicting" } },
    });
  });

  it("ignores bounded top-level extensions without changing normalized schema identity", () => {
    const base = {
      version: "1.1.0",
      primary_column: "geometry",
      columns: { geometry: { encoding: "WKB", geometry_types: ["Point"] } },
    };
    const profileFor = (geo: Record<string, unknown>) =>
      buildSourceProfile({
        describe: [{ column_name: "geometry", column_type: "BLOB" }],
        geoJson: JSON.stringify(geo),
      });
    const plainProfile = profileFor(base);
    const extendedProfile = profileFor({
      ...base,
      vendor_extension: { implementation: "example", revision: 7 },
    });
    const plainSchema = geoParquetSourceSchemaV2(plainProfile, context);
    const extendedSchema = geoParquetSourceSchemaV2(extendedProfile, context);

    expect(extendedProfile.geometry?.metadataState).toBe("valid");
    expect(extendedProfile.crs).toBe("OGC:CRS84");
    expect(extendedSchema.fingerprint).toBe(plainSchema.fingerprint);

    const oversized = profileFor({ ...base, vendor_extension: "x".repeat(1024 * 1024) });
    expect(oversized.geometry).toMatchObject({ metadataState: "invalid", crsState: "invalid-metadata" });
    expect(oversized.crs).toBeUndefined();
  });

  it.each([
    {
      dimensions: "2D",
      geometryType: "Point",
      bboxType: "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)",
    },
    {
      dimensions: "3D",
      geometryType: "Point Z",
      bboxType: "STRUCT(xmin FLOAT, ymin FLOAT, zmin FLOAT, xmax FLOAT, ymax FLOAT, zmax FLOAT)",
    },
  ])("accepts an exact $dimensions GeoParquet 1.1 covering signature", ({ geometryType, bboxType }) => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "geometry", column_type: "BLOB", null: "YES" },
        { column_name: "bounds", column_type: bboxType, null: "YES" },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: [geometryType],
            covering: {
              bbox: {
                xmin: ["bounds", "xmin"],
                xmax: ["bounds", "xmax"],
                ymin: ["bounds", "ymin"],
                ymax: ["bounds", "ymax"],
              },
            },
          },
        },
      }),
    });
    expect(profile.geometry).toMatchObject({ metadataState: "valid", bboxColumn: "bounds" });
    expect(profile.fields?.map((field) => field.name)).toEqual(["geometry"]);
  });

  it.each([
    ["invalid order", "STRUCT(xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE)", "YES", "YES"],
    ["missing field", "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE)", "YES", "YES"],
    ["extra field", "STRUCT(xmin DOUBLE, ymin DOUBLE, xmid DOUBLE, xmax DOUBLE, ymax DOUBLE)", "YES", "YES"],
    ["mixed numeric types", "STRUCT(xmin DOUBLE, ymin FLOAT, xmax DOUBLE, ymax DOUBLE)", "YES", "YES"],
    ["non-floating fields", "STRUCT(xmin INTEGER, ymin INTEGER, xmax INTEGER, ymax INTEGER)", "YES", "YES"],
    ["repeated bbox", "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)[]", "YES", "YES"],
    ["mismatched repetition", "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)", "YES", "NO"],
    ["unknown repetition", "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)", undefined, "YES"],
  ] as const)("rejects a covering with $0", (_name, bboxType, geometryNull, bboxNull) => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "geometry", column_type: "BLOB", ...(geometryNull ? { null: geometryNull } : {}) },
        { column_name: "bounds", column_type: bboxType, null: bboxNull },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            covering: {
              bbox: {
                xmin: ["bounds", "xmin"],
                ymin: ["bounds", "ymin"],
                xmax: ["bounds", "xmax"],
                ymax: ["bounds", "ymax"],
              },
            },
          },
        },
      }),
    });
    expect(profile.geometry).toMatchObject({ metadataState: "invalid" });
    expect(profile.geometry?.bboxColumn).toBeUndefined();
    expect(profile.fields?.map((field) => field.name)).toEqual(["geometry", "bounds"]);
    expect(profile.columns).toContain("bounds");
  });

  it.each([
    {
      name: "unknown covering member",
      covering: {
        bbox: {
          xmin: ["bounds", "xmin"],
          ymin: ["bounds", "ymin"],
          xmax: ["bounds", "xmax"],
          ymax: ["bounds", "ymax"],
        },
        vendor_hint: true,
      },
    },
    {
      name: "unknown bbox path member",
      covering: {
        bbox: {
          xmin: ["bounds", "xmin"],
          ymin: ["bounds", "ymin"],
          xmax: ["bounds", "xmax"],
          ymax: ["bounds", "ymax"],
          vendor_hint: ["bounds", "vendor_hint"],
        },
      },
    },
  ])("rejects $name without consuming its physical column", ({ covering }) => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "geometry", column_type: "BLOB", null: "NO" },
        {
          column_name: "bounds",
          column_type: "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)",
          null: "NO",
        },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: ["Point"], covering } },
      }),
    });
    expect(profile.geometry).toMatchObject({ metadataState: "invalid" });
    expect(profile.geometry?.bboxColumn).toBeUndefined();
    expect(profile.fields?.map((field) => field.name)).toEqual(["geometry", "bounds"]);
    expect(profile.columns).toContain("bounds");
  });

  it("distinguishes malformed GeoParquet JSON from absent metadata", () => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "BLOB" }],
      geoJson: '{"version":"1.1.0",',
    });
    expect(profile.geometry).toMatchObject({
      metadataState: "invalid",
      geometryTypesState: "invalid",
      crsState: "invalid-metadata",
    });
    expect(geoParquetSourceSchemaV2(profile, context).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "unknown", reason: "conflicting" } } }],
    });
  });

  it.each([
    { hasZ: false, hasM: false, expected: "xy" },
    { hasZ: true, hasM: false, expected: "xyz" },
    { hasZ: false, hasM: true, expected: "xym" },
    { hasZ: true, hasM: true, expected: "xyzm" },
    { hasZ: undefined, hasM: undefined, expected: "unknown" },
  ] as const)("honors GeoServices ordinate metadata as $expected", ({ hasZ, hasM, expected }) => {
    const schema = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Geometry",
        geometryType: "esriGeometryPoint",
        ...(hasZ === undefined ? {} : { hasZ }),
        ...(hasM === undefined ? {} : { hasM }),
        fields: [{ name: "Shape", type: "esriFieldTypeGeometry" }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    );
    expect(schema?.geometry).toMatchObject({ state: "known", fields: [{ layout: expected }] });
  });

  it("uses GeoServices latestWkid for missing and legacy Web Mercator identifiers", () => {
    for (const spatialReference of [{ latestWkid: 4326 }, { wkid: 102100, latestWkid: 3857 }]) {
      const schema = geoServicesSourceSchemaV2(
        {
          id: 0,
          name: "Geometry",
          geometryType: "esriGeometryPoint",
          spatialReference,
          fields: [{ name: "Shape", type: "esriFieldTypeGeometry" }],
        },
        { ...context, protocol: "geoservices-feature-service" },
      );
      expect(schema?.geometry).toMatchObject({
        state: "known",
        fields: [
          { crs: { definition: { kind: "authority", authority: "EPSG", code: String(spatialReference.latestWkid) } } },
        ],
      });
    }

    const conflicting = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Conflicting alias",
        geometryType: "esriGeometryPoint",
        spatialReference: { wkid: 102100, latestWkid: 4326 },
        fields: [{ name: "Shape", type: "esriFieldTypeGeometry" }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    );
    expect(conflicting?.geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "unknown", reason: "conflicting" } } }],
    });
  });

  it("synthesizes a stable GeoServices geometry field without changing attribute fields", () => {
    const schema = geoServicesSourceSchemaV2(
      {
        id: 7,
        name: "Parcels",
        geometryType: "esriGeometryPolygon",
        hasZ: false,
        hasM: false,
        spatialReference: { wkid: 4326 },
        objectIdField: "OBJECTID",
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID", nullable: false },
          { name: "geometry", type: "esriFieldTypeString" },
          { name: "owner", type: "esriFieldTypeString" },
        ],
      },
      { ...context, protocol: "geoservices-feature-service" },
    )!;

    expect(schema.fields.map((field) => field.name)).toEqual(["OBJECTID", "geometry", "geometry_2", "owner"]);
    expect(schema.fields.find((field) => field.name === "geometry")).toMatchObject({ type: { kind: "string" } });
    expect(schema.fields.find((field) => field.name === "geometry_2")).toMatchObject({
      type: { kind: "geometry" },
      roles: ["geometry"],
    });
    expect(schema.geometry).toMatchObject({
      state: "known",
      fields: [{ field: "geometry_2", geometryTypes: { state: "mixed", types: ["MultiPolygon", "Polygon"] } }],
      primaryField: { state: "known", field: "geometry_2" },
    });
  });

  it("does not assign an authority to arbitrary GeoServices WKIDs", () => {
    const schema = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Local grid",
        geometryType: "esriGeometryPoint",
        spatialReference: { wkid: 26904, latestWkid: 26904 },
        fields: [{ name: "id", type: "esriFieldTypeInteger" }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    );
    expect(schema?.geometry).toMatchObject({
      state: "known",
      fields: [
        {
          crs: {
            definition: { kind: "unknown", reason: "unrecognized" },
            coordinateOrder: {
              state: "known",
              source: "encoding",
              axes: [
                { name: "x", direction: "other", unit: "unknown" },
                { name: "y", direction: "other", unit: "unknown" },
              ],
            },
          },
        },
      ],
    });

    const wkt = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "WKT grid",
        geometryType: "esriGeometryPoint",
        spatialReference: { wkt: 'LOCAL_CS["Engineering grid"]' },
        fields: [{ name: "Shape", type: "esriFieldTypeGeometry" }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    );
    expect(wkt?.geometry).toMatchObject({
      state: "known",
      fields: [
        {
          crs: {
            definition: { kind: "wkt", dialect: "wkt1", validation: "unverified" },
            coordinateOrder: {
              state: "known",
              source: "encoding",
              axes: [
                { name: "x", direction: "other", unit: "unknown" },
                { name: "y", direction: "other", unit: "unknown" },
              ],
            },
          },
        },
      ],
    });

    const boundWkt = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Bound WKT grid",
        geometryType: "esriGeometryPoint",
        spatialReference: {
          wkt: 'BOUNDCRS[SOURCECRS[GEOGCRS["Source"]],TARGETCRS[GEOGCRS["Target"]],ABRIDGEDTRANSFORMATION["Shift"]]',
        },
        fields: [{ name: "Shape", type: "esriFieldTypeGeometry" }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    );
    expect(boundWkt?.geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "wkt", dialect: "wkt2", validation: "unverified" } } }],
    });

    for (const malformedWkt of [
      "Engineering grid",
      'GEOGCS["Unclosed"',
      'GEOGCS["Closed"] trailing-junk',
      "PROJCRS[garbage]",
      'VENDORCRS["Unsupported root"]',
    ]) {
      const malformed = geoServicesSourceSchemaV2(
        {
          id: 0,
          name: "Malformed WKT grid",
          geometryType: "esriGeometryPoint",
          spatialReference: { wkt: malformedWkt },
          fields: [{ name: "Shape", type: "esriFieldTypeGeometry" }],
        },
        { ...context, protocol: "geoservices-feature-service" },
      );
      expect(malformed?.geometry).toMatchObject({
        state: "known",
        fields: [
          {
            crs: {
              definition: {
                kind: "unknown",
                reason: "unrecognized",
                native: { definition: { wkt: malformedWkt } },
              },
            },
          },
        ],
      });
    }
  });

  it("rejects contradictory GeoServices WKID pairs after canonicalizing known aliases", () => {
    const schemaFor = (wkid: number, latestWkid: number) =>
      geoServicesSourceSchemaV2(
        {
          id: 0,
          name: "WKID pair",
          geometryType: "esriGeometryPoint",
          spatialReference: { wkid, latestWkid },
          fields: [{ name: "Shape", type: "esriFieldTypeGeometry" }],
        },
        { ...context, protocol: "geoservices-feature-service" },
      )!;

    expect(schemaFor(4326, 3857).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "unknown", reason: "conflicting" } } }],
    });
    expect(schemaFor(102113, 3857).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "authority", authority: "EPSG", code: "3857" } } }],
    });
    expect(schemaFor(26704, 26904).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { definition: { kind: "unknown", reason: "unrecognized" } } }],
    });
  });

  it.each([
    { name: "measured geometry", geometryTypes: ["Point M"], expectedReason: "unrecognized" },
    { name: "four-dimensional geometry", geometryTypes: ["Point ZM"], expectedReason: "unrecognized" },
    { name: "duplicate geometry type", geometryTypes: ["Point", "Point"], expectedReason: "conflicting" },
  ])("rejects invalid GeoParquet 1.1 geometry_types: $name", ({ geometryTypes, expectedReason }) => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "BLOB" }],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: geometryTypes } },
      }),
    });
    expect(profile.geometry?.metadataState).toBe("invalid");
    expect(profile.geometry?.geometryTypesState).toBe(expectedReason === "conflicting" ? "conflicting" : "invalid");
    const schema = geoParquetSourceSchemaV2(profile, context);
    expect(schema.geometry).toMatchObject({
      state: "known",
      fields: [{ geometryTypes: { state: "unknown", reason: expectedReason } }],
    });
  });

  it("maps every finite GeoParquet coordinate epoch and fails non-numeric epochs closed", () => {
    const profileFor = (epoch: unknown) =>
      buildSourceProfile({
        describe: [{ column_name: "geometry", column_type: "BLOB" }],
        geoJson: JSON.stringify({
          version: "1.1.0",
          primary_column: "geometry",
          columns: { geometry: { encoding: "WKB", geometry_types: ["Point"], epoch } },
        }),
      });

    const valid = profileFor(2020.5);
    expect(valid.geometry).toMatchObject({ epochState: "valid", coordinateEpoch: 2020.5 });
    expect(geoParquetSourceSchemaV2(valid, context).geometry).toMatchObject({
      state: "known",
      fields: [
        {
          crs: {
            definition: { kind: "authority", authority: "OGC", code: "CRS84" },
            coordinateEpoch: 2020.5,
          },
        },
      ],
    });

    const historical = profileFor(-1);
    expect(historical.geometry).toMatchObject({ metadataState: "valid", epochState: "valid", coordinateEpoch: -1 });
    expect(geoParquetSourceSchemaV2(historical, context).geometry).toMatchObject({
      state: "known",
      fields: [{ crs: { coordinateEpoch: -1 } }],
    });

    const invalid = profileFor("not-a-number");
    expect(invalid.geometry).toMatchObject({
      metadataState: "invalid",
      epochState: "invalid",
      epochValue: "not-a-number",
    });
    expect(geoParquetSourceSchemaV2(invalid, context).geometry).toMatchObject({
      state: "known",
      fields: [
        {
          crs: {
            definition: {
              kind: "unknown",
              reason: "conflicting",
              native: { definition: { epochState: "invalid", epoch: "not-a-number" } },
            },
            coordinateOrder: { state: "unknown", reason: "conflicting" },
          },
        },
      ],
    });
  });

  it("uses GeoParquet x/y payload order instead of PROJJSON definition-axis order", () => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "BLOB" }],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: {
              $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
              type: "GeographicCRS",
              name: "WGS 84",
              datum: {
                type: "GeodeticReferenceFrame",
                name: "World Geodetic System 1984",
                ellipsoid: {
                  type: "Ellipsoid",
                  name: "WGS 84",
                  semi_major_axis: 6378137,
                  inverse_flattening: 298.257223563,
                },
              },
              coordinate_system: {
                subtype: "ellipsoidal",
                axis: [
                  { name: "Geodetic latitude", abbreviation: "Lat", direction: "north", unit: "degree" },
                  { name: "Geodetic longitude", abbreviation: "Lon", direction: "east", unit: "degree" },
                ],
              },
            },
          },
        },
      }),
    });
    const schema = geoParquetSourceSchemaV2(profile, context);
    expect(schema.geometry).toMatchObject({
      state: "known",
      fields: [
        {
          crs: {
            definition: {
              kind: "projjson",
              definitionAxisOrder: { state: "known", axes: [{ direction: "north" }, { direction: "east" }] },
            },
            coordinateOrder: {
              state: "known",
              source: "encoding",
              axes: [{ direction: "east" }, { direction: "north" }],
            },
          },
        },
      ],
    });
  });

  it("keeps GeoParquet x/y payload order when CRS semantics cannot identify axis directions", () => {
    const profileFor = (crs: unknown) =>
      buildSourceProfile({
        describe: [{ column_name: "geometry", column_type: "BLOB" }],
        geoJson: JSON.stringify({
          version: "1.1.0",
          primary_column: "geometry",
          columns: {
            geometry: {
              encoding: "WKB",
              geometry_types: ["Point"],
              crs,
            },
          },
        }),
      });
    const conservativeOrder = {
      state: "known",
      source: "encoding",
      axes: [
        { name: "x", direction: "other", unit: "unknown" },
        { name: "y", direction: "other", unit: "unknown" },
      ],
    };

    const noCrs = geoParquetSourceSchemaV2(profileFor(null), context);
    expect(noCrs.geometry).toMatchObject({ state: "known", fields: [{ crs: { coordinateOrder: conservativeOrder } }] });

    const geocentric = geoParquetSourceSchemaV2(
      profileFor({
        $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
        type: "GeodeticCRS",
        name: "Geocentric WGS 84",
        datum: {
          type: "GeodeticReferenceFrame",
          name: "World Geodetic System 1984",
          ellipsoid: {
            type: "Ellipsoid",
            name: "WGS 84",
            semi_major_axis: 6378137,
            inverse_flattening: 298.257223563,
          },
        },
        coordinate_system: {
          subtype: "Cartesian",
          axis: [
            { name: "Geocentric X", abbreviation: "X", direction: "geocentricX", unit: "metre" },
            { name: "Geocentric Y", abbreviation: "Y", direction: "geocentricY", unit: "metre" },
            { name: "Geocentric Z", abbreviation: "Z", direction: "geocentricZ", unit: "metre" },
          ],
        },
      }),
      context,
    );
    expect(geocentric.geometry).toMatchObject({
      state: "known",
      fields: [
        {
          crs: {
            definition: { kind: "projjson" },
            coordinateOrder: conservativeOrder,
          },
        },
      ],
    });
  });

  it("retains GeoParquet 1.0 payload order when v0.5 PROJJSON cannot be promoted to v0.7", () => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "BLOB" }],
      geoJson: JSON.stringify({
        version: "1.0.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: {
              $schema: "https://proj.org/schemas/v0.5/projjson.schema.json",
              type: "GeographicCRS",
              name: "WGS 84",
              datum: {
                type: "GeodeticReferenceFrame",
                name: "World Geodetic System 1984",
                ellipsoid: {
                  type: "Ellipsoid",
                  name: "WGS 84",
                  semi_major_axis: 6378137,
                  inverse_flattening: 298.257223563,
                },
              },
            },
          },
        },
      }),
    });
    const schema = geoParquetSourceSchemaV2(profile, context);

    expect(profile.geometry).toMatchObject({ metadataState: "valid", crsState: "value" });
    expect(schema.geometry).toMatchObject({
      state: "known",
      fields: [
        {
          crs: {
            definition: {
              kind: "unknown",
              reason: "unrecognized",
              native: {
                definition: {
                  crs: { $schema: "https://proj.org/schemas/v0.5/projjson.schema.json" },
                },
              },
            },
            coordinateOrder: {
              state: "known",
              source: "encoding",
              axes: [
                { name: "x", direction: "other", unit: "unknown" },
                { name: "y", direction: "other", unit: "unknown" },
              ],
            },
          },
        },
      ],
    });
  });

  it("preserves GeoParquet field and geometry inventory when PROJJSON is invalid", () => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "id", column_type: "INTEGER" },
        { column_name: "geometry", column_type: "BLOB" },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: {
              $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
              type: "GeographicCRS",
              name: "Invalid but bounded CRS",
              datum: { type: "GeodeticReferenceFrame", name: "Missing required ellipsoid" },
            },
          },
        },
      }),
    });
    const schema = geoParquetSourceSchemaV2(profile, context);

    expect(schema.fields.map((field) => field.name)).toEqual(["geometry", "id"]);
    expect(schema.geometry).toMatchObject({
      state: "known",
      fields: [
        {
          field: "geometry",
          geometryTypes: { state: "known", type: "Point" },
          crs: { definition: { kind: "unknown", reason: "unrecognized" } },
        },
      ],
      primaryField: { state: "known", field: "geometry" },
    });
  });

  it("does not resolve a non-PROJJSON GeoParquet CRS string", () => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "id", column_type: "INTEGER" },
        { column_name: "geometry", column_type: "BLOB" },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: "EPSG:4326",
          },
        },
      }),
    });

    expect(profile.geometry?.metadataState).toBe("invalid");
    expect(profile.crs).toBeUndefined();
    expect(geoParquetSourceSchemaV2(profile, context).geometry).toMatchObject({
      state: "known",
      fields: [
        {
          field: "geometry",
          geometryTypes: { state: "unknown" },
          crs: {
            definition: {
              kind: "unknown",
              reason: "conflicting",
              native: { definition: { crs: "EPSG:4326" } },
            },
          },
        },
      ],
    });
  });

  it("retains every GeoParquet geometry column and its primary-field selection", () => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "id", column_type: "INTEGER" },
        { column_name: "footprint", column_type: "BLOB" },
        { column_name: "centroid", column_type: "BLOB" },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "footprint",
        columns: {
          footprint: { encoding: "WKB", geometry_types: ["Polygon"] },
          centroid: { encoding: "WKB", geometry_types: ["Point"], crs: null },
        },
      }),
    });
    expect(profile.geometries?.map((geometry) => geometry.column)).toEqual(["footprint", "centroid"]);

    const schema = geoParquetSourceSchemaV2(profile, context);
    expect(schema.fields.filter((field) => field.type.kind === "geometry").map((field) => field.name)).toEqual([
      "centroid",
      "footprint",
    ]);
    expect(schema.geometry).toMatchObject({
      state: "known",
      fields: [
        {
          field: "centroid",
          geometryTypes: { state: "known", type: "Point" },
          crs: { definition: { kind: "unknown" } },
        },
        {
          field: "footprint",
          geometryTypes: { state: "known", type: "Polygon" },
          crs: { definition: { kind: "authority", authority: "OGC", code: "CRS84" } },
        },
      ],
      primaryField: { state: "known", field: "footprint" },
    });
  });

  it("threads full paths through nested DuckDB STRUCT and LIST fields", () => {
    const schema = geoParquetSourceSchemaV2(
      {
        columns: ["record"],
        fields: [
          {
            name: "record",
            type: "STRUCT(address STRUCT(city VARCHAR), items STRUCT(code INTEGER)[])",
          },
        ],
      },
      context,
    );
    const record = schema.fields[0]?.type;
    expect(record).toMatchObject({
      kind: "struct",
      fields: [
        {
          name: "address",
          path: ["record", "address"],
          type: { kind: "struct", fields: [{ path: ["record", "address", "city"] }] },
        },
        {
          name: "items",
          path: ["record", "items"],
          type: { kind: "list", element: { kind: "struct", fields: [{ path: ["record", "items", "code"] }] } },
        },
      ],
    });
  });

  it("maps OData complex, enum, and open entity-type metadata", () => {
    const metadata = parseOdataMetadata(`
      <Schema Namespace="Example">
        <EnumType Name="Status"><Member Name="Active" Value="1"/><Member Name="Retired" Value="2"/></EnumType>
        <ComplexType Name="Address"><Property Name="Street" Type="Edm.String" Nullable="false"/></ComplexType>
        <EntityType Name="Asset" OpenType="TRUE">
          <Key><PropertyRef Name="Id"/></Key>
          <Property Name="Id" Type="Edm.Int32" Nullable="false"/>
          <Property Name="Status" Type="Example.Status"/>
          <Property Name="Address" Type="Example.Address"/>
        </EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
      </Schema>
    `);
    const schema = odataSourceSchemaV2(metadata, "Assets", context)!;
    expect(schema.openContent).toBe("open");
    expect(schema.fields.find((field) => field.name === "Status")).toMatchObject({
      type: { kind: "string" },
      domain: { state: "coded", values: [{ value: "Active" }, { value: "Retired" }] },
      native: [
        {
          definition: {
            enumType: {
              members: [
                { name: "Active", value: 1 },
                { name: "Retired", value: 2 },
              ],
            },
          },
        },
      ],
    });
    expect(schema.fields.find((field) => field.name === "Address")?.type).toMatchObject({
      kind: "struct",
      fields: [{ name: "Street", path: ["Address", "Street"], type: { kind: "string" } }],
    });
  });

  it("fails closed for selected OData entity and complex BaseType inheritance", () => {
    const inheritedEntity = parseOdataMetadata(`
      <Schema Namespace="Example">
        <EntityType Name="Base"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>
        <EntityType Name="Derived" BaseType="Example.Base"><Property Name="Name" Type="Edm.String"/></EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Derived"/></EntityContainer>
      </Schema>
    `);
    expect(() => odataSourceSchemaV2(inheritedEntity, "Assets", context)).toThrow(/BaseType inheritance.*Derived/);

    const inheritedComplex = parseOdataMetadata(`
      <Schema Namespace="Example">
        <ComplexType Name="BaseAddress"><Property Name="City" Type="Edm.String"/></ComplexType>
        <ComplexType Name="Address" BaseType="Example.BaseAddress"><Property Name="Street" Type="Edm.String"/></ComplexType>
        <EntityType Name="Asset"><Property Name="Address" Type="Example.Address"/></EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
      </Schema>
    `);
    expect(() => odataSourceSchemaV2(inheritedComplex, "Assets", context)).toThrow(/BaseType inheritance.*Address/);
  });

  it("fails closed for ambiguous qualified OData type names without blocking unrelated complete types", () => {
    const ambiguous = parseOdataMetadata(`
      <Schema Namespace="A">
        <EntityType Name="Asset"><Property Name="A" Type="Edm.String"/></EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="A.Asset"/></EntityContainer>
      </Schema>
      <Schema Namespace="B"><EntityType Name="Asset"><Property Name="B" Type="Edm.String"/></EntityType></Schema>
    `);
    expect(() => odataSourceSchemaV2(ambiguous, "Assets", context)).toThrow(/ambiguous qualified type name.*Asset/);

    const unrelatedInheritance = parseOdataMetadata(`
      <Schema Namespace="Example">
        <EntityType Name="Safe"><Property Name="Name" Type="Edm.String"/></EntityType>
        <EntityType Name="Base"><Property Name="BaseValue" Type="Edm.String"/></EntityType>
        <EntityType Name="Derived" BaseType="Example.Base"><Property Name="DerivedValue" Type="Edm.String"/></EntityType>
        <EntityContainer Name="Container"><EntitySet Name="SafeSet" EntityType="Example.Safe"/></EntityContainer>
      </Schema>
    `);
    expect(odataSourceSchemaV2(unrelatedInheritance, "SafeSet", context)).toMatchObject({
      openContent: "unknown",
      fields: [{ name: "Name" }],
    });
  });

  it("supports CSDL 4.01 and fails closed for unreviewed versions and open complex types", () => {
    const csdl401 = parseOdataMetadata(`
      <edmx:Edmx Version="4.01">
        <Schema Namespace="Example">
          <EntityType Name="Asset"><Property Name="Name" Type="Edm.String"/></EntityType>
          <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
        </Schema>
      </edmx:Edmx>
    `);
    expect(odataSourceSchemaV2(csdl401, "Assets", context)).toMatchObject({
      openContent: "closed",
      fields: [{ name: "Name" }],
    });

    const unreviewed = parseOdataMetadata(`
      <edmx:Edmx Version="4.02">
        <Schema Namespace="Example">
          <EntityType Name="Asset"><Property Name="Name" Type="Edm.String"/></EntityType>
          <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
        </Schema>
      </edmx:Edmx>
    `);
    expect(() => odataSourceSchemaV2(unreviewed, "Assets", context)).toThrow(
      /unsupported or missing CSDL version 4\.02/,
    );

    const openComplex = parseOdataMetadata(`
      <edmx:Edmx Version="4.0">
        <Schema Namespace="Example">
          <ComplexType Name="Address" OpenType="true"><Property Name="City" Type="Edm.String"/></ComplexType>
          <EntityType Name="Asset"><Property Name="Address" Type="Example.Address"/></EntityType>
          <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
        </Schema>
      </edmx:Edmx>
    `);
    expect(() => odataSourceSchemaV2(openComplex, "Assets", context)).toThrow(/open complex types.*Address/);
  });

  it("maps legal OData scalar wire representations without narrowing them incorrectly", () => {
    const schema = odataSourceSchemaV2(
      parseOdataMetadata(`
        <edmx:Edmx Version="4.01">
          <Schema Namespace="Example">
            <EntityType Name="Values">
              <Property Name="Amount" Type="Edm.Decimal" Precision="18"/>
              <Property Name="ObservedAt" Type="Edm.DateTimeOffset"/>
              <Property Name="FineTime" Type="Edm.TimeOfDay" Precision="6"/>
              <Property Name="TooFine" Type="Edm.Duration" Precision="12"/>
              <Property Name="Payload" Type="Edm.Binary"/>
              <Property Name="Reading" Type="Edm.Double"/>
            </EntityType>
            <EntityContainer Name="Container"><EntitySet Name="Values" EntityType="Example.Values"/></EntityContainer>
          </Schema>
        </edmx:Edmx>
      `),
      "Values",
      context,
    )!;

    expect(schema.fields.find((field) => field.name === "Amount")?.type).toEqual({
      kind: "decimal",
      precision: 18,
      scale: 0,
      jsonEncoding: "string",
    });
    expect(schema.fields.find((field) => field.name === "ObservedAt")?.type).toEqual({
      kind: "timestamp",
      unit: "second",
      timezone: "offset",
    });
    expect(schema.fields.find((field) => field.name === "FineTime")?.type).toEqual({
      kind: "time",
      unit: "microsecond",
    });
    expect(schema.fields.find((field) => field.name === "TooFine")?.type).toMatchObject({
      kind: "unknown",
      reason: "unsupported",
    });
    expect(schema.fields.find((field) => field.name === "Payload")?.type).toEqual({
      kind: "binary",
      encoding: "opaque",
    });
    expect(schema.fields.find((field) => field.name === "Reading")?.type).toEqual({
      kind: "union",
      members: [
        { kind: "float", bits: 64 },
        { kind: "string", encoding: "odata-special-float" },
      ],
    });
  });

  it("does not certify cloned or caller-assembled OData metadata as closed", () => {
    const parsed = parseOdataMetadata(`
      <edmx:Edmx Version="4.0">
        <Schema Namespace="Example">
          <EntityType Name="Asset"><Property Name="Name" Type="Edm.String"/></EntityType>
          <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
        </Schema>
      </edmx:Edmx>
    `);
    expect(odataSourceSchemaV2(parsed, "Assets", context)?.openContent).toBe("closed");
    expect(odataSourceSchemaV2(structuredClone(parsed), "Assets", context)?.openContent).toBe("unknown");
  });

  it("preserves nested OData geometry while degrading the unaddressable source inventory", () => {
    const schema = odataSourceSchemaV2(
      {
        entitySets: { Places: "Example.Place" },
        keys: { "Example.Place": [] },
        fields: {
          "Example.Place": [
            { name: "Shape", type: "Edm.GeographyPoint", isSpatial: true },
            { name: "Address", type: "Example.Address" },
          ],
        },
        complexTypes: {
          Address: [{ name: "Entrance", type: "Edm.GeographyPoint", isSpatial: true }],
        },
        capabilities: {},
      },
      "Places",
      context,
    );

    expect(schema).toBeDefined();
    expect(schema?.fields.find((field) => field.name === "Address")?.type).toMatchObject({
      kind: "struct",
      fields: [{ name: "Entrance", type: { kind: "geometry" }, roles: ["geometry"] }],
    });
    expect(schema?.geometry).toMatchObject({
      state: "unknown",
      reason: "unrecognized",
      native: {
        protocol: "odata",
        name: "nested-spatial-properties",
        definition: { paths: [["Address", "Entrance"]] },
      },
    });
    if (schema?.geometry.state !== "unknown" || !schema.geometry.native?.definition) {
      throw new Error("expected bounded nested-spatial native evidence");
    }
    expect(Object.isFrozen(schema.geometry.native.definition)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(schema.geometry.native.definition)).byteLength).toBeLessThan(
      64 * 1024,
    );
  });

  it("does not infer OData coordinate layout from spatial type alone", () => {
    const schema = odataSourceSchemaV2(
      {
        entitySets: { Places: "Example.Place" },
        keys: { "Example.Place": [] },
        fields: { "Example.Place": [{ name: "Location", type: "Edm.GeographyPoint", isSpatial: true }] },
        capabilities: {},
      },
      "Places",
      context,
    );
    expect(schema?.geometry).toMatchObject({ state: "known", fields: [{ layout: "unknown" }] });
  });

  it("uses OData enum member names as wire values while preserving numeric aliases natively", () => {
    const metadata = parseOdataMetadata(`
      <Schema Namespace="Example">
        <EnumType Name="Status" UnderlyingType="Edm.Int16">
          <Member Name="Active" Value="1"/>
          <Member Name="AlsoActive" Value="1"/>
        </EnumType>
        <EnumType Name="Priority"><Member Name="Low"/><Member Name="High"/></EnumType>
        <EntityType Name="Asset">
          <Property Name="Status" Type="Example.Status"/>
          <Property Name="Priority" Type="Example.Priority"/>
        </EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
      </Schema>
    `);
    const schema = odataSourceSchemaV2(metadata, "Assets", context)!;

    expect(getOdataSourceSchemaProjectionDetails(metadata)?.enumTypes.Status).toMatchObject({
      declaration: { state: "valid", valueMode: "explicit" },
      members: [{ value: 1 }, { value: 1 }],
    });
    expect(getOdataSourceSchemaProjectionDetails(metadata)?.enumTypes.Priority).toMatchObject({
      declaration: { state: "valid", valueMode: "implicit" },
      members: [{ value: 0 }, { value: 1 }],
    });
    expect(schema.fields.find((field) => field.name === "Status")).toMatchObject({
      type: { kind: "string" },
      domain: { state: "coded", values: [{ value: "Active" }, { value: "AlsoActive" }] },
    });
    expect(schema.fields.find((field) => field.name === "Priority")).toMatchObject({
      type: { kind: "string" },
      domain: { state: "coded", values: [{ value: "High" }, { value: "Low" }] },
    });
  });

  it("projects sequential mixed OData enum aliases from the OASIS CSDL example pattern", () => {
    const metadata = parseOdataMetadata(`
      <Schema Namespace="Example">
        <EnumType Name="ShippingMethod">
          <Member Name="FirstClass"/>
          <Member Name="TwoDay" Value="4"/>
          <Member Name="Overnight"/>
        </EnumType>
        <EntityType Name="Parcel"><Property Name="Shipping" Type="Example.ShippingMethod"/></EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Parcels" EntityType="Example.Parcel"/></EntityContainer>
      </Schema>
    `);
    const schema = odataSourceSchemaV2(metadata, "Parcels", context)!;

    expect(getOdataSourceSchemaProjectionDetails(metadata)?.enumTypes.ShippingMethod).toMatchObject({
      declaration: { state: "valid", valueMode: "mixed" },
      members: [{ value: 0 }, { value: 4 }, { value: 5 }],
    });
    expect(schema.fields[0]).toMatchObject({
      type: { kind: "string" },
      domain: {
        state: "coded",
        values: [{ value: "FirstClass" }, { value: "Overnight" }, { value: "TwoDay" }],
      },
    });
  });

  it.each([
    {
      name: "empty declaration",
      attributes: "",
      members: "",
      reason: "empty-declaration",
    },
    {
      name: "out-of-range underlying value",
      attributes: 'UnderlyingType="Edm.Byte"',
      members: '<Member Name="TooLarge" Value="256"/>',
      reason: "out-of-range",
    },
    {
      name: "implicit overflow after an explicit value",
      attributes: 'UnderlyingType="Edm.Byte"',
      members: '<Member Name="Maximum" Value="255"/><Member Name="Overflow"/>',
      reason: "out-of-range",
    },
    {
      name: "missing member name",
      attributes: "",
      members: '<Member Value="1"/>',
      reason: "invalid-member-name",
    },
    {
      name: "empty member name",
      attributes: "",
      members: '<Member Name="" Value="1"/>',
      reason: "invalid-member-name",
    },
    {
      name: "non-SimpleIdentifier member name",
      attributes: "",
      members: '<Member Name="Not Valid" Value="1"/>',
      reason: "invalid-member-name",
    },
    {
      name: "duplicate member name",
      attributes: "",
      members: '<Member Name="Same" Value="1"/><Member Name="Same" Value="2"/>',
      reason: "duplicate-member-name",
    },
    {
      name: "flags without explicit values",
      attributes: 'IsFlags="true"',
      members: '<Member Name="Read"/>',
      reason: "flags-require-explicit-values",
    },
    {
      name: "negative flags value",
      attributes: 'IsFlags="true"',
      members: '<Member Name="Invalid" Value="-1"/>',
      reason: "negative-flags-value",
    },
  ])("degrades invalid OData enum declarations: $name", ({ attributes, members, reason }) => {
    const metadata = parseOdataMetadata(`
      <Schema Namespace="Example">
        <EnumType Name="Status" ${attributes}>${members}</EnumType>
        <EntityType Name="Asset"><Property Name="Status" Type="Example.Status"/></EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
      </Schema>
    `);
    const schema = odataSourceSchemaV2(metadata, "Assets", context);

    expect(getOdataSourceSchemaProjectionDetails(metadata)?.enumTypes.Status?.declaration).toEqual({
      state: "invalid",
      reason,
    });
    expect(schema).toBeDefined();
    expect(schema?.fields[0]?.domain).toMatchObject({ state: "unknown", reason: "unrecognized" });
  });

  it("keeps a valid OData flags enum explicitly unsupported", () => {
    const metadata = parseOdataMetadata(`
      <Schema Namespace="Example">
        <EnumType Name="Permissions" IsFlags="true">
          <Member Name="Read" Value="1"/><Member Name="Write" Value="2"/>
        </EnumType>
        <EntityType Name="Asset"><Property Name="Permissions" Type="Example.Permissions"/></EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
      </Schema>
    `);
    const schema = odataSourceSchemaV2(metadata, "Assets", context)!;

    expect(getOdataSourceSchemaProjectionDetails(metadata)?.enumTypes.Permissions?.declaration).toEqual({
      state: "valid",
      valueMode: "explicit",
    });
    expect(schema.fields[0]).toMatchObject({
      type: { kind: "unknown", reason: "unsupported" },
      domain: { state: "unknown", reason: "unrecognized" },
    });
  });

  it("applies both OData spatial SRID defaults without inventing EPSG:0", () => {
    const schema = odataSourceSchemaV2(
      {
        entitySets: { Places: "Example.Place" },
        keys: { "Example.Place": [] },
        fields: {
          "Example.Place": [
            { name: "Geography", type: "Edm.GeographyPoint", isSpatial: true },
            { name: "Geometry", type: "Edm.GeometryPoint", isSpatial: true },
            { name: "Variable", type: "Edm.GeometryPoint", isSpatial: true, srid: "variable" },
            { name: "Arbitrary", type: "Edm.GeometryPoint", isSpatial: true, srid: 26904 },
          ],
        },
        capabilities: {},
      },
      "Places",
      context,
    )!;
    if (schema.geometry.state !== "known") throw new Error("expected OData geometry inventory");
    const byField = new Map(schema.geometry.fields.map((field) => [field.field, field.crs]));

    expect(byField.get("Geography")).toMatchObject({
      definition: { kind: "authority", authority: "EPSG", code: "4326" },
      provenance: { method: "standard-default", native: { definition: { srid: 4326, standardDefault: true } } },
    });
    expect(byField.get("Geometry")).toMatchObject({
      definition: { kind: "unknown", reason: "missing", native: { definition: { srid: 0, standardDefault: true } } },
      coordinateOrder: { state: "known", source: "encoding", axes: [{ name: "x" }, { name: "y" }] },
      provenance: { method: "standard-default" },
    });
    expect(byField.get("Variable")).toMatchObject({
      definition: { kind: "unknown", reason: "unrecognized" },
      coordinateOrder: {
        state: "known",
        source: "encoding",
        axes: [
          { name: "x", direction: "other", unit: "unknown" },
          { name: "y", direction: "other", unit: "unknown" },
        ],
      },
      provenance: { method: "metadata" },
    });
    expect(byField.get("Arbitrary")).toMatchObject({
      definition: { kind: "authority", authority: "EPSG", code: "26904" },
      coordinateOrder: {
        state: "known",
        source: "encoding",
        axes: [
          { name: "x", direction: "other", unit: "unknown" },
          { name: "y", direction: "other", unit: "unknown" },
        ],
      },
    });
    expect(JSON.stringify(schema)).not.toContain('"authority":"EPSG","code":"0"');
  });

  it("bounds native definitions while retaining their protocol/name/path identity", () => {
    const hugeDomain = { type: "vendorDomain", payload: "x".repeat(128 * 1024) };
    const schema = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Bounded",
        fields: [{ name: "value", type: "esriFieldTypeVendorThing", domain: hugeDomain }],
      },
      { ...context, protocol: "geoservices-feature-service" },
    )!;

    expect(schema.fields[0]?.native[0]).toEqual({
      protocol: "geoservices-feature-service",
      name: "esriFieldTypeVendorThing",
      path: ["fields", "value"],
    });
    expect(JSON.stringify(schema)).not.toContain("x".repeat(1024));
  });

  it("dual-reads OData without changing legacy schema and round-trips v2 through the discovery cache", async () => {
    const metadata = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Example">
      <EntityType Name="Count"><Property Name="Count" Type="Edm.Int32" Nullable="true"/></EntityType>
      <EntityContainer Name="Container"><EntitySet Name="Counts" EntityType="Example.Count"/></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const fetchFn = vi.fn(async () => new Response(metadata, { headers: { "Content-Type": "application/xml" } }));
    let snapshot: ConnectDiscoverySnapshot | undefined;
    const first = await connectWithSourceSchemaV2({
      endpoint: "https://example.test/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache: {
        get: () => undefined,
        set: (_identity, value) => {
          snapshot = value;
        },
      },
    });
    if (!snapshot) throw new Error("expected discovery snapshot");

    expect(first.source().descriptor.schema).toEqual({
      fields: [{ name: "Count", type: "esriFieldTypeInteger" }],
    });
    const fingerprint = first.source().descriptor.schemaV2?.fingerprint;
    expect(fingerprint).toMatch(/^sha256:/);
    expect(queryIrSourceIdentity(first.source().descriptor)).not.toHaveProperty("schemaVersion");
    expect(queryIrSourceIdentity(first.source().descriptor)).not.toHaveProperty("schemaFingerprint");
    const forgedDescriptor = {
      ...first.source().descriptor,
      schemaV2: {
        ...first.source().descriptor.schemaV2!,
        fingerprint: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
      },
    };
    expect(queryIrSourceIdentity(forgedDescriptor)).not.toHaveProperty("schemaFingerprint");
    expect(() =>
      queryIrSourceIdentity({
        ...forgedDescriptor,
        schemaV2: { ...forgedDescriptor.schemaV2, fingerprint: "sha256:not-a-digest" as `sha256:${string}` },
      }),
    ).not.toThrow();

    const defaultConnection = await connect({
      endpoint: "https://example.test/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });
    expect(defaultConnection.source().descriptor.schemaV2).toBeUndefined();

    const cached = structuredClone(snapshot);

    const missingSchema = structuredClone(snapshot);
    delete (missingSchema.sources[0] as { schemaV2?: unknown }).schemaV2;
    const missingSchemaFetch = vi.fn(async () => new Response("unexpected", { status: 500 }));
    await expect(
      connectWithSourceSchemaV2({
        endpoint: "https://example.test/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: missingSchemaFetch },
        cache: { get: () => missingSchema, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    expect(missingSchemaFetch).not.toHaveBeenCalled();

    let deepExtension: JsonValue = "leaf";
    for (let depth = 0; depth < 12; depth += 1) deepExtension = { next: deepExtension };
    const boundedSchema = createSourceSchemaV2({
      fields: [],
      key: { state: "none" },
      geometry: { state: "none", reason: "no-geometry-fields" },
      temporal: { state: "none" },
      openContent: "closed",
      provenance: [{ method: "observed", protocol: "odata", source: "https://example.test/$metadata" }],
      extensions: {
        "io.honua.cache-bounds": {
          wide: Array.from({ length: 1_000 }, (_, index) => index),
          deep: deepExtension,
        },
      },
    });
    const boundedCached = structuredClone(snapshot);
    (boundedCached.sources[0] as { schemaV2?: unknown }).schemaV2 = boundedSchema;
    const boundedHit = await connectWithSourceSchemaV2({
      endpoint: "https://example.test/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: vi.fn(async () => new Response("unexpected", { status: 500 })) },
      cache: { get: () => boundedCached, set: vi.fn() },
    });
    expect(boundedHit.source().descriptor.schemaV2?.fingerprint).toBe(boundedSchema.fingerprint);
    expect(Object.isFrozen(boundedHit.source().descriptor.schemaV2?.extensions?.["io.honua.cache-bounds"])).toBe(true);

    const aggregateSchema = createSourceSchemaV2({
      fields: [],
      key: { state: "none" },
      geometry: { state: "none", reason: "no-geometry-fields" },
      temporal: { state: "none" },
      openContent: "closed",
      provenance: [{ method: "observed", protocol: "odata", source: "https://example.test/$metadata" }],
      extensions: {
        "io.honua.cache-aggregate": Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [`part-${index}`, "x".repeat(810_000)]),
        ),
      },
    });
    const aggregateCached = structuredClone(snapshot);
    (aggregateCached.sources[0] as { schemaV2?: unknown }).schemaV2 = aggregateSchema;
    await expect(
      connectWithSourceSchemaV2({
        endpoint: "https://example.test/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: vi.fn() },
        cache: { get: () => aggregateCached, set: vi.fn() },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-discovery-cache",
      message: expect.stringMatching(/total string-size limit/),
    });

    const accessorCached = structuredClone(snapshot);
    let accessorReads = 0;
    Object.defineProperty(accessorCached.sources[0]!, "schemaV2", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return boundedSchema;
      },
    });
    await expect(
      connectWithSourceSchemaV2({
        endpoint: "https://example.test/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: vi.fn() },
        cache: { get: () => accessorCached, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    expect(accessorReads).toBe(0);

    const hit = await connectWithSourceSchemaV2({
      endpoint: "https://example.test/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: vi.fn(async () => new Response("unexpected", { status: 500 })) },
      cache: { get: () => cached, set: vi.fn() },
    });
    expect(hit.inspection.cacheStatus).toBe("hit");
    expect(hit.source().descriptor.schemaV2?.fingerprint).toBe(fingerprint);
    expect(Object.isFrozen(hit.source().descriptor.schemaV2?.fields[0]?.type)).toBe(true);

    for (const version of [
      HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION - 1,
      HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION + 1,
    ]) {
      const incompatible = structuredClone(snapshot) as unknown as { version: number };
      incompatible.version = version;
      await expect(
        connectWithSourceSchemaV2({
          endpoint: "https://example.test/odata",
          protocol: "odata",
          authorizationScopeFingerprint: "anonymous",
          clientOptions: { fetchFn: vi.fn() },
          cache: { get: () => incompatible as ConnectDiscoverySnapshot, set: vi.fn() },
        }),
      ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    }

    const tampered = structuredClone(snapshot);
    const source = tampered.sources[0] as unknown as { schemaV2: { fingerprint: string } };
    source.schemaV2.fingerprint = `sha256:${"0".repeat(64)}`;
    await expect(
      connectWithSourceSchemaV2({
        endpoint: "https://example.test/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: vi.fn() },
        cache: { get: () => tampered, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
  });

  it("does not cache a focused projection when metadata advertises no field inventory", async () => {
    const metadata = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Example">
      <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Missing"/></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const cacheSet = vi.fn();
    const result = await connectWithSourceSchemaV2({
      endpoint: "https://example.test/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async () => new Response(metadata, { headers: { "Content-Type": "application/xml" } })),
      },
      cache: { get: () => undefined, set: cacheSet },
    });

    expect(result.source().descriptor.schemaV2).toBeUndefined();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("degrades a malformed OData key reference without changing legacy connect success", async () => {
    const metadata = `
      <Schema Namespace="Example">
        <EntityType Name="Count">
          <Key><PropertyRef Name="MissingKey"/></Key>
          <Property Name="Count" Type="Edm.Int32"/>
        </EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Counts" EntityType="Example.Count"/></EntityContainer>
      </Schema>
    `;
    const result = await connectWithSourceSchemaV2({
      endpoint: "https://example.test/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async () => new Response(metadata, { headers: { "Content-Type": "application/xml" } })),
      },
    });

    expect(result.source().descriptor.schema).toEqual({
      fields: [{ name: "Count", type: "esriFieldTypeInteger" }],
      primaryKey: "MissingKey",
    });
    expect(result.source().descriptor.schemaV2).toMatchObject({
      fields: [{ name: "Count", roles: [], type: { kind: "integer", bits: 32 } }],
      key: { state: "unknown", reason: "conflicting" },
    });
  });

  it("rejects invalid advertised metadata on the opt-in path instead of hiding projection failure", async () => {
    const metadata = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Example">
      <EntityType Name="Count">
        <Property Name="Count" Type="Edm.Int32"/>
        <Property Name="Count" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container"><EntitySet Name="Counts" EntityType="Example.Count"/></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const options = {
      endpoint: "https://example.test/odata",
      protocol: "odata" as const,
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async () => new Response(metadata, { headers: { "Content-Type": "application/xml" } })),
      },
    };

    const legacy = await connect(options);
    expect(legacy.source().descriptor.schemaV2).toBeUndefined();
    expect(legacy.source().descriptor.schema?.fields?.map((field) => field.name)).toEqual(["Count", "Count"]);

    await expect(connectWithSourceSchemaV2(options)).rejects.toThrow(
      "SourceSchemaV2 field names must not contain duplicates",
    );
  });

  it("keeps legacy connect available while focused OData projection rejects inherited partial schemas", async () => {
    const metadata = `
      <Schema Namespace="Example">
        <EntityType Name="Base">
          <Key><PropertyRef Name="Id"/></Key>
          <Property Name="Id" Type="Edm.Int32"/>
        </EntityType>
        <EntityType Name="Derived" BaseType="Example.Base">
          <Property Name="Name" Type="Edm.String"/>
        </EntityType>
        <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Derived"/></EntityContainer>
      </Schema>
    `;
    const options = {
      endpoint: "https://example.test/odata",
      protocol: "odata" as const,
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async () => new Response(metadata, { headers: { "Content-Type": "application/xml" } })),
      },
    };

    const legacy = await connect(options);
    expect(legacy.source().descriptor.schemaV2).toBeUndefined();
    expect(legacy.source().descriptor.schema).toEqual({
      fields: [{ name: "Name", type: "esriFieldTypeString" }],
    });
    await expect(connectWithSourceSchemaV2(options)).rejects.toThrow(/BaseType inheritance.*Derived/);
  });

  it("degrades a missing GeoServices objectIdField while preserving valid fields", () => {
    const schema = geoServicesSourceSchemaV2(
      {
        id: 0,
        name: "Invalid key reference",
        objectIdField: "MissingObjectId",
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID" },
          { name: "Name", type: "esriFieldTypeString" },
        ],
      },
      { ...context, protocol: "geoservices-feature-service" },
    );

    expect(schema).toBeDefined();
    expect(schema?.key).toEqual({ state: "unknown", reason: "conflicting" });
    expect(schema?.fields.map((field) => field.name)).toEqual(["Name", "OBJECTID"]);
    expect(schema?.fields.every((field) => !field.roles.includes("primary-key"))).toBe(true);
  });
});
