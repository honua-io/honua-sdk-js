import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";

import {
  isSampleEvidenceRunId,
  SAMPLE_PERFORMANCE_BUDGET_MS,
  SAMPLE_PERFORMANCE_METRIC,
  SAMPLE_SCREENSHOT_VIEWPORT,
} from "../../scripts/lib/sample-gates.mjs";

const FORMAT = "honua.sdk.sample-gate-assertion.v1";

function controlledEvidenceOutput(value, sampleId, fileName) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || path.resolve(value) !== value) {
    throw new Error(`${fileName} evidence output must be an absolute path`);
  }
  const relative = path.relative(process.cwd(), value).replaceAll(path.sep, "/");
  const prefix = `samples/evidence/${sampleId}/runs/`;
  const suffix = `/artifacts/${fileName}`;
  const runId = relative.startsWith(prefix) && relative.endsWith(suffix)
    ? relative.slice(prefix.length, -suffix.length)
    : "";
  if (!isSampleEvidenceRunId(runId)) {
    throw new Error(`${fileName} evidence output is outside the controlled sample run`);
  }
  return { absolute: value, relative };
}

async function writeBrowserEvidenceArtifacts({
  page,
  testInfo,
  sampleId,
  browserName,
  sampleReadyDurationMs,
  interactionDurationMs,
}) {
  const screenshotOutput = controlledEvidenceOutput(
    process.env.HONUA_SAMPLE_SCREENSHOT_OUTPUT,
    sampleId,
    "screenshot-gate.json",
  );
  const performanceOutput = controlledEvidenceOutput(
    process.env.HONUA_SAMPLE_PERFORMANCE_OUTPUT,
    sampleId,
    "performance-gate.json",
  );
  if (!screenshotOutput && !performanceOutput) return;

  const projectName = testInfo.project.name;
  const evidenceProject = process.env.HONUA_SAMPLE_EVIDENCE_PROJECT;
  if (!evidenceProject) throw new Error("browser evidence output requires HONUA_SAMPLE_EVIDENCE_PROJECT");
  if (projectName !== evidenceProject) return;
  if (!["chromium", "firefox", "webkit"].includes(browserName)) {
    throw new Error(`unsupported Playwright browser evidence engine: ${browserName}`);
  }

  if (screenshotOutput) {
    await mkdir(path.dirname(screenshotOutput.absolute), { recursive: true });
    await page.setViewportSize(SAMPLE_SCREENSHOT_VIEWPORT);
    const screenshotPath = path.join(path.dirname(screenshotOutput.absolute), "screenshot.png");
    await page.screenshot({ path: screenshotPath, animations: "disabled", fullPage: false });
    const bytes = await readFile(screenshotPath);
    const report = {
      projectName,
      browserName,
      viewport: SAMPLE_SCREENSHOT_VIEWPORT,
      path: path.relative(process.cwd(), screenshotPath).replaceAll(path.sep, "/"),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await writeFile(screenshotOutput.absolute, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (performanceOutput) {
    if (
      !Number.isFinite(sampleReadyDurationMs) ||
      sampleReadyDurationMs < 0 ||
      !Number.isFinite(interactionDurationMs) ||
      interactionDurationMs < 0
    ) {
      throw new Error("browser timing observations are unavailable for performance evidence");
    }
    const observations = await page.evaluate(
      ({ readyMs, interactionMs }) => {
        const navigation = performance.getEntriesByType("navigation")[0];
        if (!navigation || navigation.entryType !== "navigation") {
          throw new Error("PerformanceNavigationTiming is unavailable");
        }
        const resources = performance.getEntriesByType("resource");
        return {
          navigation: {
            entryType: navigation.entryType,
            sampleReadyMs: readyMs,
            responseStartMs: navigation.responseStart,
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
            loadEventMs: navigation.loadEventEnd,
          },
          resources: {
            count: resources.length,
            transferBytes: resources.reduce((total, entry) => total + (entry.transferSize ?? 0), 0),
            decodedBodyBytes: resources.reduce((total, entry) => total + (entry.decodedBodySize ?? 0), 0),
            completedByMs: resources.reduce((latest, entry) => Math.max(latest, entry.responseEnd ?? 0), 0),
          },
          interaction: {
            name: "evidence-drawer-keyboard-workflow",
            durationMs: interactionMs,
          },
        };
      },
      { readyMs: sampleReadyDurationMs, interactionMs: interactionDurationMs },
    );
    if (
      observations.navigation.responseStartMs <= 0 ||
      observations.navigation.responseStartMs > observations.navigation.domContentLoadedMs ||
      observations.navigation.domContentLoadedMs > observations.navigation.loadEventMs ||
      observations.navigation.loadEventMs > observations.navigation.sampleReadyMs ||
      observations.resources.count <= 0 ||
      observations.resources.decodedBodyBytes <= 0 ||
      observations.resources.completedByMs <= 0 ||
      observations.resources.completedByMs > observations.navigation.sampleReadyMs ||
      observations.interaction.durationMs <= 0
    ) {
      throw new Error("browser performance observations are incomplete or non-monotonic");
    }
    await mkdir(path.dirname(performanceOutput.absolute), { recursive: true });
    const report = {
      projectName,
      browserName,
      source: "browser-performance-api",
      metric: SAMPLE_PERFORMANCE_METRIC,
      unit: "ms",
      budget: { operator: "<=", value: SAMPLE_PERFORMANCE_BUDGET_MS },
      value: sampleReadyDurationMs,
      observations,
    };
    await writeFile(performanceOutput.absolute, `${JSON.stringify(report, null, 2)}\n`);
  }
}

export async function attachSampleGate(testInfo, sampleId, gate, observations) {
  await testInfo.attach(`honua-gate:${gate}`, {
    body: Buffer.from(
      JSON.stringify({
        format: FORMAT,
        sampleId,
        gate,
        status: "passed",
        observations,
      }),
    ),
    contentType: "application/json",
  });
}

async function attestKeyboardWorkflow(page, selector) {
  const summary = page.locator(selector);
  await expect(summary).toBeVisible();
  await summary.evaluate((element) => {
    const details = element.closest("details");
    if (details) details.open = false;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const interactionStartedAt = await page.evaluate(() => performance.now());
  await page.keyboard.press("Tab");
  const tabReachedTarget = await summary.evaluate((element) => document.activeElement === element);
  expect(tabReachedTarget).toBe(true);
  await page.keyboard.press("Enter");
  const interactionFinishedAt = await page.evaluate(() => performance.now());
  const activated = await summary.evaluate((element) => element.closest("details")?.open === true);
  expect(activated).toBe(true);
  await page.keyboard.press("Enter");
  return { selector, tabReachedTarget, activated, durationMs: interactionFinishedAt - interactionStartedAt };
}

async function attestResponsiveWorkflows(page, viewports, selectors) {
  const observations = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const workflows = [];
    for (const selector of selectors) {
      const element = page.locator(selector);
      await element.scrollIntoViewIfNeeded();
      await expect(element).toBeVisible();
      workflows.push(
        await element.evaluate((node, expectedSelector) => {
          const bounds = node.getBoundingClientRect();
          return {
            selector: expectedSelector,
            visible: bounds.width > 0 && bounds.height > 0,
          };
        }, selector),
      );
    }
    observations.push(
      await page.evaluate(
        ({ expectedViewport, workflowObservations }) => ({
          ...expectedViewport,
          documentWidth: document.documentElement.scrollWidth,
          noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
          workflows: workflowObservations,
        }),
        { expectedViewport: viewport, workflowObservations: workflows },
      ),
    );
  }
  return observations;
}

export async function attestBrowserQuality({
  page,
  testInfo,
  sampleId,
  browserName,
  sampleReadyDurationMs,
  runtimeReady,
  responsiveViewports,
  workflowSelectors,
}) {
  expect(runtimeReady).toBe(true);
  await attachSampleGate(testInfo, sampleId, "browser", {
    runtimeReady: true,
    projectName: testInfo.project.name,
    browserName,
  });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  const keyboard = await attestKeyboardWorkflow(page, '[data-testid="honua-sample-evidence"] > summary');
  await attachSampleGate(testInfo, sampleId, "accessibility", {
    engine: accessibility.testEngine,
    violations: accessibility.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
    passes: accessibility.passes.length,
    keyboard,
  });

  const viewports = await attestResponsiveWorkflows(page, responsiveViewports, workflowSelectors);
  expect(viewports.every((viewport) => viewport.noHorizontalOverflow)).toBe(true);
  expect(viewports.every((viewport) => viewport.workflows.every((workflow) => workflow.visible))).toBe(true);
  await attachSampleGate(testInfo, sampleId, "responsive", { viewports, workflowSelectors });

  await writeBrowserEvidenceArtifacts({
    page,
    testInfo,
    sampleId,
    browserName,
    sampleReadyDurationMs,
    interactionDurationMs: keyboard.durationMs,
  });
}

export async function finalizeSampleConsole({ testInfo, sampleId, page, context, pageErrors, consoleErrors }) {
  try {
    if (!page.isClosed()) {
      await Promise.all([page.waitForEvent("close", { timeout: 5_000 }), page.close({ runBeforeUnload: true })]);
    }
  } finally {
    await context.close();
  }
  await new Promise((resolve) => setImmediate(resolve));
  expect(page.isClosed()).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await attachSampleGate(testInfo, sampleId, "console", {
    pageErrors: [...pageErrors],
    consoleErrors: [...consoleErrors],
    pageClosed: true,
    contextClosed: true,
    finalizationBoundary: "owned-page-and-context-close",
    finalizedAfterTeardown: true,
  });
}

export async function attestClosedFixture(testInfo, sampleId, provider) {
  await attachSampleGate(testInfo, sampleId, "fixture", {
    provider,
    transport: "loopback-http",
    closed: true,
  });
}
