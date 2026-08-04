import { describe, expect, it } from "vitest";

import {
  FeatureFilterCompat,
  GeoJSONLayerCompat,
  ImageryLayerCompat,
  WFSLayerCompat,
} from "../src/esri-compat-entry.js";

// #1013 — the compat surface used to declare `objectIds` (and a family of
// sibling array properties) as `ReadonlyArray`, an undocumented divergence
// from the mutable arrays ArcGIS declares. The array-mutability divergence is
// fixed here; the element-type widening is kept, documented, and given an
// explicit projection.
describe("FeatureFilterCompat.objectIds contract", () => {
  it("exposes a mutable array, as ArcGIS declares, and honors mutation", () => {
    const filter = new FeatureFilterCompat({ objectIds: [1, 2] });

    // Legal against ArcGIS, and now legal against the shim.
    filter.objectIds?.push(3);

    expect(filter.objectIds).toEqual([1, 2, 3]);
    // The array the shim stores is the array it reads back out, so a mutation
    // is not silently dropped on the next read.
    expect(filter.toJSON().objectIds).toEqual([1, 2, 3]);
  });

  it("still accepts a readonly array as input and copies it", () => {
    const input: ReadonlyArray<number> = Object.freeze([7, 8]);
    const filter = new FeatureFilterCompat({ objectIds: input });

    filter.objectIds?.push(9);

    expect(filter.objectIds).toEqual([7, 8, 9]);
    expect(input).toEqual([7, 8]);
  });

  it("copies on update() so the caller's array is not aliased", () => {
    const filter = new FeatureFilterCompat({ objectIds: [1] });
    const next = [4, 5];
    filter.update({ objectIds: next });
    next.push(6);

    expect(filter.objectIds).toEqual([4, 5]);
  });

  it("projects onto the ArcGIS property shape via toEsriProperties()", () => {
    const filter = new FeatureFilterCompat({
      where: "TYPE = 'owl'",
      objectIds: [1, 2],
      spatialRelationship: "contains",
      distance: 5,
      units: "meters",
    });

    const properties = filter.toEsriProperties();

    expect(properties).toEqual({
      where: "TYPE = 'owl'",
      objectIds: [1, 2],
      spatialRelationship: "contains",
      distance: 5,
      units: "meters",
    });
    // ArcGIS wants a mutable `number[]`; the projection hands one over.
    properties.objectIds?.push(3);
    expect(properties.objectIds).toEqual([1, 2, 3]);
  });

  it("refuses to project object ids ArcGIS cannot represent instead of dropping them", () => {
    const filter = new FeatureFilterCompat({ objectIds: [1, "urn:feature:a"] });

    expect(() => filter.toEsriProperties()).toThrow(/non-numeric object ids/);
    expect(() => filter.toEsriProperties()).toThrow(/urn:feature:a/);
  });

  it("omits absent properties from the projection", () => {
    expect(new FeatureFilterCompat().toEsriProperties()).toEqual({ spatialRelationship: "intersects" });
  });
});

// REQ-002: the same divergence is fixed as a class, not one property.
describe("compat array properties ArcGIS declares as mutable", () => {
  it("GeoJSONLayerCompat.outFields and .fields are mutable copies", () => {
    const outFields: ReadonlyArray<string> = Object.freeze(["NAME"]);
    const fields = [{ name: "NAME" }];
    const layer = new GeoJSONLayerCompat({ outFields, fields });

    layer.outFields?.push("TYPE");
    layer.fields.push({ name: "TYPE" });

    expect(layer.outFields).toEqual(["NAME", "TYPE"]);
    expect(layer.fields).toEqual([{ name: "NAME" }, { name: "TYPE" }]);
    expect(outFields).toEqual(["NAME"]);
    expect(fields).toEqual([{ name: "NAME" }]);
  });

  it("ImageryLayerCompat.bandIds is a mutable copy", () => {
    const bandIds: ReadonlyArray<number> = Object.freeze([0, 1]);
    const layer = new ImageryLayerCompat({
      url: "https://example.test/arcgis/rest/services/demo/ImageServer",
      bandIds,
    });

    layer.bandIds?.push(2);

    expect(layer.bandIds).toEqual([0, 1, 2]);
    expect(bandIds).toEqual([0, 1]);
  });

  it("WFSLayerCompat.outFields is a mutable copy", () => {
    const outFields: ReadonlyArray<string> = Object.freeze(["NAME"]);
    const layer = new WFSLayerCompat({
      url: "https://example.test/geoserver/wfs",
      name: "demo:owls",
      outFields,
    });

    layer.outFields?.push("TYPE");

    expect(layer.outFields).toEqual(["NAME", "TYPE"]);
    expect(outFields).toEqual(["NAME"]);
  });
});
