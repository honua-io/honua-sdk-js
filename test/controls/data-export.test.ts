import { describe, expect, test } from "vitest";
import { serializeHonuaDataExport } from "../../src/controls/data-export.js";

const rows = [
  {
    id: 7,
    attributes: { name: '=HYPERLINK("bad")', count: 2, hidden: "private" },
    geometry: { type: "Point", coordinates: [-157, 21] },
  },
  { id: 8, attributes: { name: "A, B\nC", count: 0 }, geometry: null },
];

describe("filtered-row export", () => {
  test("exports exactly the supplied rows and fields as safe CSV", () => {
    const result = serializeHonuaDataExport({ rows: rows.slice(0, 1), fields: ["name", "count"], format: "csv" });
    expect(result.rowCount).toBe(1);
    expect(result.text).toBe('"name","count"\r\n"\'=HYPERLINK(""bad"")","2"\r\n');
    expect(result.text).not.toContain("private");
  });
  test("retains feature ids, null geometries and selected properties in GeoJSON", () => {
    const result = serializeHonuaDataExport({ rows, fields: ["name", "count"], format: "geojson" });
    const data = JSON.parse(result.text);
    expect(data.features).toHaveLength(2);
    expect(data.features[0]).toEqual({
      type: "Feature",
      id: 7,
      geometry: rows[0].geometry,
      properties: { name: rows[0].attributes.name, count: 2 },
    });
    expect(data.features[1].geometry).toBeNull();
  });
  test("quotes delimiters and line breaks", () => {
    expect(serializeHonuaDataExport({ rows: rows.slice(1), fields: ["name"], format: "csv" }).text).toBe(
      '"name"\r\n"A, B\nC"\r\n',
    );
  });
  test("refuses row overflow instead of silently truncating", () => {
    expect(() => serializeHonuaDataExport({ rows, fields: ["name"], format: "csv", maxRows: 1 })).toThrow(/limit/i);
  });
  test.each(["token", "authorization", "apiKey"])("rejects sensitive export field %s", (field) => {
    expect(() => serializeHonuaDataExport({ rows: [], fields: [field], format: "csv" })).toThrow(/sensitive/i);
  });
  test("rejects credential-bearing values without echoing them", () => {
    const secretRows = [{ attributes: { url: "https://example.com/data?token=secret-value" } }];
    expect(() => serializeHonuaDataExport({ rows: secretRows, fields: ["url"], format: "csv" })).toThrow();
  });
  test("rejects nested credential keys", () => {
    expect(() =>
      serializeHonuaDataExport({
        rows: [{ attributes: { value: { token: "secret" } } }],
        fields: ["value"],
        format: "geojson",
      }),
    ).toThrow(/sensitive/i);
  });
  test("refuses projected geometry rather than labelling it RFC 7946", () => {
    expect(() =>
      serializeHonuaDataExport({
        rows: [{ attributes: {}, geometry: { x: 1000, y: 1000, spatialReference: { wkid: 3857 } } }],
        fields: [],
        format: "geojson",
      }),
    ).toThrow(/WGS84/i);
  });
});

test("rejects out-of-range and nonfinite GeoJSON coordinates", () => {
  for (const coordinates of [
    [1000, 1000],
    [-157, Number.NaN],
  ]) {
    expect(() =>
      serializeHonuaDataExport({
        rows: [{ attributes: {}, geometry: { type: "Point", coordinates } }],
        fields: [],
        format: "geojson",
      }),
    ).toThrow(/WGS84/i);
  }
});

test("preserves numeric negatives while neutralizing formula strings", () => {
  expect(
    serializeHonuaDataExport({
      rows: [{ attributes: { number: -157, text: "-157" } }],
      fields: ["number", "text"],
      format: "csv",
    }).text,
  ).toBe('"number","text"\r\n"-157","\'-157"\r\n');
});
test.each([
  { type: "Point", coordinates: [[-157, 21]] },
  { type: "LineString", coordinates: [[-157, 21]] },
  {
    type: "Polygon",
    coordinates: [
      [
        [-157, 21],
        [-156, 21],
        [-156, 22],
        [-155, 21],
      ],
    ],
  },
])("rejects malformed GeoJSON %s", (geometry) => {
  expect(() =>
    serializeHonuaDataExport({ rows: [{ attributes: {}, geometry }], fields: [], format: "geojson" }),
  ).toThrow(/geometry/i);
});
