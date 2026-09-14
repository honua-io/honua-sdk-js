import assert from "node:assert/strict";
import test from "node:test";
import { complaintDistanceRequest, matchingDistanceIds } from "../src/complaint-distance.mjs";

const geometry = {
  paths: Array.from({ length: 6974 }, (_, i) => [
    [-74, 40],
    [-74 + i / 100000, 40.1],
  ]),
  spatialReference: { wkid: 4326 },
};
const input = {
  day: "2026-02-14",
  dateField: "Created_Date",
  geometry,
  geometryType: "esriGeometryPolyline",
  startTimes: [],
};

test("preserves all tracks and an exact UTC day without constructing a buffer", () => {
  const query = complaintDistanceRequest(input);
  assert.equal(query.geometry, geometry);
  assert.equal(query.geometry.paths.length, 6974);
  assert.equal(query.distance, 0.5);
  assert.equal(query.units, "esriSRUnit_StatuteMile");
  assert.equal(
    query.where,
    "\"Created_Date\" >= TIMESTAMP '2026-02-14 00:00:00' AND \"Created_Date\" < TIMESTAMP '2026-02-15 00:00:00'",
  );
});

test("intersects selected start-time limits with the day and escapes the schema field", () => {
  const query = complaintDistanceRequest({
    ...input,
    dateField: 'date"field',
    startTimes: ["2026-02-14T09:30:00Z", Date.parse("2026-02-14T09:00:00Z")],
  });
  assert.match(query.where, /"date""field" >= TIMESTAMP '2026-02-14 09:00:00.000'/);
  assert.match(query.where, /"date""field" <= TIMESTAMP '2026-02-14 09:30:00.000'/);
  assert.match(query.where, /< TIMESTAMP '2026-02-15 00:00:00'/);
});

test("supports the loupe point and rejects malformed dates or selection times", () => {
  const point = { x: -74, y: 40.7, spatialReference: { wkid: 4326 } };
  assert.equal(
    complaintDistanceRequest({ ...input, geometry: point, geometryType: "esriGeometryPoint" }).geometry,
    point,
  );
  assert.throws(() => complaintDistanceRequest({ ...input, day: "2026-02-30" }), /valid calendar/);
  for (const value of [null, undefined, "invalid", Number.POSITIVE_INFINITY])
    assert.throws(() => complaintDistanceRequest({ ...input, startTimes: [value] }), /valid start times/);
});

test("sends identical geometry, temporal constraints, radius and cancellation for count and IDs", async () => {
  const signal = new AbortController().signal;
  const query = complaintDistanceRequest(input);
  const calls = [];
  const ids = await matchingDistanceIds(
    async (request) => {
      calls.push(request);
      return request.extraParams.returnCountOnly ? { count: 2 } : { objectIds: [7, "8"] };
    },
    query,
    signal,
  );
  assert.deepEqual(ids, ["7", "8"]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.geometry, geometry);
    assert.equal(call.where, query.where);
    assert.equal(call.signal, signal);
    assert.equal(call.extraParams.distance, 0.5);
    assert.equal(call.extraParams.inSR, 4326);
  }
});

test("refuses incomplete, duplicate, invalid and mismatched identities", async () => {
  for (const result of [
    {},
    { objectIds: [7] },
    { objectIds: [7, 7] },
    { objectIds: [7, null] },
    { objectIds: [7, 8], exceededTransferLimit: true },
  ]) {
    await assert.rejects(
      matchingDistanceIds(
        async (q) => (q.extraParams.returnCountOnly ? { count: 2 } : result),
        complaintDistanceRequest(input),
        new AbortController().signal,
      ),
    );
  }
  await assert.rejects(
    matchingDistanceIds(
      async (q) => (q.extraParams.returnCountOnly ? {} : { objectIds: [] }),
      complaintDistanceRequest(input),
      new AbortController().signal,
    ),
  );
});

test("cancellation prevents requests and rejects replies from a cancelled selection", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    matchingDistanceIds(
      async () => {
        assert.fail("No request should start");
      },
      complaintDistanceRequest(input),
      cancellation.signal,
    ),
  );
  const pending = new AbortController();
  await assert.rejects(
    matchingDistanceIds(
      async (q) => {
        pending.abort();
        return q.extraParams.returnCountOnly ? { count: 0 } : { objectIds: [] };
      },
      complaintDistanceRequest(input),
      pending.signal,
    ),
  );
});

test("accepts a verified empty result and a numeric string count", async () => {
  const query = complaintDistanceRequest(input);
  assert.deepEqual(
    await matchingDistanceIds(
      async (q) => (q.extraParams.returnCountOnly ? { count: 0 } : { objectIds: [] }),
      query,
      new AbortController().signal,
    ),
    [],
  );
  assert.deepEqual(
    await matchingDistanceIds(
      async (q) => (q.extraParams.returnCountOnly ? { count: "1" } : { objectIds: [7] }),
      query,
      new AbortController().signal,
    ),
    ["7"],
  );
});
