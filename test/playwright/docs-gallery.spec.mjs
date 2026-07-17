import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import playwrightUtilsBundle from "../../node_modules/playwright-core/lib/utilsBundle.js";

const { PNG } = playwrightUtilsBundle;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(repositoryRoot, "dist/docs-site");
const hostedBasePath = "/honua-sdk-js/docs/";
const sourceRevision = "a".repeat(40);
const galleryProjection = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "samples/dist/honua-site-samples.v2.json"), "utf8"),
);
const galleryVisualEvidence = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "samples/dist/honua-site-visual-evidence.v1.json"), "utf8"),
);
const sampleKit = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "examples/_kit/manifest.v1.json"), "utf8"));
const publicTracks = new Set(["golden", "recipe", "lab"]);
const publicSamples = galleryProjection.samples.filter((sample) => publicTracks.has(sample.track));
const endpointSample = publicSamples.find((sample) => sample.id === "endpoint-to-map");
if (!endpointSample) throw new Error("The stable endpoint-to-map gallery sample is missing from the site projection");
const firstMapSample = publicSamples.find((sample) => sample.id === "maplibre-quickstart");
if (!firstMapSample) throw new Error("The First Map gallery sample is missing from the site projection");
const publicSamplePaths = publicSamples.map((sample) => `samples/${sample.id}.html`);
const uniqueLegacyPaths = [...new Set(galleryProjection.routes.map((route) => route.route))].sort();
const kitSampleIds = sampleKit.samples.map(({ id }) => id);
const publicSampleById = new Map(publicSamples.map((sample) => [sample.id, sample]));
const docsHandoffPaths = [
  "gallery.html",
  "samples/index.html",
  "samples/routes.html",
  "samples/site-handoff.v1.json",
  ...publicSamplePaths,
  ...uniqueLegacyPaths,
].sort();
const requiredSameOriginPaths = new Set([
  `${hostedBasePath}gallery.html`,
  `${hostedBasePath}assets/style.css`,
  `${hostedBasePath}assets/gallery.js`,
]);
const allowedVisualPaths = new Set(
  galleryVisualEvidence.qualifiedGoldenJourneys.flatMap((entry) =>
    entry.screenshots.map((screenshot) => `${hostedBasePath}${screenshot.publicationPath}`),
  ),
);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

let fixture;
let gallerySurfaceSha256;
let galleryClientBytes;

test.setTimeout(180_000);

test.beforeAll(async () => {
  buildDocsSite();
  const firstDigest = gallerySurfaceDigest();
  buildDocsSite();
  gallerySurfaceSha256 = gallerySurfaceDigest();
  if (firstDigest !== gallerySurfaceSha256) throw new Error("Docs gallery build is not byte-deterministic");
  galleryClientBytes = fs.statSync(path.join(docsRoot, "assets/gallery.js")).size;
  if (galleryClientBytes > 64 * 1024) throw new Error("Docs gallery client exceeded its 64 KiB runtime boundary");
  fixture = await startHostedDocsServer();
});

test.afterAll(async () => {
  await fixture?.close();
});

test("gallery is accessible, deterministic, relocatable, and interactive after going offline", async ({ context, page }, testInfo) => {
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  const sameOriginPaths = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== fixture.origin) externalRequests.push(url.href);
    else sameOriginPaths.push(url.pathname);
  });

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send("Emulation.setScrollbarsHidden", { hidden: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  const navigation = await page.goto(fixture.galleryUrl);
  expect(navigation?.status()).toBe(200);
  expect(navigation?.headers()["content-security-policy"]).toContain("default-src 'self'");
  await expect(page.getByRole("heading", { name: "Demo gallery", level: 1 })).toBeVisible();
  await expect(page.locator("[data-gallery-result-count]")).toHaveText(String(publicSamples.length));
  await expect(page.locator("[data-gallery-card]")).toHaveCount(publicSamples.length);
  await expect(page.locator(`[data-sample-id="${endpointSample.id}"]`)).toContainText(endpointSample.title);
  await expect(page.locator('[data-sample-id="realtime-incident-dashboard"]')).toContainText(
    "Realtime Incident Operations",
  );
  expect(await accessibilityViolations(page)).toEqual([]);

  const desktopWarmup = await stableScreenshotPair(page);
  await testInfo.attach("docs-gallery-desktop-warmup", { body: desktopWarmup.first, contentType: "image/png" });
  expect(desktopWarmup.firstSha256).toBe(desktopWarmup.secondSha256);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Demo gallery", level: 1 })).toBeVisible();
  const desktop = await stableScreenshotPair(page);
  await testInfo.attach("docs-gallery-desktop", {
    body: desktop.first,
    contentType: "image/png",
  });
  expect(desktop.firstSha256).toBe(desktop.secondSha256);
  const warmupDifference = screenshotPixelDifference(desktopWarmup.first, desktop.first);
  expect(warmupDifference.dimensionsMatch).toBe(true);
  expect(warmupDifference.differentPixels).toBeLessThanOrEqual(64);
  expect(warmupDifference.maxChannelDelta).toBeLessThanOrEqual(1);

  await context.setOffline(true);
  const search = page.locator("[data-gallery-search]");
  const capability = page.locator("[data-gallery-capability]");
  const protocol = page.locator("[data-gallery-protocol]");
  const renderer = page.locator("[data-gallery-renderer]");
  const dataMode = page.locator("select[data-gallery-data-mode]");
  const authMode = page.locator("select[data-gallery-auth-mode]");
  const supportTier = page.locator("select[data-gallery-support-tier]");
  const lifecycleState = page.locator("select[data-gallery-lifecycle-state]");
  const clear = page.locator("[data-gallery-clear]");
  await search.focus();
  await search.pressSequentially("endpoint to map");
  await expect(page.locator("[data-gallery-result-count]")).toHaveText("2");
  await expect(page.locator(`[data-sample-id="${endpointSample.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-sample-id="${firstMapSample.id}"]`)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(capability).toBeFocused();
  await capability.selectOption("map");
  await expect(page.locator("[data-gallery-result-count]")).toHaveText("2");
  await page.keyboard.press("Tab");
  await expect(protocol).toBeFocused();
  await protocol.selectOption("geoservices");
  await expect(page.locator("[data-gallery-result-count]")).toHaveText("1");
  await expect(page.locator('[data-gallery-card]:not([hidden])')).toHaveAttribute("data-sample-id", endpointSample.id);
  for (const control of [renderer, dataMode, authMode, supportTier, lifecycleState, clear]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
  await expect(page.locator("[data-gallery-result-count]")).toHaveText(String(publicSamples.length));

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("search", { name: "Filter demo gallery" })).toBeVisible();
  expect(
    await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    })),
  ).toEqual({ documentWidth: 390, viewportWidth: 390 });
  expect(await accessibilityViolations(page)).toEqual([]);
  const mobile = await stableScreenshotPair(page);
  await testInfo.attach("docs-gallery-mobile", { body: mobile.first, contentType: "image/png" });
  const mobileDifference = screenshotPixelDifference(mobile.first, mobile.second);
  expect(mobileDifference).toEqual({
    dimensionsMatch: true,
    differentPixels: 0,
    maxChannelDelta: 0,
  });
  expect(mobile.firstSha256).toBe(mobile.secondSha256);
  expect(mobile.firstSha256).not.toBe(desktop.firstSha256);

  const visualEvidence = {
    sourceRevision,
    hostedBasePath,
    gallerySurfaceSha256,
    galleryClient: { bytes: galleryClientBytes, budgetBytes: 64 * 1024 },
    desktop: {
      viewport: { width: 1280, height: 720 },
      sha256: desktop.firstSha256,
      warmupTolerance: { maxDifferentPixels: 64, maxChannelDelta: 1 },
    },
    mobile: { viewport: { width: 390, height: 844 }, sha256: mobile.firstSha256 },
  };
  await testInfo.attach("docs-gallery-visual-determinism", {
    body: Buffer.from(`${JSON.stringify(visualEvidence, null, 2)}\n`),
    contentType: "application/json",
  });
  process.stdout.write(`docsGalleryBrowserEvidence=${JSON.stringify(visualEvidence)}\n`);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
  const observedSameOriginPaths = new Set(sameOriginPaths);
  for (const requiredPath of requiredSameOriginPaths) expect(observedSameOriginPaths).toContain(requiredPath);
  expect(
    [...observedSameOriginPaths].filter(
      (requestPath) => !requiredSameOriginPaths.has(requestPath) && !allowedVisualPaths.has(requestPath),
    ),
  ).toEqual([]);
});

test("sample-kit pages and every declared compatibility path resolve without overstating qualification", async ({
  page,
  request,
}) => {
  const siteUrl = (relative) => `${fixture.origin}${hostedBasePath}${relative}`;
  const handoffResponse = await request.get(siteUrl("samples/site-handoff.v1.json"));
  expect(handoffResponse.status()).toBe(200);
  const handoff = await handoffResponse.json();
  expect(handoff).toMatchObject({
    format: "honua.site.sdk-sample-route-publication.v1",
    schemaVersion: 1,
    declaredRouteCount: galleryProjection.routes.length,
  });
  expect(handoff.canonicalSamples).toHaveLength(publicSamples.length);
  expect(handoff.legacyRoutes).toHaveLength(uniqueLegacyPaths.length);
  expect(new Set(handoff.legacyRoutes.map(({ path }) => path)).size).toBe(handoff.legacyRoutes.length);
  expect(handoff.legacyRoutes.find(({ path }) => path === "demo.html").routeIds).toEqual([
    "maui-explorer",
    "quickstart-map",
  ]);

  for (const relative of [...publicSamplePaths, ...uniqueLegacyPaths, "samples/index.html", "samples/routes.html"]) {
    const response = await request.get(siteUrl(relative));
    expect(response.status(), relative).toBe(200);
  }

  await page.goto(siteUrl("samples/index.html"));
  await expect(page.getByRole("heading", { name: "Runnable sample kit", level: 1 })).toBeVisible();
  await expect(page.locator("[data-kit-sample-id]")).toHaveCount(kitSampleIds.length);
  expect(await accessibilityViolations(page)).toEqual([]);

  for (const sampleId of kitSampleIds) {
    const sample = publicSampleById.get(sampleId);
    expect(sample, `${sampleId} must remain a public projected sample`).toBeTruthy();
    await page.goto(siteUrl(`samples/${sampleId}.html`));
    await expect(page.getByRole("heading", { name: sample.title, level: 2 })).toBeVisible();
    await expect(page.locator("[data-sample-kit-modes]")).toHaveAttribute("data-sample-kit-modes", "source packed");
    await expect(page.locator(".sample-consumption")).toContainText(
      `npm run samples:run -- verify --sample ${sampleId} --sdk-mode source`,
    );
    await expect(page.locator(".sample-consumption")).toContainText(
      `npm run samples:run -- verify --sample ${sampleId} --sdk-mode packed`,
    );
    await expect(page.locator(".demo-facts--essential")).toContainText("not receipt-qualified");
    expect(await accessibilityViolations(page)).toEqual([]);
  }

  const redirects = new Map([
    ["demo.html", "maplibre-quickstart"],
    ["sample-codemod.html", "migration-workbench"],
    ["sample-service-explorer.html", "service-explorer"],
    ["sample-expr-builder.html", "standalone-quickstart"],
  ]);
  for (const [legacyPath, sampleId] of redirects) {
    await page.goto(siteUrl(legacyPath));
    await expect(page).toHaveURL(siteUrl(`samples/${sampleId}.html`));
    await expect(page.getByRole("heading", { name: publicSampleById.get(sampleId).title, level: 2 })).toBeVisible();
  }

  await page.goto(siteUrl("demo-esri-leaflet.html"));
  await expect(page.locator("[data-route-resolution=not-public]")).toContainText("not-public");
  await expect(page.locator("main")).toContainText("internal SDK fixture");
  await page.goto(siteUrl("sample-control-legend.html"));
  await expect(page.locator("[data-route-resolution=site-exception]")).toContainText("site-exception");
  await expect(page.locator("main")).toContainText("presentation-site exception");
  expect(await accessibilityViolations(page)).toEqual([]);
});

function buildDocsSite() {
  execFileSync(process.execPath, ["scripts/build-docs-site.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, HONUA_SOURCE_REVISION: sourceRevision },
    stdio: "pipe",
  });
}

function gallerySurfaceDigest() {
  const digest = createHash("sha256");
  for (const relative of [...docsHandoffPaths, "assets/style.css", "assets/gallery.js"].sort()) {
    const name = Buffer.from(relative, "utf8");
    const bytes = fs.readFileSync(path.join(docsRoot, relative));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(name.byteLength));
    digest.update(length).update(name);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    digest.update(length).update(bytes);
  }
  return digest.digest("hex");
}

async function accessibilityViolations(page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary })),
  }));
}

async function stableScreenshotPair(page) {
  const priorScrollBehavior = await page.evaluate(async () => {
    await document.fonts?.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const root = document.documentElement;
    const priorScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return priorScrollBehavior;
  });
  const screenshotOptions = {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  };
  let first;
  let second;
  try {
    first = await page.screenshot(screenshotOptions);
    second = await page.screenshot(screenshotOptions);
  } finally {
    await page.evaluate((scrollBehavior) => {
      document.documentElement.style.scrollBehavior = scrollBehavior;
    }, priorScrollBehavior);
  }
  return {
    first,
    second,
    firstSha256: createHash("sha256").update(first).digest("hex"),
    secondSha256: createHash("sha256").update(second).digest("hex"),
  };
}

function screenshotPixelDifference(first, second) {
  const left = PNG.sync.read(first);
  const right = PNG.sync.read(second);
  if (left.width !== right.width || left.height !== right.height) {
    return { dimensionsMatch: false, differentPixels: Number.POSITIVE_INFINITY, maxChannelDelta: 255 };
  }
  let differentPixels = 0;
  let maxChannelDelta = 0;
  for (let offset = 0; offset < left.data.byteLength; offset += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(left.data[offset + channel] - right.data[offset + channel]);
      pixelDiffers ||= delta > 0;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (pixelDiffers) differentPixels += 1;
  }
  return { dimensionsMatch: true, differentPixels, maxChannelDelta };
}

function boundedDocsFile(pathname) {
  if (!pathname.startsWith(hostedBasePath)) return undefined;
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice(hostedBasePath.length)) || "index.html";
  } catch {
    return undefined;
  }
  if (
    relative.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(relative) ||
    relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  const candidate = path.resolve(docsRoot, relative);
  if (!candidate.startsWith(`${docsRoot}${path.sep}`) || !fs.existsSync(candidate)) return undefined;
  const metadata = fs.lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024 * 1024) return undefined;
  const canonicalRoot = fs.realpathSync(docsRoot);
  const canonicalCandidate = fs.realpathSync(candidate);
  return canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`) ? canonicalCandidate : undefined;
}

async function startHostedDocsServer() {
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
      response.end();
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const file = boundedDocsFile(requestUrl.pathname);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    const bytes = fs.readFileSync(file);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(file)] ?? "application/octet-stream",
      "content-length": bytes.byteLength,
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Docs gallery browser server failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    galleryUrl: `${origin}${hostedBasePath}gallery.html`,
    async close() {
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
