import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import { startGeoprocessingJobRunnerFixtureServer } from "../../examples/geoprocessing-job-runner/mock-server.mjs";
import { observeExecutionBodies, verifyExecutionCompletion } from "./gp-response-completion.mjs";

test.setTimeout(90_000);

async function attachExecutionEvidence(testInfo, name, evidence, browserVersion) {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify({ test: testInfo.title, retry: testInfo.retry, repeat: testInfo.repeatEachIndex, browserVersion, evidence }, null, 2));
  await testInfo.attach(name, { path, contentType: "application/json" });
}

test("result-first buffer walkthrough is semantic, responsive, deterministic, and clean", async ({ page }, testInfo) => {
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const badResponses = [];
  const network = [];
  const requestKeys = new Map();
  const terminalRequests = new Set();
  const requestKey = (request) => {
    if (!requestKeys.has(request)) requestKeys.set(request, requestKeys.size + 1);
    return requestKeys.get(request);
  };
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfinished", request => terminalRequests.add(requestKey(request)));
  page.on("requestfailed", (request) => {
    terminalRequests.add(requestKey(request));
    failedRequests.push({ key: requestKey(request), method: request.method(), url: request.url(), error: request.failure()?.errorText });
  });
  page.on("response", (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });

  const server = await startGeoprocessingJobRunnerFixtureServer({ observeExecutions: true });
  const executionUrl = `${server.url}/ogc/processes/processes/${server.fixture.processId}/execution`;
  await page.addInitScript(observeExecutionBodies, { executionUrl });
  page.on("response", response => {
    const request = response.request();
    if (request.method() === "POST" && request.url() === executionUrl) {
      network.push({ key: requestKey(request), id: response.headers()["x-honua-test-execution"], method: request.method(), url: request.url(), status: response.status(), location: response.headers().location, requestBody: request.postDataJSON(), prefer: request.headers().prefer });
    }
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const startedAt = Date.now();
    await page.goto(server.url);
    await expect.poll(() => page.evaluate(() => window.__HONUA_GEOPROCESSING_JOB_RUNNER__?.ready)).toBe(true);
    await expect(page.locator("#buffer-polygon")).toHaveAttribute("data-rendered", "true", { timeout: 3_000 });
    expect(Date.now() - startedAt).toBeLessThanOrEqual(3_000);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run a buffer job and collect the result");
    await expect(page.getByText("Pinned fixture · not a live service")).toBeVisible();
    await expect(page.locator("#job-state")).toHaveText("Successful");
    await expect(page.locator("#result-state")).toHaveText("Rendered and verified");
    await expect(page.getByRole("button", { name: "Replay buffer job" })).toBeVisible();
    await expect(page.getByLabel("Map legend")).toContainText("Input · Honolulu Hale");
    await expect(page.getByLabel("Map legend")).toContainText("Output · 350 m buffer");
    await expect(page.getByRole("table", { name: "Accessible input and output geometry summary" })).toContainText("Polygon, 33 ring positions");
    await expect(page.locator("#result-digest")).toHaveText(server.fixture.resultGeometrySha256);
    await expect(page.locator("#status-timeline li")).toHaveCount(4);
    await expect(page.getByText("/ogc/processes/processes/geometry.buffer/execution", { exact: true })).toBeVisible();

    const desktopBounds = await page.locator(".map-card").boundingBox();
    expect(desktopBounds).not.toBeNull();
    expect(desktopBounds.width).toBeGreaterThanOrEqual(1440 * 0.55);
    expect((desktopBounds.width * desktopBounds.height) / (1440 * 900)).toBeGreaterThanOrEqual(0.55);
    await page.screenshot({ path: testInfo.outputPath("geoprocessing-job-runner-desktop.png"), fullPage: false });

    expect(server.requests.slice(0, 4).map(({ method, path }) => ({ method, path }))).toEqual(server.fixture.exchanges.map(({ method, path }) => ({ method, path })));
    expect(server.requests[0]).toMatchObject({ body: { inputs: server.fixture.inputs, response: "document" }, prefer: "respond-async" });

    // Observe the real rendered Running state and click its actual DOM button
    // in the same browser turn. Separate driver round trips can miss the finite
    // cancellation window or deliberately abort a newly started status poll.
    await page.evaluate(() => {
      window.__HONUA_CANCEL_RUNNING__ = null;
      const observer = new MutationObserver(() => {
          const state = document.querySelector("#job-state");
          const button = document.querySelector("#primary-action");
          if (state.textContent !== "Running") return;
          observer.disconnect();
          const bounds = button.getBoundingClientRect();
          const observed = { state: state.textContent, label: button.textContent, enabled: !button.disabled, visible: bounds.width > 0 && bounds.height > 0 && getComputedStyle(button).visibility === "visible" };
          if (observed.label === "Cancel job" && observed.enabled && observed.visible) button.click();
          window.__HONUA_CANCEL_RUNNING__ = observed;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await page.getByRole("button", { name: "Replay buffer job" }).click();
    await expect.poll(() => page.evaluate(() => window.__HONUA_CANCEL_RUNNING__)).toEqual({ state: "Running", label: "Cancel job", enabled: true, visible: true });
    await expect(page.locator("#job-state")).toHaveText("Dismissed");
    await expect(page.getByRole("button", { name: "Restart buffer job" })).toBeVisible();
    expect(server.requests.some(({ method, path }) => method === "DELETE" && path.endsWith("/honolulu-hale-buffer-001"))).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBounds = await page.locator(".map-card").boundingBox();
    expect(mobileBounds).not.toBeNull();
    expect(mobileBounds.height).toBeGreaterThanOrEqual(844 * 0.4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("geoprocessing-job-runner-mobile.png"), fullPage: false });

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await expect.poll(() => network.filter(request => terminalRequests.has(request.key)).length).toBe(2);
    const completion = { executionUrl, expectedCount: 2, expectedRequestBody: { inputs: server.fixture.inputs, response: "document" }, expectedPrefer: "respond-async", server: server.executionReceipts, browser: await page.evaluate(() => window.__HONUA_EXECUTION_BODIES__), network, failed: failedRequests };
    verifyExecutionCompletion(completion);
    expect(badResponses).toEqual([]);
    expect(await page.locator("body").innerText()).not.toMatch(/undefined|null|loading error/i);
  } finally {
    const browser = await page.evaluate(() => window.__HONUA_EXECUTION_BODIES__ ?? []).catch(error => ({ observationError: error.message }));
    await attachExecutionEvidence(testInfo, "execution-response-completion.json", { executionUrl, server: server.executionReceipts, browser, network, failed: failedRequests, cancellation: await page.evaluate(() => window.__HONUA_CANCEL_RUNNING__ ?? null).catch(() => null) }, page.context().browser()?.version());
    await server.close();
  }
});

test("execution completion requires real EOF and preserves transport failures", async ({ page }, testInfo) => {
  const expected = Buffer.from('{"ok":true}');
  let scenario = "valid";
  let receipt;
  let acknowledgeRead;
  await page.exposeFunction("acknowledgeControlRead", bytes => acknowledgeRead(bytes));
  const server = createServer((request, response) => {
    if (request.url !== "/execution") { response.end("<html>response completion control</html>"); return; }
    const kind = scenario;
    const current = { id: "control-response", method: "POST", path: "/execution", requestBody: {}, prefer: "respond-async", status: 201, location: "/jobs/control", byteLength: expected.length, sha256: createHash("sha256").update(expected).digest("hex"), finished: false, prematureClose: false };
    receipt = current;
    response.once("finish", () => { current.finished = true; });
    response.once("close", () => { if (!response.writableFinished) current.prematureClose = true; });
    response.writeHead(kind === "status" ? 200 : 201, { "content-type": "application/json", "cache-control": "no-store", "content-length": expected.length + (kind === "truncated" ? 1 : 0), "x-honua-test-execution": receipt.id, location: kind === "location" ? "/wrong-job" : receipt.location });
    const body = kind === "body" ? Buffer.from('{"ok":null}') : expected;
    response.write(body.subarray(0, 6));
    // Advance only when the real reader has observed the preceding bytes.
    // In the truncation control, close after it has received complete JSON,
    // while the declared HTTP length still requires one more byte.
    let tailSent = false;
    acknowledgeRead = bytes => {
      if (response.destroyed || response.writableEnded) return;
      if (kind === "truncated" && bytes === body.length) {
        response.socket?.end();
      } else if (!tailSent && bytes >= 6) {
        tailSent = true;
        if (kind === "truncated") response.write(body.subarray(6));
        else response.end(body.subarray(6));
      }
    };
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executionUrl = `${origin}/execution`;
  await page.addInitScript(observeExecutionBodies, { executionUrl });
  const controls = [];
  try {
    for (scenario of ["valid", "truncated", "abort", "cancel", "status", "location", "body"]) {
      await page.goto(origin);
      const network = [];
      const failed = [];
      let terminal;
      const onResponse = response => {
        if (response.url() !== executionUrl) return;
        const request = response.request();
        network.push({ key: 1, id: response.headers()["x-honua-test-execution"], method: request.method(), url: request.url(), status: response.status(), location: response.headers().location, requestBody: request.postDataJSON(), prefer: request.headers().prefer });
      };
      const onFailed = request => { if (request.url() === executionUrl) { terminal = "failed"; failed.push({ key: 1, method: request.method(), url: request.url(), error: request.failure()?.errorText }); } };
      const onFinished = request => { if (request.url() === executionUrl) terminal = "finished"; };
      page.on("response", onResponse);
      page.on("requestfailed", onFailed);
      page.on("requestfinished", onFinished);
      const consumed = await page.evaluate(async scenario => {
        const controller = new AbortController();
        const response = await fetch("/execution", { method: "POST", body: "{}", headers: { Prefer: "respond-async" }, signal: controller.signal });
        const reader = response.body.getReader();
        try {
          let chunks = 0;
          let bytes = 0;
          for (;;) {
            const next = await reader.read();
            if (next.done) return "eof";
            if (++chunks === 1 && scenario === "abort") controller.abort();
            if (chunks === 1 && scenario === "cancel") await reader.cancel();
            bytes += next.value.byteLength;
            await window.acknowledgeControlRead(bytes);
          }
        } catch (error) { return error.name; }
      }, scenario);
      await expect.poll(() => terminal).toBeTruthy();
      const completion = { executionUrl, expectedCount: 1, expectedRequestBody: {}, expectedPrefer: "respond-async", server: [receipt], browser: await page.evaluate(() => window.__HONUA_EXECUTION_BODIES__), network, failed };
      controls.push({ scenario, consumed, terminal, completion });
      if (scenario === "valid") {
        expect(consumed).toBe("eof");
        verifyExecutionCompletion(completion);
        // Cross-binding and omissions must fail even with a genuine successful
        // response, rather than trusting a reusable URL/job ID or error string.
        for (const corrupt of [
          value => { value.server[0].finished = false; },
          value => { value.server[0].prematureClose = true; },
          value => { value.browser[0].id = "other-response"; },
          value => { value.browser[0].eof = false; },
          value => { value.browser[0].errors.push("read failure"); },
          value => { value.failed.push({ key: 99, method: "POST", url: executionUrl, error: "net::ERR_ABORTED" }); },
          value => { value.failed = [{ key: 1, method: "GET", url: executionUrl, error: "net::ERR_ABORTED" }]; },
          value => { value.failed = [{ key: 1, method: "POST", url: `${executionUrl}/other`, error: "net::ERR_ABORTED" }]; },
          value => { value.failed = Array.from({ length: 2 }, () => ({ key: 1, method: "POST", url: executionUrl, error: "net::ERR_ABORTED" })); },
          value => { value.network.push({ ...value.network[0], key: 99 }); },
          value => { value.browser.push(structuredClone(value.browser[0])); },
          value => { value.expectedCount = 2; value.server.push(structuredClone(value.server[0])); value.browser.push(structuredClone(value.browser[0])); value.network.push(structuredClone(value.network[0])); },
        ]) {
          const invalid = structuredClone(completion);
          corrupt(invalid);
          expect(() => verifyExecutionCompletion(invalid)).toThrow();
        }
      } else {
        expect(() => verifyExecutionCompletion(completion)).toThrow();
        if (scenario === "truncated") {
          expect(completion.browser[0].bytes).toEqual([...expected]);
          expect(completion.browser[0].eof).toBe(false);
          expect(completion.browser[0].errors.length).toBeGreaterThan(0);
        }
      }
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
      page.off("requestfinished", onFinished);
    }
  } finally {
    await attachExecutionEvidence(testInfo, "execution-response-controls.json", controls, page.context().browser()?.version());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
