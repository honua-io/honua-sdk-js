import assert from "node:assert/strict";
import { test } from "node:test";

import { publishCandidateLayer } from "../../mcp/scripts/publish-candidate-layer.mjs";

const BASE = "http://localhost:8080";
const KEY = "private-fixture-key";

/** A fake admin API: records each call, answers from `responses[METHOD path]`. */
function fakeAdmin(overrides = {}) {
  const calls = [];
  const responses = {
    "POST /api/v1/admin/connections": { success: true, data: { connectionId: "conn-1" } },
    "POST /api/v1/admin/connections/conn-1/tables/validate": { success: true, data: { isValid: true, status: "valid", geometryColumn: "geometry", primaryKey: "parcel_id", featureCount: 1 } },
    "POST /api/v1/admin/connections/conn-1/layers": { success: true, data: { layerId: 1, layerName: "Parcels", serviceName: "default", enabled: false } },
    "PUT /api/v1/admin/connections/conn-1/layers/1/enabled": { success: true, data: { layerId: 1, enabled: true } },
    ...overrides,
  };
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const key = `${init.method} ${pathname}`;
    calls.push({ key, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (!(key in responses)) return new Response("not found", { status: 404 });
    const value = responses[key];
    return value instanceof Response ? value : Response.json(value);
  };
  return { calls, fetch };
}

test("publishes and enables the installer's zero-to-map table through the admin API", async () => {
  const admin = fakeAdmin();
  const result = await publishCandidateLayer({ baseUrl: BASE, apiKey: KEY, fetch: admin.fetch });
  assert.deepEqual(admin.calls.map((call) => call.key), [
    "POST /api/v1/admin/connections",
    "POST /api/v1/admin/connections/conn-1/tables/validate",
    "POST /api/v1/admin/connections/conn-1/layers",
    "PUT /api/v1/admin/connections/conn-1/layers/1/enabled",
  ]);
  // The connection resolves the installer's own database password by reference;
  // no credential material is ever placed in a request body.
  assert.equal(admin.calls[0].body.secretReference, "env:HONUA_LOCAL_DB_PASSWORD");
  assert.equal(admin.calls[0].body.password, undefined);
  assert.deepEqual(admin.calls[1].body, { schema: "public", table: "zero_to_map_parcels" });
  assert.equal(admin.calls[2].body.table, "zero_to_map_parcels");
  assert.deepEqual(admin.calls[3].body, { enabled: true });
  for (const call of admin.calls) assert.equal(call.headers["X-API-Key"], KEY);
  assert.deepEqual(result, { connectionId: "conn-1", layerId: 1, layerName: "Parcels", serviceName: "default" });
});

test("refuses to publish a table the candidate says is not publishable", async () => {
  const admin = fakeAdmin({
    "POST /api/v1/admin/connections/conn-1/tables/validate": { success: true, data: { isValid: false, status: "invalid" } },
  });
  await assert.rejects(publishCandidateLayer({ baseUrl: BASE, apiKey: KEY, fetch: admin.fetch }), /not publishable/);
  assert.ok(!admin.calls.some((call) => call.key.endsWith("/layers")));
});

test("fails when the candidate does not confirm the layer is enabled", async () => {
  const admin = fakeAdmin({
    "PUT /api/v1/admin/connections/conn-1/layers/1/enabled": { success: true, data: { layerId: 1, enabled: false } },
  });
  await assert.rejects(publishCandidateLayer({ baseUrl: BASE, apiKey: KEY, fetch: admin.fetch }), /did not enable/);
});

test("surfaces an admin API error status without echoing the key", async () => {
  const admin = fakeAdmin({ "POST /api/v1/admin/connections": new Response("forbidden", { status: 403 }) });
  await assert.rejects(publishCandidateLayer({ baseUrl: BASE, apiKey: KEY, fetch: admin.fetch }), (error) => {
    assert.match(error.message, /POST \/api\/v1\/admin\/connections returned 403/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
});
