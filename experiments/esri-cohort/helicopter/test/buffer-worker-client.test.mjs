import assert from "node:assert/strict";
import test from "node:test";
import { bufferInWorker } from "../src/buffer-worker-client.mjs";

const geometry = {
  type: "MultiLineString",
  coordinates: [
    [
      [-74, 40],
      [-73.9, 40.1],
    ],
  ],
};
const polygon = {
  type: "Polygon",
  coordinates: [
    [
      [-74, 40],
      [-73.9, 40],
      [-74, 40.1],
      [-74, 40],
    ],
  ],
};

function fakeWorker() {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminated: 0,
    received: null,
    postMessage(value) {
      this.received = value;
    },
    terminate() {
      this.terminated++;
    },
  };
}

test("preserves the complete geometry and disposes the worker after a result", async () => {
  const worker = fakeWorker();
  const controller = new AbortController();
  const result = bufferInWorker(geometry, controller.signal, () => worker);
  assert.equal(worker.received, geometry);
  worker.onmessage({ data: { geometry: polygon } });
  assert.deepEqual(await result, polygon);
  controller.abort();
  assert.equal(worker.terminated, 1);
});

test("a cancelled expensive job is terminated and cannot replace a newer result", async () => {
  const oldWorker = fakeWorker();
  const newWorker = fakeWorker();
  const controller = new AbortController();
  const oldResult = bufferInWorker(geometry, controller.signal, () => oldWorker);
  const lateReply = oldWorker.onmessage;
  const rejected = assert.rejects(oldResult, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(oldWorker.terminated, 1);
  const newResult = bufferInWorker(geometry, new AbortController().signal, () => newWorker);
  lateReply({ data: { geometry: { type: "Polygon", coordinates: [] } } });
  newWorker.onmessage({ data: { geometry: polygon } });
  assert.deepEqual(await newResult, polygon);
  assert.equal(oldWorker.terminated, 1);
});

test("an already-cancelled job never starts a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    bufferInWorker(geometry, controller.signal, () => {
      assert.fail("a cancelled computation must not start");
    }),
    { name: "AbortError" },
  );
});

test("worker failure rejects instead of leaving a pending computation", async () => {
  const worker = fakeWorker();
  const result = bufferInWorker(geometry, new AbortController().signal, () => worker);
  worker.onerror();
  await assert.rejects(result, /Unable to construct/);
  assert.equal(worker.terminated, 1);
});

test("an abort deadline covers worker computation before any query starts", async () => {
  const worker = fakeWorker();
  const controller = new AbortController();
  const result = bufferInWorker(geometry, controller.signal, () => worker);
  const rejection = assert.rejects(result, { name: "TimeoutError" });
  controller.abort(new DOMException("Search area calculation timed out", "TimeoutError"));
  await rejection;
  assert.equal(worker.terminated, 1);
});
