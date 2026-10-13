import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Runs in the page before the application. Observes the SDK's actual response;
// never clones, tees, drains, substitutes a body, or issues a second request.
export function observeExecutionBodies({ executionUrl }) {
  const receipts = [];
  window.__HONUA_EXECUTION_BODIES__ = receipts;
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href).href;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const promise = nativeFetch.call(this, input, init);
    if (url !== executionUrl || method !== "POST") return promise;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const receipt = { url, method, id: null, status: null, location: null, bytes: [], eof: false, errors: [], cancelled: false, aborted: signal?.aborted ?? false, overflow: false, readers: 0 };
    receipts.push(receipt);
    const aborted = () => { receipt.aborted = true; };
    signal?.addEventListener("abort", aborted, { once: true });
    // Register before the SDK's continuation, but return the ORIGINAL promise.
    void promise.then(response => {
      receipt.id = response.headers.get("x-honua-test-execution");
      receipt.status = response.status;
      receipt.location = response.headers.get("location");
      const body = response.body;
      if (!body) { receipt.errors.push("missing body"); return; }
      const nativeGetReader = body.getReader;
      const nativeCancel = body.cancel;
      body.cancel = function (...args) { receipt.cancelled = true; return nativeCancel.apply(this, args); };
      body.getReader = function (...args) {
        const reader = nativeGetReader.apply(this, args);
        receipt.readers++;
        const nativeRead = reader.read;
        const nativeReaderCancel = reader.cancel;
        reader.cancel = function (...cancelArgs) { receipt.cancelled = true; return nativeReaderCancel.apply(this, cancelArgs); };
        reader.read = function (...readArgs) {
          const reading = nativeRead.apply(this, readArgs);
          void reading.then(result => {
            if (result.value) {
              if (receipt.bytes.length + result.value.byteLength > 65_536) receipt.overflow = true;
              else for (const byte of result.value) receipt.bytes.push(byte);
            }
            if (result.done) {
              receipt.eof = true;
              signal?.removeEventListener("abort", aborted);
            }
          }, error => { receipt.errors.push(error.name); }).catch(error => { receipt.errors.push(`observer: ${error.name}`); });
          return reading;
        };
        return reader;
      };
    }, error => { receipt.errors.push(error.name); }).catch(error => { receipt.errors.push(`observer: ${error.name}`); });
    return promise;
  };
}

// DevTools can report a no-store response as aborted AFTER its real reader has
// reached EOF (Chromium 568852319). Reconcile only independently proven physical
// executions; a matching error string, parsed JSON, or later job success is not
// evidence. All other failed requests remain failures.
export function verifyExecutionCompletion({ executionUrl, expectedCount, expectedRequestBody, expectedPrefer, server, browser, network, failed }) {
  assert.equal(server.length, expectedCount, "unexpected physical execution count");
  assert.equal(browser.length, expectedCount, "missing or extra browser execution");
  assert.equal(network.length, expectedCount, "missing or extra network execution");
  const verifiedRequests = new Set();
  const ids = new Set();
  for (const sent of server) {
    assert.ok(typeof sent.id === "string" && sent.id.length > 0 && !ids.has(sent.id), "missing or reused response identity");
    ids.add(sent.id);
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, new URL(executionUrl).pathname);
    assert.deepEqual(sent.requestBody, expectedRequestBody);
    assert.equal(sent.prefer, expectedPrefer);
    assert.equal(sent.status, 201);
    assert.equal(sent.finished, true, "server did not finish response");
    assert.equal(sent.prematureClose, false, "server response closed prematurely");
    const matchingBodies = browser.filter(body => body.id === sent.id);
    const matchingRequests = network.filter(request => request.id === sent.id);
    assert.equal(matchingBodies.length, 1, "response identity must name one consumed body");
    assert.equal(matchingRequests.length, 1, "response identity must name one physical request");
    const body = matchingBodies[0];
    const request = matchingRequests[0];
    assert.ok(!verifiedRequests.has(request.key), "physical request reused");
    for (const observed of [body, request]) {
      assert.equal(observed.url, executionUrl);
      assert.equal(observed.method, "POST");
      assert.equal(observed.status, sent.status);
      assert.equal(observed.location, sent.location);
    }
    assert.deepEqual(request.requestBody, expectedRequestBody);
    assert.equal(request.prefer, expectedPrefer);
    assert.equal(body.readers, 1);
    assert.equal(body.eof, true, "actual response reader did not reach EOF");
    assert.deepEqual(body.errors, [], "actual response consumption failed");
    assert.equal(body.cancelled, false, "actual response reader was cancelled");
    assert.equal(body.aborted, false, "actual fetch signal was aborted");
    assert.equal(body.overflow, false, "response exceeds witness byte bound");
    assert.equal(body.bytes.length, sent.byteLength);
    assert.equal(createHash("sha256").update(Buffer.from(body.bytes)).digest("hex"), sent.sha256, "response bytes differ from expected fixture");
    verifiedRequests.add(request.key);
  }
  assert.equal(new Set(network.map(request => request.key)).size, expectedCount, "duplicate physical request");
  const failedKeys = new Set();
  for (const failure of failed) {
    assert.ok(verifiedRequests.has(failure.key), `unverified failed request: ${failure.method} ${failure.url} ${failure.error}`);
    assert.ok(!failedKeys.has(failure.key), "duplicate failed request witness");
    failedKeys.add(failure.key);
    const request = network.find(value => value.key === failure.key);
    assert.equal(failure.method, request.method);
    assert.equal(failure.url, request.url);
  }
}
