import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";

const FORMAT = "honua.sdk.sample-gate-assertion.v1";

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
  await page.keyboard.press("Tab");
  const tabReachedTarget = await summary.evaluate((element) => document.activeElement === element);
  expect(tabReachedTarget).toBe(true);
  await page.keyboard.press("Enter");
  const activated = await summary.evaluate((element) => element.closest("details")?.open === true);
  expect(activated).toBe(true);
  await page.keyboard.press("Enter");
  return { selector, tabReachedTarget, activated };
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
  runtimeReady,
  pageErrors,
  consoleErrors,
  responsiveViewports,
  workflowSelectors,
}) {
  expect(runtimeReady).toBe(true);
  await attachSampleGate(testInfo, sampleId, "browser", { runtimeReady: true });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  const keyboard = await attestKeyboardWorkflow(page, '[data-testid="honua-sample-evidence"] > summary');
  await attachSampleGate(testInfo, sampleId, "accessibility", {
    engine: accessibility.testEngine,
    violations: accessibility.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
    passes: accessibility.passes.length,
    keyboard,
  });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await attachSampleGate(testInfo, sampleId, "console", { pageErrors, consoleErrors });

  const viewports = await attestResponsiveWorkflows(page, responsiveViewports, workflowSelectors);
  expect(viewports.every((viewport) => viewport.noHorizontalOverflow)).toBe(true);
  expect(viewports.every((viewport) => viewport.workflows.every((workflow) => workflow.visible))).toBe(true);
  await attachSampleGate(testInfo, sampleId, "responsive", { viewports, workflowSelectors });
}

export async function attestClosedFixture(testInfo, sampleId, provider) {
  await attachSampleGate(testInfo, sampleId, "fixture", {
    provider,
    transport: "loopback-http",
    closed: true,
  });
}
