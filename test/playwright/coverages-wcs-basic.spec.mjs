import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { preview } from "vite";

import { SAMPLE_PERFORMANCE_BUDGET_MS } from "../../scripts/lib/sample-gates.mjs";
import { attachSampleGate, attestBrowserQuality, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

const SAMPLE_ID = "coverages-wcs-basic";
const configFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples/coverages-wcs-basic/vite.config.ts",
);

test.setTimeout(90_000);

test("renders both bounded clients through one MapLibre handoff and fails locally", async ({ browser, browserName }, testInfo) => {
  const previewServer = await preview({ configFile, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  const serverUrl = previewServer.resolvedUrls?.local[0];
  if (!serverUrl) throw new Error("Coverage preview server did not publish a local URL.");
  const fixtureOrigin = new URL(serverUrl).origin;
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  const failedRequests = [];
  const errorResponses = [];
  const websocketEvents = [];
  const dedicatedWorkerUrls = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => websocketEvents.push(socket.url()));
  page.on("worker", (worker) => dedicatedWorkerUrls.push(worker.url()));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errorResponses.push(`${response.status()} ${response.url()}`);
  });
  await context.route(/^https?:\/\//u, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixtureOrigin) {
      externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    const telemetry = {
      createdObjectUrls: [],
      revokedObjectUrls: [],
      workers: [],
      websockets: [],
      eventSources: [],
      sharedWorkers: [],
      beacons: [],
      peerConnections: 0,
      webTransports: [],
    };
    window.__HONUA_NETWORK_CHANNELS__ = telemetry;

    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      const url = createObjectURL(value);
      telemetry.createdObjectUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      telemetry.revokedObjectUrls.push(String(url));
      revokeObjectURL(url);
    };

    const NativeWorker = window.Worker;
    window.Worker = class ObservedWorker extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        telemetry.workers.push(String(url));
      }
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class ObservedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        telemetry.websockets.push(String(url));
      }
    };
    if (window.EventSource) {
      const NativeEventSource = window.EventSource;
      window.EventSource = class ObservedEventSource extends NativeEventSource {
        constructor(url, options) {
          super(url, options);
          telemetry.eventSources.push(String(url));
        }
      };
    }
    if (window.SharedWorker) {
      const NativeSharedWorker = window.SharedWorker;
      window.SharedWorker = class ObservedSharedWorker extends NativeSharedWorker {
        constructor(url, options) {
          super(url, options);
          telemetry.sharedWorkers.push(String(url));
        }
      };
    }
    const sendBeacon = navigator.sendBeacon?.bind(navigator);
    if (sendBeacon) {
      navigator.sendBeacon = (url, data) => {
        telemetry.beacons.push(String(url));
        return sendBeacon(url, data);
      };
    }
    if (window.RTCPeerConnection) {
      const NativePeerConnection = window.RTCPeerConnection;
      window.RTCPeerConnection = class ObservedPeerConnection extends NativePeerConnection {
        constructor(configuration) {
          super(configuration);
          telemetry.peerConnections += 1;
        }
      };
    }
    if (window.WebTransport) {
      const NativeWebTransport = window.WebTransport;
      window.WebTransport = class ObservedWebTransport extends NativeWebTransport {
        constructor(url, options) {
          super(url, options);
          telemetry.webTransports.push(String(url));
        }
      };
    }
  });

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(serverUrl);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.ready === true)).toBe(true);
    const sampleReadyDurationMs = await page.evaluate(() => performance.now());
    expect(sampleReadyDurationMs).toBeLessThanOrEqual(SAMPLE_PERFORMANCE_BUDGET_MS);

    expect(
      await page.evaluate(() => {
        const runtime = window.__HONUA_COVERAGES_WCS__;
        return {
          ready: runtime?.ready,
          phase: runtime?.phase,
          protocol: runtime?.activeProtocol,
          collectionId: runtime?.collectionId,
          selectedBand: runtime?.selectedBand,
          sourceId: runtime?.mapSourceId,
          ogcBytes: runtime?.ogcByteLength,
          wcsBytes: runtime?.wcsByteLength,
          requestCount: runtime?.requestCount,
          imageWidth: runtime?.imageWidth,
          imageHeight: runtime?.imageHeight,
          digest: runtime?.fixtureDigest,
          centerPixelValue: runtime?.centerPixelValue,
          centerPixelColor: runtime?.centerPixelColor,
          error: runtime?.error,
        };
      }),
    ).toEqual({
      ready: true,
      phase: "ready",
      protocol: "ogc",
      collectionId: "7",
      selectedBand: "elevation",
      sourceId: "ogc-elevation",
      ogcBytes: 281908,
      wcsBytes: 281908,
      requestCount: 8,
      imageWidth: 320,
      imageHeight: 220,
      digest: "8c7b5b3f8bd31bca2df07c4a70254d75e70d63838c2f77e033def3c1b8d2acff",
      centerPixelValue: 450,
      centerPixelColor: [221, 174, 82],
      error: null,
    });

    const requests = await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.requests ?? []);
    expect(requests).toHaveLength(8);
    expect(requests.every((requestUrl) => new URL(requestUrl).origin === "https://coverages.fixture.invalid")).toBe(true);
    const ogcRequest = new URL(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.ogcRequestUrl ?? ""));
    expect(ogcRequest.pathname).toBe("/ogc/coverages/collections/7/coverage");
    expect(ogcRequest.searchParams.get("properties")).toBe("elevation");
    expect(ogcRequest.searchParams.get("scale-size")).toBe("x(320),y(220)");
    expect(ogcRequest.searchParams.get("bbox")).toBe("-158.1,21.3,-157.9,21.5");
    const wcsRequest = new URL(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.wcsRequestUrl ?? ""));
    expect(wcsRequest.searchParams.get("REQUEST")).toBe("GetCoverage");
    expect(wcsRequest.searchParams.get("RANGESUBSET")).toBe("elevation");
    expect(wcsRequest.searchParams.get("SCALESIZE")).toBe("Lat(220),Long(320)");
    expect(wcsRequest.searchParams.getAll("SUBSET")).toEqual([
      "Lat(21.3,21.5)",
      "Long(-158.1,-157.9)",
    ]);

    await expect(page.locator(".maplibregl-canvas")).toHaveCount(1);
    await expect(page.locator(".legend")).toContainText("elevation");
    await expect(page.locator("#pixel-value")).toHaveText("450 m");
    await expect(page.locator("#legend-labels")).toContainText("450 m");
    await expect(page.locator("#collection")).toContainText("7 / Oahu elevation");
    await expect(page.locator("#range")).toContainText("Elevation, Quality mask");
    await expect(page.locator("#wcs")).toContainText("2.0.1 / Lat x Long / elevation, quality");
    expect(await page.evaluate(() => Boolean(window.__honuaMaps?.[0]?.getSource("ogc-elevation")))).toBe(true);
    const ogcObjectUrl = await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.activeObjectUrl ?? null);
    expect(ogcObjectUrl).toMatch(/^blob:/u);
    expect(await page.evaluate(() => window.__HONUA_NETWORK_CHANNELS__?.createdObjectUrls ?? [])).toEqual([
      ogcObjectUrl,
    ]);

    await page.getByRole("button", { name: "Prove cancellation" }).click();
    await expect(page.locator("#safety-status")).toContainText("Cancelled safely");
    expect(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.cancellationCount)).toBe(1);
    expect(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.activeProtocol)).toBe("ogc");
    const ogcCancellation = new URL(
      await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.requests.at(-1) ?? ""),
    );
    expect(ogcCancellation.pathname).toBe("/ogc/coverages/collections/7/coverage");
    expect(ogcCancellation.searchParams.get("properties")).toBe("quality");

    await page.getByRole("button", { name: "Prove degradation" }).click();
    await expect(page.locator("#safety-status")).toContainText("InvalidParameterValue");
    expect(
      await page.evaluate(() => ({
        phase: window.__HONUA_COVERAGES_WCS__?.phase,
        degradations: window.__HONUA_COVERAGES_WCS__?.degradationCount,
        protocol: window.__HONUA_COVERAGES_WCS__?.activeProtocol,
        sourceMounted: Boolean(window.__honuaMaps?.[0]?.getSource("ogc-elevation")),
      })),
    ).toEqual({ phase: "degraded", degradations: 1, protocol: "ogc", sourceMounted: true });
    const ogcDegradation = new URL(
      await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.requests.at(-1) ?? ""),
    );
    expect(ogcDegradation.searchParams.get("properties")).toBe("not-a-band");

    await page.getByRole("button", { name: "WCS 2.0.1" }).click();
    await expect(page.locator("#active-protocol")).toHaveText("WCS image source");
    expect(
      await page.evaluate(() => ({
        protocol: window.__HONUA_COVERAGES_WCS__?.activeProtocol,
        sourceId: window.__HONUA_COVERAGES_WCS__?.mapSourceId,
        sourceMounted: Boolean(window.__honuaMaps?.[0]?.getSource("wcs-elevation")),
        staleSourceMounted: Boolean(window.__honuaMaps?.[0]?.getSource("ogc-elevation")),
      })),
    ).toEqual({ protocol: "wcs", sourceId: "wcs-elevation", sourceMounted: true, staleSourceMounted: false });
    const wcsObjectUrlProof = await page.evaluate(() => ({
      active: window.__HONUA_COVERAGES_WCS__?.activeObjectUrl ?? null,
      runtimeRevoked: window.__HONUA_COVERAGES_WCS__?.revokedObjectUrls ?? [],
      created: window.__HONUA_NETWORK_CHANNELS__?.createdObjectUrls ?? [],
      revoked: window.__HONUA_NETWORK_CHANNELS__?.revokedObjectUrls ?? [],
    }));
    expect(wcsObjectUrlProof.active).toMatch(/^blob:/u);
    expect(wcsObjectUrlProof.active).not.toBe(ogcObjectUrl);
    expect(wcsObjectUrlProof.created).toEqual([ogcObjectUrl, wcsObjectUrlProof.active]);
    expect(wcsObjectUrlProof.revoked).toEqual([ogcObjectUrl]);
    expect(wcsObjectUrlProof.runtimeRevoked).toEqual([ogcObjectUrl]);

    await page.getByRole("button", { name: "Prove cancellation" }).click();
    await expect(page.locator("#safety-status")).toContainText("Cancelled safely");
    expect(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.cancellationCount)).toBe(2);
    expect(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.activeProtocol)).toBe("wcs");
    const wcsCancellation = new URL(
      await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.requests.at(-1) ?? ""),
    );
    expect(wcsCancellation.searchParams.get("REQUEST")).toBe("GetCoverage");
    expect(wcsCancellation.searchParams.get("RANGESUBSET")).toBe("quality");

    await page.getByRole("button", { name: "Prove degradation" }).click();
    await expect(page.locator("#safety-status")).toContainText("InvalidParameterValue");
    expect(
      await page.evaluate(() => ({
        phase: window.__HONUA_COVERAGES_WCS__?.phase,
        degradations: window.__HONUA_COVERAGES_WCS__?.degradationCount,
        protocol: window.__HONUA_COVERAGES_WCS__?.activeProtocol,
        sourceMounted: Boolean(window.__honuaMaps?.[0]?.getSource("wcs-elevation")),
      })),
    ).toEqual({ phase: "degraded", degradations: 2, protocol: "wcs", sourceMounted: true });
    const wcsDegradation = new URL(
      await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.requests.at(-1) ?? ""),
    );
    expect(wcsDegradation.searchParams.get("RANGESUBSET")).toBe("not-a-band");

    const runtimeReady = await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.ready === true);
    await attestBrowserQuality({
      page,
      testInfo,
      sampleId: SAMPLE_ID,
      browserName,
      sampleReadyDurationMs,
      runtimeReady,
      responsiveViewports: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
      workflowSelectors: ["#map", ".evidence-panel", "#resilience"],
    });

    const disposal = await page.evaluate(() => {
      const runtime = window.__HONUA_COVERAGES_WCS__;
      const activeObjectUrl = runtime?.activeObjectUrl ?? null;
      runtime?.dispose();
      return {
        activeObjectUrl,
        disposed: runtime?.disposed,
        ready: runtime?.ready,
        sourceId: runtime?.mapSourceId,
        activeObjectUrlAfter: runtime?.activeObjectUrl,
        sourceCleanupVerified: runtime?.sourceCleanupVerified,
        mapRemoved: runtime?.mapRemoved,
        maps: window.__honuaMaps?.length,
        canvasCount: document.querySelectorAll(".maplibregl-canvas").length,
        runtimeRevoked: runtime?.revokedObjectUrls ?? [],
        channels: window.__HONUA_NETWORK_CHANNELS__,
      };
    });
    expect(disposal.activeObjectUrl).toMatch(/^blob:/u);
    expect(disposal).toMatchObject({
      disposed: true,
      ready: false,
      sourceId: null,
      activeObjectUrlAfter: null,
      sourceCleanupVerified: true,
      mapRemoved: true,
      maps: 0,
      canvasCount: 0,
    });
    expect(disposal.runtimeRevoked).toContain(disposal.activeObjectUrl);
    expect(disposal.runtimeRevoked).toEqual([ogcObjectUrl, disposal.activeObjectUrl]);
    expect(new Set(disposal.runtimeRevoked).size).toBe(2);
    expect(disposal.channels.createdObjectUrls).toEqual([ogcObjectUrl, disposal.activeObjectUrl]);
    expect(disposal.channels.revokedObjectUrls).toEqual(disposal.channels.createdObjectUrls);
    expect(new Set(disposal.channels.createdObjectUrls).size).toBe(2);
    expect(disposal.channels.websockets).toEqual([]);
    expect(disposal.channels.eventSources).toEqual([]);
    expect(disposal.channels.sharedWorkers).toEqual([]);
    expect(disposal.channels.beacons).toEqual([]);
    expect(disposal.channels.peerConnections).toBe(0);
    expect(disposal.channels.webTransports).toEqual([]);
    expect(websocketEvents).toEqual([]);
    expect(
      [...dedicatedWorkerUrls, ...disposal.channels.workers].every((url) => {
        if (url.startsWith("blob:") || url.startsWith("data:")) return true;
        return new URL(url, serverUrl).origin === fixtureOrigin;
      }),
    ).toBe(true);

    expect(externalRequests).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(errorResponses).toEqual([]);
    await attachSampleGate(testInfo, SAMPLE_ID, "fixture", {
      provider: "examples/coverages-wcs-basic/src/pinned-fixtures.ts",
      transport: "in-memory-fetch",
      escapedRequests: externalRequests.length,
      escapedNonHttpChannels:
        websocketEvents.length +
        disposal.channels.websockets.length +
        disposal.channels.eventSources.length +
        disposal.channels.sharedWorkers.length +
        disposal.channels.beacons.length +
        disposal.channels.peerConnections +
        disposal.channels.webTransports.length,
      requestCount: await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.requestCount),
    });
  } finally {
    try {
      await finalizeSampleConsole({ testInfo, sampleId: SAMPLE_ID, page, context, pageErrors, consoleErrors });
    } finally {
      previewServer.httpServer.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        previewServer.httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});
