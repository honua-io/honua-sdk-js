import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { startOvertureFixtureServer } from "../../examples/overture-geoparquet/mock-server.mjs";
import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";

test.setTimeout(120_000);
test.describe.configure({ mode: "serial" });

let server;

test.beforeAll(async () => {
  server = await startOvertureFixtureServer();
});

test.afterAll(async () => {
  await server?.close();
});

function observeBrowser(page) {
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  const externalExtensionRequests = [];
  const localExtensionRequests = [];
  const fixtureOrigin = new URL(server.url).origin;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== fixtureOrigin) externalRequests.push(request.url());
    if (requestUrl.hostname === "extensions.duckdb.org" || requestUrl.hostname === "cdn.jsdelivr.net") {
      externalExtensionRequests.push(request.url());
    }
    if (requestUrl.origin === fixtureOrigin && requestUrl.pathname.includes("/duckdb/extensions/")) {
      localExtensionRequests.push(request.url());
    }
  });
  return { pageErrors, consoleErrors, externalRequests, externalExtensionRequests, localExtensionRequests };
}

async function openReady(page) {
  await page.route("https://extensions.duckdb.org/**", (route) => route.abort("blockedbyclient"));
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort("blockedbyclient"));
  await page.goto(server.url);
  await expect
    .poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.ready === true), { timeout: 90_000 })
    .toBe(true);
}

test("one accepted S1 artifact drives the linked MapLibre, table, chart, selection, and receipts", async ({ page }) => {
  const observed = observeBrowser(page);
  await openReady(page);

  await expect(page.locator("#engine-state")).toHaveText("Linked analysis ready");
  await expect(page.locator("#analysis-state")).toHaveText("Ready");
  await expect(page.locator("#renderer-state")).toHaveText("MapLibre bounded fallback");
  await expect(page.locator("#renderer-state")).toHaveAttribute("data-state", "degraded");
  await expect(page.locator("#lane-badge")).toHaveText("Deterministic fixture");
  await expect(page.locator("#metric-projection")).toContainText("bbox");
  await expect(page.locator("#metric-files")).toHaveText("1 / 1 via fixture manifest bbox");
  await expect(page.locator("#metric-memory-policy")).toHaveText("256 MiB");
  await expect(page.locator("#evidence-ranges")).toContainText("2,124 bytes / 1 range");
  await expect(page.locator("#evidence-rows")).toHaveText("not exposed / 8");
  await expect(page.locator("#evidence-pruning")).toHaveText("not exposed");
  await expect(page.locator("#evidence-fidelity")).toHaveText("exact");
  await expect(page.locator("#evidence-engine-cache")).toHaveText("bypass · execution-only");
  await expect(page.locator("#result-body tr")).toHaveCount(8);
  await expect(page.locator("#result-summary")).toHaveText("8 / 8 rows · one artifact");
  await expect(page.locator("#map-feature-list button")).toHaveCount(8);
  await expect(page.locator("#result-chart button")).toHaveCount(7);
  await expect(page.locator("#result-map canvas")).toBeVisible();
  await expect(page.getByLabel("Data lane")).toBeVisible();
  await expect(page.getByLabel("AOI · xmin,ymin,xmax,ymax")).toBeEditable();
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.parquetRuntime)).toEqual({
    duckDbVersion: "v1.4.3",
    parquetScanRows: 8,
    readParquetRows: 8,
  });

  const linkedRun = await page.evaluate(() => ({
    evidence: window.__HONUA_OVERTURE__?.lastEvidence,
    artifact: window.__HONUA_OVERTURE__?.lastArtifact,
    presentation: window.__HONUA_OVERTURE__?.lastPresentation,
  }));
  expect(linkedRun.evidence.queryPlan).toMatchObject({ version: "2.0", pushdown: "full", fidelity: "exact" });
  expect(linkedRun.evidence.queryPlan.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(linkedRun.evidence.queryPlan.cacheIdentity).toBe(
    `honua-query-plan:2.0:${linkedRun.evidence.queryPlan.fingerprint}`,
  );
  expect(JSON.stringify(linkedRun.evidence.queryPlan)).not.toContain("overture-places.parquet");
  expect(linkedRun.artifact).toMatchObject({
    format: "honua.sdk.cloud-native-linked-analysis.v1",
    state: "ready",
    execution: {
      source: { lane: "fixture", release: "fixture-places-v2", schemaVersion: "fixture-v2" },
      rows: { scanned: { fidelity: "unsupported", value: null }, returned: { fidelity: "exact", value: 8 } },
      pruning: { rowGroupsPruned: { fidelity: "unsupported", value: null } },
      cache: { policy: "bypass", scope: "execution-only" },
      presentation: { fidelity: "unsupported", value: null },
    },
    materialization: { rowCount: 8, geometryFeatureCount: 8, chartBucketCount: 7 },
  });
  expect(linkedRun.artifact.rows.map((row) => row.id)).toEqual(
    linkedRun.artifact.map.features.map((feature) => feature.id),
  );
  expect(linkedRun.artifact.materialization.materializedBytes).toBeLessThanOrEqual(
    linkedRun.artifact.materialization.policy.maxMaterializedBytes,
  );
  expect(linkedRun.artifact.execution.cache.identity).toMatch(/^honua-cloud-native-analysis:v1:sha256:[0-9a-f]{64}$/);
  expect(linkedRun.artifact.execution.cache.engine).toEqual({
    name: "duckdb-wasm",
    version: "v1.4.3",
    verification: "caller-declared",
    cacheScope: "execution-only",
  });
  expect(linkedRun.presentation).toMatchObject({
    format: "honua.sdk.cloud-native-presentation.v1",
    artifactId: linkedRun.artifact.id,
    resultCache: "miss",
    renderer: {
      strategy: "maplibre-bounded-geojson-fallback",
      state: "degraded",
      optionalRecipe: "kepler-analytics",
    },
    materialized: { rows: 8, geometries: 8, chartBuckets: 7 },
  });
  expect(linkedRun.presentation.timing.artifactProduction.sdkPlanMs).toBeGreaterThanOrEqual(0);
  expect(linkedRun.presentation.timing.artifactProduction.sourceProbeMs).toBeGreaterThanOrEqual(0);
  expect(linkedRun.presentation.timing.artifactProduction.engineExecutionMs).toBeGreaterThanOrEqual(0);
  expect(linkedRun.presentation.timing.delivery.sdkPlanMs).toBeGreaterThanOrEqual(0);
  expect(linkedRun.presentation.timing.delivery.sourceProbeMs).toBeGreaterThanOrEqual(0);
  expect(linkedRun.presentation.timing.delivery.engineExecutionMs).toBeGreaterThanOrEqual(0);
  expect(linkedRun.presentation.timing.delivery.rendererMs).toBeLessThan(5_000);
  expect(linkedRun.presentation.timing.delivery.wallMs).toBeGreaterThanOrEqual(
    linkedRun.presentation.timing.delivery.rendererMs,
  );
  expect(linkedRun.evidence.timing.totalMs).toBeLessThan(15_000);

  const tableButton = page.locator('.row-selection[data-feature-id="08f2a3c1d4e5f601"]');
  await tableButton.focus();
  await page.keyboard.press("Enter");
  await expect(tableButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.map-result-button[data-feature-id="08f2a3c1d4e5f601"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('.chart-bucket[data-category="civic"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#selection-title")).toHaveText("Honolulu Hale");
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.selectedId)).toBe("08f2a3c1d4e5f601");

  const beachBucket = page.locator('.chart-bucket[data-category="beach"]');
  await beachBucket.focus();
  await page.keyboard.press("Space");
  await expect(beachBucket).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#selection-title")).toHaveText("Waikiki Beach");
  await expect(page.locator('.row-selection[data-feature-id="08f2a3c1d4e5f604"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const engineStartsBeforeCache = await page.evaluate(() => window.__HONUA_OVERTURE__?.engineStartCount);
  await page.getByRole("button", { name: "Plan + run" }).click();
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
  await expect(page.locator("#cache-badge")).toHaveText("UI result cache hit · engine cache bypass");
  await expect(page.locator("#evidence-ranges")).toContainText("0 bytes / 0 ranges this delivery");
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.engineStartCount)).toBe(engineStartsBeforeCache);
  const cacheHitPresentation = await page.evaluate(() => window.__HONUA_OVERTURE__?.lastPresentation);
  expect(cacheHitPresentation.resultCache).toBe("hit");
  expect(cacheHitPresentation.timing.artifactProduction).toEqual(linkedRun.presentation.timing.artifactProduction);
  expect(cacheHitPresentation.timing.delivery).toMatchObject({
    sdkPlanMs: 0,
    sourceProbeMs: 0,
    engineExecutionMs: 0,
  });

  await page.selectOption("#category", "beach");
  await page.getByRole("button", { name: "Plan + run" }).click();
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
  await expect(page.locator("#result-body tr")).toHaveCount(2);
  await expect(page.locator("#result-body")).toContainText("Waikiki Beach");
  await expect(page.locator("#map-feature-list button")).toHaveCount(2);
  await expect(page.locator("#result-chart button")).toHaveCount(1);

  await page.getByRole("button", { name: "Tighten row policy" }).click();
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
  await expect(page.getByLabel("Row limit")).toHaveValue("25");
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.lastArtifact?.execution.query.limit)).toBe(25);

  const boundaryAoi = [-157.897, 21.306, -157.896, 21.308];
  await page.evaluate((aoi) => window.__HONUA_OVERTURE__?.runQuery("fixture", aoi, "civic", 8), boundaryAoi);
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
  await expect(page.locator("#result-body tr")).toHaveCount(1);
  await expect(page.locator("#result-body")).toContainText("Honolulu Hale");
  const boundaryViewport = await page.evaluate(() => ({
    coordinate: window.__HONUA_OVERTURE__?.lastArtifact?.map.features[0]?.geometry.coordinates,
    viewport: window.__HONUA_OVERTURE__?.mapViewport,
  }));
  expect(boundaryViewport.coordinate[0]).toBeGreaterThan(boundaryAoi[2]);
  expect(boundaryViewport.viewport[0][0]).toBeLessThanOrEqual(boundaryAoi[0]);
  expect(boundaryViewport.viewport[1][0]).toBeGreaterThanOrEqual(boundaryViewport.coordinate[0]);

  await page.locator("#aoi").fill("-180,-90,180,90");
  await page.getByRole("button", { name: "Plan + run" }).click();
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("rejected");
  await expect(page.getByRole("alert")).toContainText("safety budget");
  await expect(page.locator("#analysis-state")).toHaveText("Error");
  await expect(page.locator("#result-body tr")).toHaveCount(0);
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.lastArtifact)).toBeUndefined();
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.lastEvidence)).toBeUndefined();
  await expect(page.locator("#evidence-artifact")).toHaveText("none");

  await page.locator("#aoi").fill("-158.29,21.21,-158.28,21.22");
  await page.selectOption("#category", "all");
  await page.getByRole("button", { name: "Plan + run" }).click();
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
  await expect(page.locator("#analysis-state")).toHaveText("Empty");
  await expect(page.locator("#result-body .empty-state")).toHaveText("The accepted bounded query returned no rows.");
  await expect(page.locator("#map-feature-list")).toHaveText("No map features in this accepted artifact.");
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.lastArtifact?.state)).toBe("empty");

  expect(() =>
    validateEvidenceEnvelope({
      format: "honua.sdk.sample-evidence.v1",
      schemaVersion: 1,
      sampleId: "overture-geoparquet",
      lane: "fixture",
      status: "executed",
      reason: null,
      observedAt: linkedRun.evidence.range.observedAt,
      authMode: "none",
      sdk: { package: "@honua/sdk-js", version: "0.1.0-beta.0", gitCommit: null },
      source: {
        provider: "repository-fixture",
        identity: linkedRun.evidence.plan.selectedObjects[0].objectKey,
        endpoint: null,
        deploymentVersion: "fixture-places-v2",
        dataVersion: "fixture-v2",
      },
      provenance: {
        sourceId: "fixture:overture-places",
        observedAt: linkedRun.evidence.range.observedAt,
        validAt: null,
        state: "replayed",
        attribution: "Synthetic Overture-shaped fixture",
      },
      semantics: {
        operation: "bounded-aoi-linked-columnar-query",
        outcome: "one-artifact-map-table-chart-selection",
        itemCount: linkedRun.evidence.rowsReturned,
        assertions: ["zero-cross-origin-requests", "memory-ceiling-enforced", "unsafe-aoi-rejected"],
      },
      timing: {
        totalMs: linkedRun.evidence.timing.totalMs,
        firstSuccessfulInteractionMs: linkedRun.evidence.timing.sdkPlanMs,
      },
      degradation: {
        state: "expected",
        reasons: ["MapLibre bounded-object fallback; direct GeoArrow/deck.gl is not qualified"],
      },
      artifacts: [],
    }),
  ).not.toThrow();

  expect(observed.externalRequests).toEqual([]);
  expect(observed.externalExtensionRequests).toEqual([]);
  expect(new Set(observed.localExtensionRequests)).toEqual(
    new Set([`${new URL(server.url).origin}/duckdb/extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`]),
  );
  expect(observed.pageErrors).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
});

test("loading, cancellation, and latest-wins prevent stale artifacts from committing", async ({ page }) => {
  const observed = observeBrowser(page);
  await openReady(page);

  await page.evaluate(() => {
    void window.__HONUA_OVERTURE__?.runQuery("fixture", undefined, "historic", 7);
  });
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.workflowState)).toBe("loading");
  await expect(page.locator("#analysis-state")).toHaveText("Loading");
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.lastArtifact?.execution.query.category)).toBe(
    "historic",
  );

  await page.evaluate(async () => {
    const stale = window.__HONUA_OVERTURE__?.runQuery("fixture", undefined, "beach", 8);
    const latest = window.__HONUA_OVERTURE__?.runQuery("fixture", undefined, "retail", 8);
    await Promise.all([stale, latest]);
  });
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.lastArtifact?.execution.query.category)).toBe("retail");
  await expect(page.locator("#result-body tr")).toHaveCount(1);
  await expect(page.locator("#result-body")).toContainText("Ala Moana Center");
  await expect(page.locator("#result-body")).not.toContainText("Waikiki Beach");

  const engineStartsBeforeCancel = await page.evaluate(() => window.__HONUA_OVERTURE__?.engineStartCount ?? 0);
  await page.evaluate(() => {
    void window.__HONUA_OVERTURE__?.runQuery("fixture", undefined, "civic", 6);
  });
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("executing");
  await page.getByRole("button", { name: "Cancel worker" }).click();
  await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("cancelled");
  await expect(page.locator("#analysis-state")).toHaveText("Cancelled");
  await expect(page.locator("#query-message")).toContainText("stale batches are ignored");
  await expect(page.locator("#result-body tr")).toHaveCount(0);
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.lastArtifact)).toBeUndefined();
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.lastEvidence)).toBeUndefined();
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.engineStartCount ?? 0)).toBeGreaterThan(
    engineStartsBeforeCancel,
  );
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("cancelled");

  expect(observed.externalRequests).toEqual([]);
  expect(observed.externalExtensionRequests).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
});

test("the linked workflow is keyboard-operable and bounded at a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const observed = observeBrowser(page);
  await openReady(page);

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#analysis-workflow")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Cloud-native analysis" })).toBeVisible();
  await expect(page.getByRole("region", { name: "MapLibre view of returned Overture places" })).toBeVisible();
  await expect(page.getByLabel("Keyboard-accessible map results")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tighten row policy" })).toBeVisible();

  const mapResult = page.locator('.map-result-button[data-feature-id="08f2a3c1d4e5f607"]');
  await mapResult.focus();
  await page.keyboard.press("Enter");
  await expect(mapResult).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#selection-title")).toHaveText("Kailua Beach Park");
  await expect(page.locator('.row-selection[data-feature-id="08f2a3c1d4e5f607"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('.chart-bucket[data-category="beach"]')).toHaveAttribute("aria-pressed", "true");

  await expect
    .poll(async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(observed.externalRequests).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
});
