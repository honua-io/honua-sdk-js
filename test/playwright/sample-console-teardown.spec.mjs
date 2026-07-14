import { expect, test } from "@playwright/test";

import { finalizeSampleConsole } from "./sample-gate-assertions.mjs";

test("console finalization rejects an error emitted by the owned page close boundary", async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("close", () => consoleErrors.push("late page-close failure"));

  let rejection;
  try {
    await finalizeSampleConsole({
      testInfo,
      sampleId: "console-teardown-regression",
      page,
      context,
      pageErrors,
      consoleErrors,
    });
  } catch (error) {
    rejection = error;
  }

  expect(page.isClosed()).toBe(true);
  expect(consoleErrors).toEqual(["late page-close failure"]);
  expect(rejection).toBeInstanceOf(Error);
});
