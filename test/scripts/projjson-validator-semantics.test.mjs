import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv from "ajv";

const root = new URL("../../", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("schemas/projjson-v0.7.schema.json", root), "utf8"));
const reference = new Ajv({ allErrors: true, strict: false }).compile({
  $schema: schema.$schema,
  $ref: "#/definitions/crs",
  definitions: schema.definitions,
});
const generated = readFileSync(new URL("src/contract/generated/projjson-v0.7-crs-validator.ts", root), "utf8");
const { default: validate } = await import(`data:text/javascript;base64,${Buffer.from(generated).toString("base64")}`);
const fixture = JSON.parse(readFileSync(new URL("test/fixtures/geoparquet/server-interop/epsg-32604.projjson.json", root), "utf8"));

test("shared standalone PROJJSON validators preserve official-schema acceptance and instance diagnostics", () => {
  assert.equal(reference(fixture), true);
  const geographic = { ...structuredClone(fixture.base_crs), type: "GeographicCRS" };
  assert.equal(reference(geographic), true);
  const cases = [fixture, geographic, null, {}, [], { ...fixture, type: "VendorCRS" }];
  const visit = (node, segments = []) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const location = [...segments, key];
      for (const replacement of [null, false, "", -1, {}, []]) {
        const mutated = structuredClone(fixture);
        const parent = location.slice(0, -1).reduce((current, segment) => current[segment], mutated);
        parent[key] = replacement;
        cases.push(mutated);
      }
      const missing = structuredClone(fixture);
      const parent = location.slice(0, -1).reduce((current, segment) => current[segment], missing);
      delete parent[key];
      cases.push(missing);
      visit(value, location);
    }
  };
  visit(fixture);
  assert.ok(cases.length > 100, "differential corpus must cover nested CRS references");
  const diagnostics = (errors) => (errors ?? []).map(({ instancePath, keyword, params, message }) => ({ instancePath, keyword, params, message }));
  for (const [index, candidate] of cases.entries()) {
    const expected = reference(candidate);
    assert.equal(validate(candidate), expected, `official schema acceptance for mutation ${index}`);
    assert.deepEqual(diagnostics(validate.errors), diagnostics(reference.errors), `instance diagnostics for mutation ${index}`);
  }
});
