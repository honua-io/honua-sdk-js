import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { startPlanningWorkbenchFixtureServer } from "../../examples/planning-permitting-workbench/mock-server.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

const sampleId = "planning-permitting-workbench";
const expectedSdkMode = process.env.HONUA_SAMPLE_SDK_MODE ?? "source";
const expectedEntrypoints = [
  "@honua/sdk-js/app-workspace",
  "@honua/sdk-js/contract",
  "@honua/sdk-js/exploration",
  "@honua/sdk-js/geocoding",
  "@honua/sdk-js/geometry",
  "@honua/sdk-js/honua",
  "@honua/sdk-js/interactions",
];

test.setTimeout(90_000);

async function assertSdkResolution() {
  const resolutionPath = path.resolve(
    import.meta.dirname,
    "../../examples/planning-permitting-workbench/dist/honua-sample-sdk-resolution.json",
  );
  const resolution = JSON.parse(await readFile(resolutionPath, "utf8"));
  expect(resolution).toMatchObject({
    format: "honua.sdk.sample-resolution.v1",
    mode: expectedSdkMode,
    package: { name: "@honua/sdk-js" },
  });
  expect(resolution.entrypoints.map((entry) => entry.specifier).sort()).toEqual([...expectedEntrypoints].sort());
  expect(resolution.bundle.length).toBeGreaterThan(1);

  if (expectedSdkMode !== "packed") {
    expect(resolution.entrypoints.every((entry) => entry.hashSubject === "repository-source-entrypoint-file")).toBe(
      true,
    );
    return;
  }

  const configuredRoot = process.env.HONUA_SAMPLE_SDK_DIR;
  expect(configuredRoot, "packed Chromium requires the extracted SDK root").toBeTruthy();
  const sdkRoot = await realpath(configuredRoot);
  const manifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
  expect(manifest.name).toBe("@honua/sdk-js");
  for (const entry of resolution.entrypoints) {
    const exportKey = entry.specifier === "@honua/sdk-js" ? "." : `./${entry.specifier.slice("@honua/sdk-js/".length)}`;
    const declaration = manifest.exports[exportKey];
    const target = typeof declaration === "string" ? declaration : declaration?.default;
    expect(target).toBe(entry.exportTarget);
    const absolute = await realpath(path.resolve(sdkRoot, target));
    expect(absolute.startsWith(`${sdkRoot}${path.sep}`)).toBe(true);
    const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
    expect(digest).toBe(entry.sha256);
    expect(entry.hashSubject).toBe("packed-published-entrypoint-file");
  }
}

test(
  "planning workbench runs the public SDK search, analysis, edit, and degradation workflow",
  async ({ browser, browserName }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const fixtureServer = await startPlanningWorkbenchFixtureServer();

    try {
      await assertSdkResolution();
      await page.goto(fixtureServer.url);

      await expect
        .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.ready === true))
        .toBe(true);
      const runtime = await page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__);
      expect(runtime.workflowState).toBe("ready");
      expect(runtime.sdkMode).toBe(expectedSdkMode);
      await expect(page.getByTestId("honua-sample-mode")).toHaveAttribute("data-sdk-mode", expectedSdkMode);
      await expect(page.locator("#workflow-state")).toHaveText("ready");
      await expect(page.locator("#workflow-truth-list")).toContainText("metadata");
      await expect(page.locator("#workflow-truth-list")).toContainText("supported");

      // The tablist supports roving focus and arrow-key activation.
      const reviewTab = page.getByRole("tab", { name: "Review Board" });
      await reviewTab.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "Query & Analysis" })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#query-analysis-module")).toBeVisible();
      await page.keyboard.press("Home");
      await expect(reviewTab).toHaveAttribute("aria-selected", "true");

      // Search delegates to public geocoding and the metadata-backed Source query.
      await page.getByRole("button", { name: "Find parcel" }).click();
      await expect(page.locator("#search-status")).toHaveText("parcel selected");
      await expect(page.locator("#detail-title")).toHaveText("300 Hana Hwy, Kahului");
      await expect.poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.searchFeatureId)).toBe(
        5001,
      );

      // Source work is bounded before exact client geometry runs.
      await page.getByRole("tab", { name: "Query & Analysis" }).click();
      await page.getByRole("button", { name: "Run bounded analysis" }).click();
      await expect(page.locator("#analysis-status")).toHaveText("hazard overlap");
      await expect(page.locator("#analysis-truth-list")).toContainText("25 candidates");
      await expect
        .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.analysisCandidateCount))
        .not.toBeNull();

      // Metadata domains drive the form; unsupported capability truth fails closed.
      await page.getByRole("tab", { name: "Permit Editing" }).click();
      await expect(page.locator("#edit-capability-state")).toHaveText("ready");
      await expect(page.locator("#edit-readiness-list")).toContainText("version field advertised");
      await page.locator("#permit-scenario").selectOption("unsupported");
      await page.getByRole("button", { name: "Submit permit" }).click();
      await expect(page.locator("#edit-status-readout")).toHaveText("unsupported");
      await expect(page.locator("#workflow-degradation")).toHaveAttribute("data-degraded", "true");
      await expect(page.locator("#workflow-degradation")).toContainText("no mutation was attempted");

      // The explicit conflict and successful attachment paths remain observable.
      await page.getByRole("button", { name: "Choose conflict" }).click();
      await page.getByRole("button", { name: "Submit permit" }).click();
      await expect(page.locator("#edit-status-readout")).toHaveText("failed");
      await expect(page.locator("#workflow-degradation")).toContainText("Refresh the selected feature/version");
      await expect(page.locator("#workflow-truth-list")).toContainText("rolled-back");
      await page.locator("#permit-scenario").selectOption("success");
      await page.getByRole("button", { name: "Submit permit" }).click();
      await expect(page.locator("#edit-status-readout")).toHaveText("succeeded");
      await expect(page.locator("#workflow-degradation")).toHaveAttribute("data-degraded", "false");

      // Export is the public review model, not a parallel shell-only representation.
      await page.getByRole("tab", { name: "Query & Analysis" }).click();
      await page.getByRole("button", { name: "Export workspace" }).click();
      await expect(page.locator("#print-status")).toHaveText("planning review exported");
      await expect(page.locator("#print-json")).toContainText("honua.planning-permitting-review");
      await expect(page.locator("#print-json")).toContainText('"workflow": "search-analyze-edit-export"');

      const runtimeReady = await page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.ready === true);
      const sampleReadyDurationMs = await page.evaluate(() => performance.now());
      await page.getByTestId("honua-sample-mode").evaluate((element) => {
        element.tabIndex = -1;
        element.focus();
      });
      await attestBrowserQuality({
        page,
        testInfo,
        sampleId,
        browserName,
        sampleReadyDurationMs,
        runtimeReady,
        responsiveViewports: [
          { width: 1280, height: 720 },
          { width: 390, height: 844 },
        ],
        workflowSelectors: ["#planning-search-form", "#workflow-truth", "#search-status", "#layer-permits"],
      });

      await page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_DISPOSE__?.());
      await expect.poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.disposed)).toBe(
        true,
      );
      await expect(page.locator("button:enabled, input:enabled, select:enabled, textarea:enabled")).toHaveCount(0);
    } finally {
      try {
        await fixtureServer.close();
        await attestClosedFixture(testInfo, sampleId, "startPlanningWorkbenchFixtureServer");
      } finally {
        await finalizeSampleConsole({
          testInfo,
          sampleId,
          page,
          context,
          pageErrors,
          consoleErrors,
        });
      }
    }
  },
);
