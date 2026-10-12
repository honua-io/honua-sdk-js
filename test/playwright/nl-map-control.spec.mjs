import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createServer } from "vite";

test.setTimeout(90_000);
test("Ask this map executes exact fixture queries and keeps map/table review accessible", async ({
  browser,
}, testInfo) => {
  const server = await createServer({ configFile: "examples/nl-map-control/vite.config.ts", logLevel: "error" });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("Sample server did not bind");
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const external = [];
  const errors = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(url).origin)
      external.push(request.url());
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
    process.stdout.write(`sample-pageerror: ${error.message}\n`);
  });
  try {
    await page.goto(url);
    await expect(page.locator("#startup")).toContainText("Ready.", { timeout: 45_000 });
    const ask = async (question) => {
      await page.getByRole("button", { name: question, exact: true }).click();
      await page.getByRole("button", { name: "Review query", exact: true }).click();
      await expect(page.getByRole("button", { name: "Execute reviewed query" })).toBeEnabled();
      await page.getByRole("button", { name: "Execute reviewed query" }).click();
      await expect(page.locator('[data-phase="succeeded"]')).toBeVisible();
    };
    await ask("Show open incidents in this view");
    await expect(page.locator("#results tr td:first-child")).toHaveText(["1", "2", "4", "5"]);
    await expect
      .poll(() => page.evaluate(async () => (await import("/src/main.ts")).observeDisplayedIncidentIds()))
      .toEqual([1, 2, 4, 5]);
    await ask("Group them by type");
    await expect(page.locator("#groups")).toContainText("medical: 2");
    const select = page.getByRole("button", { name: "Select incident 1", exact: true });
    await select.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#location")).toContainText("Selected incident 1");
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await ask("Only those within 500 metres of this selected location");
    await expect(page.locator("#results tr td:first-child")).toHaveText(["1", "2", "5"]);
    await expect
      .poll(() => page.evaluate(async () => (await import("/src/main.ts")).observeDisplayedIncidentIds()))
      .toEqual([1, 2, 5]);
    await page.getByText("Query, plan and receipt details", { exact: true }).click();
    await expect(page.locator("#ask-control pre")).toContainText("ST_DWithin");
    await expect(page.locator("#ask-control pre")).toContainText('"duckdb-sql"');
    await page.getByRole("button", { name: "Run arbitrary SQL", exact: true }).click();
    await page.getByRole("button", { name: "Review query", exact: true }).click();
    await expect(page.locator('[data-phase="refused"]')).toBeVisible();
    await expect
      .poll(() => page.evaluate(async () => (await import("/src/main.ts")).observeDisplayedIncidentIds()))
      .toEqual([1, 2, 5]);
    await expect(page.locator("#results tr td:first-child")).toHaveText(["1", "2", "5"]);
    await page.getByRole("button", { name: "Show incidents nearby", exact: true }).click();
    await page.getByRole("button", { name: "Review query", exact: true }).click();
    await expect(page.locator('[data-phase="clarification"]')).toBeVisible();
    const evidence = await page.evaluate(async () => {
      const { evaluateRecordedQueriesInBrowser } = await import("/src/evaluation.ts");
      return evaluateRecordedQueriesInBrowser();
    });
    const sourceIdentity = await page.evaluate(async () =>
      (await fetch("/ask-map-source.json", { cache: "no-store" })).json(),
    );
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(
      testInfo.outputPath("recorded-semantic-evaluation.json"),
      JSON.stringify({ ...evidence, sourceIdentity }, null, 2),
    );
    await testInfo.attach("recorded-semantic-evaluation.json", {
      path: testInfo.outputPath("recorded-semantic-evaluation.json"),
      contentType: "application/json",
    });
    expect(evidence.results).toHaveLength(10);
    expect(evidence.passed).toBe(true);
    expect(evidence.liveModelEvidence).toBe(false);
    await page.getByRole("button", { name: "View east of the incidents" }).click();
    await page.getByRole("button", { name: "Show open incidents in this view", exact: true }).click();
    await page.getByRole("button", { name: "Review query", exact: true }).click();
    await expect(page.getByRole("button", { name: "Execute reviewed query" })).toBeEnabled();
    await page.getByRole("button", { name: "Execute reviewed query" }).click();
    await expect(page.locator('[data-phase="empty"]')).toHaveText("0 matching features.");
    await expect(page.locator("#results tr")).toHaveCount(0);
    await page.getByRole("button", { name: "Full incident view" }).click();
    await ask("Show open incidents in this view");
    // HTTP transport control, explicitly not live-model evidence: a late reply
    // from a cancelled request cannot replace a newer refusal or prior results.
    let releaseOld;
    const oldReply = new Promise((resolve) => {
      releaseOld = resolve;
    });
    await page.route("**/api/ask-map/propose", async (route) => {
      const body = route.request().postDataJSON();
      if (body.instruction === "first request") {
        await oldReply;
        await route.fulfill({ json: { refusal: "old reply" } }).catch(() => {});
      } else await route.fulfill({ json: { refusal: "new reply" } });
    });
    await page.getByLabel("Model mode").selectOption("live");
    const firstRequest = page.waitForRequest("**/api/ask-map/propose");
    await page.getByRole("textbox", { name: "Ask this map", exact: true }).fill("first request");
    await page.getByRole("button", { name: "Review query", exact: true }).click();
    await expect(page.locator('[data-phase="planning"]')).toBeVisible();
    await firstRequest;
    await page.getByRole("textbox", { name: "Ask this map", exact: true }).fill("second request");
    await page.getByRole("button", { name: "Review query", exact: true }).click();
    await expect(page.locator('[data-phase="refused"]')).toContainText("new reply");
    releaseOld();
    await expect(page.locator('[data-phase="refused"]')).toContainText("new reply");
    await expect(page.locator("#results tr td:first-child")).toHaveText(["1", "2", "4", "5"]);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    const diagnostics = {
      errors,
      external,
      status: await page
        .locator("#ask-control [role=status]")
        .textContent()
        .catch(() => null),
      details: await page
        .locator("#ask-control pre")
        .textContent()
        .catch(() => null),
    };
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(testInfo.outputPath("browser-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
    await testInfo.attach("browser-diagnostics.json", {
      path: testInfo.outputPath("browser-diagnostics.json"),
      contentType: "application/json",
    });
    await context.close();
    await server.close();
  }
});
