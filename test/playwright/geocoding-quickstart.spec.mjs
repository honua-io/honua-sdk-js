import { expect, test } from "@playwright/test";

import { startGeocodingFixtureServer } from "../../examples/geocoding-quickstart/mock-server.mjs";

test.setTimeout(90_000);

const HONOLULU_HALE = "530 S King St, Honolulu, HI 96813, USA";
const ALA_MOANA = "1450 Ala Moana Blvd, Honolulu, HI 96814, USA";
let server;

test.beforeAll(async () => {
  server = await startGeocodingFixtureServer();
});

test.afterAll(async () => {
  await server?.close();
});

function captureErrors(page) {
  const errors = { console: [], page: [], requests: [], responses: [] };
  page.on("console", (message) => {
    if (message.type() === "error") errors.console.push(message.text());
  });
  page.on("pageerror", (error) => errors.page.push(error.message));
  page.on("requestfailed", (request) => errors.requests.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.responses.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

test("pins the exact fixture result and keeps selection, text, and marker synchronized", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = captureErrors(page);
  const geocodeResponses = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/rest/services/World/GeocodeServer/findAddressCandidates")) {
      geocodeResponses.push(response.status());
    }
  });

  const startedAt = Date.now();
  await page.goto(server.url);
  await expect
    .poll(async () => page.evaluate(() => window.__HONUA_GEOCODING_DEMO__?.ready === true), { timeout: 3_000 })
    .toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(3_000);

  await expect(page.locator("#selected-address")).toHaveText(HONOLULU_HALE);
  await expect(page.locator("#selected-detail")).toHaveText("PointAddress / score 100 / World locator");
  await expect(page.locator("#candidate-count")).toHaveText("4");
  await expect(page.locator(".maplibregl-marker")).toHaveCount(1);
  await expect(page.locator(".legend")).toContainText("Selected pin");
  await expect(page.getByLabel("Data mode: fixture only")).toBeVisible();

  expect(
    await page.evaluate(() => {
      const runtime = window.__HONUA_GEOCODING_DEMO__;
      return {
        address: runtime?.selectedAddress,
        score: runtime?.selectedScore,
        coordinates: runtime?.selectedCoordinates,
        results: runtime?.resultCount,
        markers: runtime?.markerCount,
        error: runtime?.lastError,
      };
    }),
  ).toEqual({
    address: HONOLULU_HALE,
    score: 100,
    coordinates: [-157.85833, 21.30455],
    results: 4,
    markers: 1,
    error: null,
  });

  await page.locator("#address-select").selectOption("1");
  await expect(page.locator("#selected-address")).toHaveText(ALA_MOANA);
  await expect(page.locator("#selected-detail")).toHaveText("PointAddress / score 98 / World locator");
  await expect(page.locator("#selected-coordinates")).toHaveText("-157.84365, 21.29118");
  await expect(page.locator("#address-select")).toHaveValue("1");
  expect(await page.evaluate(() => window.__HONUA_GEOCODING_DEMO__?.selectedAddress)).toBe(ALA_MOANA);
  expect(await page.evaluate(() => window.__HONUA_GEOCODING_DEMO__?.selectedCoordinates)).toEqual([
    -157.84365, 21.29118,
  ]);

  const mapBox = await page.locator(".map-panel").boundingBox();
  const resultBox = await page.locator(".result-panel").boundingBox();
  const provenanceBox = await page.locator(".implementation").boundingBox();
  expect(mapBox.width).toBeGreaterThan(resultBox.width);
  expect(mapBox.x).toBeLessThan(resultBox.x);
  expect(mapBox.height).toBeGreaterThanOrEqual(560);
  expect(provenanceBox.y).toBeGreaterThan(resultBox.y + resultBox.height);

  expect(geocodeResponses).toEqual([200]);
  expect(errors).toEqual({ console: [], page: [], requests: [], responses: [] });
  await expect(page.locator("body")).not.toContainText(/failed|failure|unavailable|error/i);
});

test("keeps the map first, the selected result visible, and the map at least 40vh on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = captureErrors(page);
  await page.goto(server.url);
  await expect
    .poll(async () => page.evaluate(() => window.__HONUA_GEOCODING_DEMO__?.ready === true), { timeout: 3_000 })
    .toBe(true);

  const mapBox = await page.locator(".map-panel").boundingBox();
  const resultBox = await page.locator(".result-panel").boundingBox();
  const addressBox = await page.locator("#selected-address").boundingBox();
  expect(mapBox.y).toBeLessThan(resultBox.y);
  expect(mapBox.height).toBeGreaterThanOrEqual(844 * 0.4);
  expect(addressBox.y).toBeLessThan(844);
  await expect(page.locator("#selected-address")).toHaveText(HONOLULU_HALE);
  await expect(page.locator(".maplibregl-marker")).toHaveCount(1);
  expect(errors).toEqual({ console: [], page: [], requests: [], responses: [] });
});
