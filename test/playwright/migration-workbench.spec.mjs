import { expect, test } from "@playwright/test";

import {
  normalizeMigrationWorkbenchBasePath,
  startMigrationWorkbenchFixtureServer,
} from "../../examples/migration-workbench/mock-server.mjs";
import { SAMPLE_PERFORMANCE_BUDGET_MS } from "../../scripts/lib/sample-gates.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

const SAMPLE_ID = "migration-workbench";
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
];
const WORKFLOW_SELECTORS = ["#compat-metrics", "#assertion-matrix", "#maplibre-residuals", "#artifact-files"];
const ARTIFACT_DECODED_BYTES_BUDGET = 512 * 1024;
const HOSTED_BASE_PATH = "/honua-sdk-js/gallery/migration-workbench/";
const CAPTURE_DIAGNOSTIC_ATTACHMENTS = process.env.HONUA_SAMPLE_PLAYWRIGHT_OUTPUT_DIR === undefined;

test.setTimeout(90_000);

test("migration workbench rejects malicious hosted base paths", () => {
  expect(normalizeMigrationWorkbenchBasePath()).toBe("/");
  expect(normalizeMigrationWorkbenchBasePath(HOSTED_BASE_PATH)).toBe(HOSTED_BASE_PATH);
  for (const value of [
    "honua/",
    "/honua",
    "//honua/",
    "/honua//gallery/",
    "/honua/../secret/",
    "/honua/%2e%2e/secret/",
    "/honua\\gallery/",
    "/honua/?mode=preview",
    "https://evil.example/honua/",
  ]) {
    expect(() => normalizeMigrationWorkbenchBasePath(value)).toThrow(/basePath|unsafe path segment/u);
  }
});

test(
  "migration workbench proves artifact truth and generated behavior in source or packed mode",
  async ({ browser, browserName }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const externalRequests = [];
    const allRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => allRequests.push(request.url()));

    const fixtureServer = await startMigrationWorkbenchFixtureServer({ basePath: HOSTED_BASE_PATH });
    const fixtureOrigin = new URL(fixtureServer.url).origin;
    await context.route(/^https?:\/\//u, async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== fixtureOrigin) {
        externalRequests.push(url.href);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    try {
      await page.goto(fixtureServer.url);
      await expect
        .poll(async () => page.evaluate(() => window.__HONUA_MIGRATION_WORKBENCH__?.ready === true))
        .toBe(true);

      const runtimeIdentity = await page.evaluate(() => {
        const runtime = window.__HONUA_MIGRATION_WORKBENCH__;
        return {
          ready: runtime?.ready,
          disposed: runtime?.disposed,
          sdkMode: runtime?.sdkMode,
          sdkVersion: runtime?.sdkVersion,
          fixture: runtime?.model?.fixture,
          artifactSet: runtime?.model?.artifactSet,
          browserProofPassed: runtime?.model?.browserProofPassed,
        };
      });
      expect(runtimeIdentity).toMatchObject({
        ready: true,
        disposed: false,
        fixture: "arcgis-source-app",
        browserProofPassed: true,
      });
      expect(["source", "packed"]).toContain(runtimeIdentity.sdkMode);
      expect(runtimeIdentity.sdkVersion).toMatch(/^\d+\.\d+\.\d+/u);
      await expect(page.getByTestId("honua-sample-mode")).toHaveText(`${runtimeIdentity.sdkMode} SDK`);
      await expect(page.getByTestId("honua-sample-evidence")).toContainText(runtimeIdentity.artifactSet);

      const metricProjection = await page.evaluate(() => {
        const model = window.__HONUA_MIGRATION_WORKBENCH__?.model;
        if (!model) throw new Error("migration workbench model is unavailable");
        const rendered = (selector) =>
          [...document.querySelectorAll(`${selector} [data-metric-id]`)].map((element) => ({
            id: element.dataset.metricId,
            value: element.querySelector("strong")?.textContent,
          }));
        return {
          compatibility: {
            expected: model.compatibility.metrics.map(({ id, value }) => ({ id, value: String(value) })),
            rendered: rendered("#compat-metrics"),
          },
          widgets: {
            expected: [
              { id: "widget-total", value: String(model.widgets.summary.totalSites) },
              { id: "widget-automated", value: String(model.widgets.summary.automatedSites) },
              { id: "widget-assisted", value: String(model.widgets.summary.assistedSites) },
              { id: "widget-manual", value: String(model.widgets.summary.manualSites) },
            ],
            rendered: rendered("#widget-metrics"),
          },
          maplibre: {
            expected: model.maplibre.metrics.map(({ id, value }) => ({ id, value: String(value) })),
            rendered: rendered("#maplibre-metrics"),
          },
        };
      });
      expect(metricProjection.compatibility.rendered).toEqual(metricProjection.compatibility.expected);
      expect(metricProjection.widgets.rendered).toEqual(metricProjection.widgets.expected);
      expect(metricProjection.maplibre.rendered).toEqual(metricProjection.maplibre.expected);
      await expect(page.locator("#compat-residuals")).toContainText("Manual findings");
      await expect(page.locator("#compat-residuals")).toContainText("Unsupported modules");
      await expect(page.locator("#compat-residuals .count-badge")).toHaveText(["0", "0"]);

      const completeness = await page.evaluate(() => {
        const model = window.__HONUA_MIGRATION_WORKBENCH__?.model;
        if (!model) throw new Error("migration workbench model is unavailable");
        const text = (selector) => document.querySelector(selector)?.textContent ?? "";
        return {
          compatibilityMappings: document.querySelectorAll("#compat-mappings tbody tr").length,
          expectedCompatibilityMappings: model.compatibility.mappings.length,
          compatibilityZeroRows: document.querySelectorAll('#compat-mappings tbody tr[data-zero="true"]').length,
          maplibreMappings: document.querySelectorAll("#maplibre-mappings tbody tr").length,
          expectedMaplibreMappings: model.maplibre.mappings.length,
          maplibreZeroRows: document.querySelectorAll('#maplibre-mappings tbody tr[data-zero="true"]').length,
          assertionRows: document.querySelectorAll("#assertion-matrix tbody tr").length,
          expectedAssertionRows: model.assertions.length,
          assertionFailures: document.querySelectorAll('#assertion-matrix [data-status="failed"]').length,
          unsupportedVisible: model.maplibre.unsupportedModules.every((entry) =>
            text("#maplibre-residuals").includes(entry.modulePath),
          ),
          manualVisible: model.maplibre.manualTodos.every((entry) => text("#maplibre-residuals").includes(entry.reason)),
          widgetGuidesVisible: model.widgets.widgets.every((widget) => {
            const href = `/blob/trunk/${widget.guideLink}`;
            return [...document.querySelectorAll("#widget-guidance a")].some((anchor) => anchor.href.includes(href));
          }),
        };
      });
      expect(completeness.compatibilityMappings).toBe(completeness.expectedCompatibilityMappings);
      expect(completeness.compatibilityZeroRows).toBeGreaterThan(0);
      expect(completeness.maplibreMappings).toBe(completeness.expectedMaplibreMappings);
      expect(completeness.maplibreZeroRows).toBeGreaterThan(0);
      expect(completeness.assertionRows).toBe(23);
      expect(completeness.assertionRows).toBe(completeness.expectedAssertionRows);
      expect(completeness.assertionFailures).toBe(0);
      expect(completeness.unsupportedVisible).toBe(true);
      expect(completeness.manualVisible).toBe(true);
      expect(completeness.widgetGuidesVisible).toBe(true);

      const artifactProof = await page.evaluate(async () => {
        const files = window.__HONUA_MIGRATION_WORKBENCH__?.model?.files;
        if (!files) throw new Error("migration workbench artifact manifest is unavailable");
        const observations = await Promise.all(
          files.map(async (file) => {
            if (!file.href) throw new Error(`artifact has no public href: ${file.repositoryPath}`);
            const response = await fetch(file.href, { cache: "no-store", credentials: "omit" });
            if (!response.ok) throw new Error(`artifact fetch failed: ${file.href} HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
            return {
              repositoryPath: file.repositoryPath,
              href: file.href,
              expectedBytes: file.bytes,
              observedBytes: bytes.byteLength,
              expectedSha256: file.sha256,
              observedSha256: [...digest].map((value) => value.toString(16).padStart(2, "0")).join(""),
            };
          }),
        );
        return observations;
      });
      expect(artifactProof).toHaveLength(5);
      expect(artifactProof.every((file) => file.observedBytes === file.expectedBytes)).toBe(true);
      expect(artifactProof.every((file) => file.observedSha256 === file.expectedSha256)).toBe(true);
      await expect(page.locator("#artifact-files a")).toHaveCount(5);

      const performanceEvidence = await page.evaluate((hostedBasePath) => {
        const artifactResources = performance
          .getEntriesByType("resource")
          .filter((entry) => new URL(entry.name).pathname.startsWith(`${hostedBasePath}artifacts/v1/`));
        return {
          readyMs: performance.now(),
          artifactPaths: [...new Set(artifactResources.map((entry) => new URL(entry.name).pathname))].sort(),
          decodedBodyBytes: artifactResources.reduce((total, entry) => total + (entry.decodedBodySize ?? 0), 0),
          completedByMs: artifactResources.reduce((latest, entry) => Math.max(latest, entry.responseEnd ?? 0), 0),
        };
      }, HOSTED_BASE_PATH);
      const expectedArtifactPaths = artifactProof
        .map((file) => new URL(file.href, fixtureServer.url).pathname)
        .concat(`${HOSTED_BASE_PATH}artifacts/v1/manifest.v1.json`)
        .sort();
      expect(performanceEvidence.artifactPaths).toEqual(expectedArtifactPaths);
      expect(performanceEvidence.readyMs).toBeLessThanOrEqual(SAMPLE_PERFORMANCE_BUDGET_MS);
      expect(performanceEvidence.completedByMs).toBeLessThanOrEqual(performanceEvidence.readyMs);
      expect(performanceEvidence.decodedBodyBytes).toBeGreaterThan(0);
      expect(performanceEvidence.decodedBodyBytes).toBeLessThanOrEqual(ARTIFACT_DECODED_BYTES_BUDGET);
      if (CAPTURE_DIAGNOSTIC_ATTACHMENTS) {
        await testInfo.attach("migration-workbench-performance-budget", {
          body: Buffer.from(
            JSON.stringify({
              sampleReadyBudgetMs: SAMPLE_PERFORMANCE_BUDGET_MS,
              artifactDecodedBytesBudget: ARTIFACT_DECODED_BYTES_BUDGET,
              observations: performanceEvidence,
            }),
          ),
          contentType: "application/json",
        });
      }

      await attestBrowserQuality({
        page,
        testInfo,
        sampleId: SAMPLE_ID,
        browserName,
        sampleReadyDurationMs: performanceEvidence.readyMs,
        runtimeReady: true,
        responsiveViewports: VIEWPORTS,
        workflowSelectors: WORKFLOW_SELECTORS,
      });

      for (const selector of [
        "#compat-mappings",
        "#assertion-matrix",
        "#widget-guidance",
        "#maplibre-mappings",
        "#artifact-files",
      ]) {
        const region = page.locator(selector);
        await region.focus();
        await expect(region).toBeFocused();
      }

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (CAPTURE_DIAGNOSTIC_ATTACHMENTS) {
          await testInfo.attach(`migration-workbench-${viewport.width}x${viewport.height}`, {
            body: await page.screenshot({ animations: "disabled", fullPage: true }),
            contentType: "image/png",
          });
        }
      }

      const requestsBeforeDispose = allRequests.length;
      const pageErrorsBeforeDispose = pageErrors.length;
      const consoleErrorsBeforeDispose = consoleErrors.length;
      await page.evaluate(async () => {
        const runtime = window.__HONUA_MIGRATION_WORKBENCH__;
        if (!runtime) throw new Error("migration workbench runtime is unavailable");
        await Promise.all([runtime.dispose(), runtime.dispose()]);
      });
      await expect.poll(async () => page.evaluate(() => window.__HONUA_MIGRATION_WORKBENCH__?.disposed)).toBe(true);
      expect(
        await page.evaluate(() => ({
          ready: window.__HONUA_MIGRATION_WORKBENCH__?.ready,
          hasModel: window.__HONUA_MIGRATION_WORKBENCH__?.model !== undefined,
          hasDisposeAlias: typeof window.__HONUA_MIGRATION_WORKBENCH_DISPOSE__ === "function",
          presentationCount: document.querySelectorAll(".honua-sample-kit").length,
        })),
      ).toEqual({ ready: false, hasModel: false, hasDisposeAlias: false, presentationCount: 0 });
      await page.waitForTimeout(100);
      expect(allRequests).toHaveLength(requestsBeforeDispose);
      expect(pageErrors).toHaveLength(pageErrorsBeforeDispose);
      expect(consoleErrors).toHaveLength(consoleErrorsBeforeDispose);
      expect(externalRequests).toEqual([]);
    } finally {
      try {
        const closure = await fixtureServer.close();
        expect(closure).toEqual({
          closed: true,
          listeningAfterClose: false,
          activeConnectionsAfterClose: 0,
        });
        await attestClosedFixture(testInfo, SAMPLE_ID, "startMigrationWorkbenchFixtureServer");
      } finally {
        await finalizeSampleConsole({
          testInfo,
          sampleId: SAMPLE_ID,
          page,
          context,
          pageErrors,
          consoleErrors,
        });
      }
    }
  },
);
