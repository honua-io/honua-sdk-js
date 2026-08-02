import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OFFLINE_REFERENCE_PAYLOAD = '{"features":[{"id":"incident-1","status":"open"}]}';
const SHELL_CACHE_NAMESPACE = `honua-offline-region-reference-shell-${encodeURIComponent("/reference/")}-`;
const SHELL_CONTROL_CACHE = `${SHELL_CACHE_NAMESPACE}control-v1`;
const SHELL_GENERATION_PREFIX = `${SHELL_CACHE_NAMESPACE}generation-v1-`;
const SHELL_LEGACY_CACHE = `${SHELL_CACHE_NAMESPACE}v1`;

test("offline reference workflow reloads after browser networking is disabled", async ({ page, context }) => {
  test.slow();
  const server = await startServer();
  try {
    await page.goto(`${server.url}/reference/index.html?preview=1#offline`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "online",
      availability: "ready",
      freshness: "fresh",
      payload: OFFLINE_REFERENCE_PAYLOAD,
      attribution: "Honua deterministic incident fixture",
      sourceVersion: "source-v1",
      schemaVersion: "schema-v1",
      planVersion: "plan-v1",
    });
    expect(page.url()).toBe(`${server.url}/reference/index.html`);
    expect(server.offlineDataRequests).toBe(1);

    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "offline",
      availability: "ready",
      freshness: "stale",
      payload: OFFLINE_REFERENCE_PAYLOAD,
      attribution: "Honua deterministic incident fixture",
      sourceVersion: "source-v1",
      schemaVersion: "schema-v1",
      planVersion: "plan-v1",
    });
    expect(server.offlineDataRequests).toBe(1);

    const shell = await readShellState(page);
    expect(shell.urls.length).toBeGreaterThan(2);
    expect(shell.urls.length).toBeLessThanOrEqual(128);
    expect(shell.hasAuthorization).toBe(false);
    expect(Math.max(...shell.byteLengths)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(shell.byteLengths.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    for (const value of shell.urls) {
      const url = new URL(value);
      expect(url.origin).toBe(server.url);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.pathname.startsWith("/reference/") || url.pathname.startsWith("/dist/")).toBe(true);
      expect(value).not.toMatch(/(?:authorization|password|secret|sig|token)=/i);
    }
  } finally {
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference isolates committed shell generations by worker scope", async ({ page, context }) => {
  test.slow();
  const server = await startServer();
  let alternatePage;
  try {
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      availability: "ready",
    });
    const primary = await readShellState(page);

    alternatePage = await context.newPage();
    await alternatePage.goto(`${server.url}/reference-alt/`);
    await expect.poll(() => alternatePage.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      availability: "ready",
    });
    const alternate = await readShellState(alternatePage);
    expect(alternate.activeName).not.toBe(primary.activeName);
    expect(alternate.contentCacheNames).toEqual([alternate.activeName]);

    const primaryAfterAlternateRefresh = await readShellState(page);
    expect(primaryAfterAlternateRefresh.activeName).toBe(primary.activeName);
    expect(primaryAfterAlternateRefresh.contentCacheNames).toEqual([primary.activeName]);
    expect(primaryAfterAlternateRefresh.urls).toEqual(primary.urls);
  } finally {
    await alternatePage?.close().catch(() => undefined);
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference rejects an oversized data response before persistence", async ({ page, context }) => {
  test.slow();
  const server = await startServer();
  try {
    server.setOfflineDataOversized(true);
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: false,
      availability: "unavailable",
      error: 'Failed to load resource "incidents".',
    });

    server.setOfflineDataOversized(false);
    server.setOfflineDataCompressed(true);
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      availability: "ready",
      payload: OFFLINE_REFERENCE_PAYLOAD,
    });
    expect(server.offlineDataRequests).toBe(2);
  } finally {
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference installs its exact worker when a broader worker already controls the page", async ({
  page,
  context,
}) => {
  test.slow();
  const server = await startServer();
  try {
    await page.goto(`${server.url}/broad-worker-setup`);
    await page.evaluate(async () => {
      const scriptUrl = new URL("/broad-service-worker.mjs", window.location.href).href;
      const registration = await navigator.serviceWorker.register(scriptUrl, { scope: "/" });
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller?.scriptURL !== scriptUrl) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Broad service worker did not take control.")), 5000);
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
      }
      if (registration.active?.scriptURL !== scriptUrl) throw new Error("Broad service worker is inactive.");
    });

    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "online",
      availability: "ready",
    });
    const identity = await page.evaluate(async () => {
      const expectedScope = new URL("./", window.location.href).href;
      const expectedScript = new URL("./service-worker.mjs", expectedScope).href;
      const registrations = await navigator.serviceWorker.getRegistrations();
      const exact = registrations.find((registration) => registration.scope === expectedScope);
      return {
        scope: exact?.scope,
        activeScript: exact?.active?.scriptURL,
        controllerScript: navigator.serviceWorker.controller?.scriptURL,
        expectedScope,
        expectedScript,
      };
    });
    expect(identity).toMatchObject({
      scope: identity.expectedScope,
      activeScript: identity.expectedScript,
      controllerScript: identity.expectedScript,
    });

    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "offline",
      availability: "ready",
      payload: OFFLINE_REFERENCE_PAYLOAD,
    });

    await context.setOffline(false);
    const legacyEntries = await page.evaluate(
      async ({ controlName, generationPrefix, legacyName, origin }) => {
        await caches.delete(controlName);
        const names = await caches.keys();
        await Promise.all(names.filter((name) => name.startsWith(generationPrefix)).map((name) => caches.delete(name)));
        const legacy = await caches.open(legacyName);
        await legacy.put(`${origin}/reference/`, new Response("partial legacy shell"));
        return (await legacy.keys()).length;
      },
      {
        controlName: SHELL_CONTROL_CACHE,
        generationPrefix: SHELL_GENERATION_PREFIX,
        legacyName: SHELL_LEGACY_CACHE,
        origin: server.url,
      },
    );
    expect(legacyEntries).toBe(1);
    server.setShellUnavailable(true);
    const legacyRefresh = await requestShellRefresh(page, `${server.url}/reference/shell-manifest.v1.json`);
    expect(legacyRefresh).toEqual({ ok: false, retained: false });
  } finally {
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference workflow retains its snapshot when the origin is unreachable but the browser is online", async ({
  page,
}) => {
  test.slow();
  const server = await startServer();
  try {
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "online",
      availability: "ready",
      freshness: "fresh",
    });
    expect(server.offlineDataRequests).toBe(1);

    server.setShellUnavailable(true);
    await page.reload({ waitUntil: "load" });
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "offline",
      availability: "ready",
      freshness: "stale",
      payload: OFFLINE_REFERENCE_PAYLOAD,
    });
    expect(server.offlineDataRequests).toBe(1);
  } finally {
    await cleanupOfflineReference(page, page.context());
    await server.close();
  }
});

test("offline reference workflow bounds queued hanging shell refreshes and retains its snapshot", async ({
  page,
  context,
}) => {
  test.slow();
  const server = await startServer();
  let secondPage;
  try {
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "online",
      availability: "ready",
      freshness: "fresh",
    });
    expect(server.offlineDataRequests).toBe(1);

    secondPage = await context.newPage();
    await secondPage.goto(`${server.url}/reference/`);
    await expect.poll(() => secondPage.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "online",
      availability: "ready",
      freshness: "fresh",
    });

    server.setShellHanging(true);
    await Promise.all([page.reload({ waitUntil: "load" }), secondPage.reload({ waitUntil: "load" })]);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    const retainedSnapshot = {
      ready: true,
      shellReady: true,
      mode: "offline",
      availability: "ready",
      freshness: "stale",
      payload: OFFLINE_REFERENCE_PAYLOAD,
    };
    await Promise.all([
      expect
        .poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__), { timeout: 7000 })
        .toMatchObject(retainedSnapshot),
      expect
        .poll(() => secondPage.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__), { timeout: 7000 })
        .toMatchObject(retainedSnapshot),
    ]);
    expect(server.offlineDataRequests).toBe(1);
  } finally {
    server.setShellHanging(false);
    await secondPage?.close().catch(() => undefined);
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference shell replaces complete generations and retains the committed one on failure", async ({
  page,
  context,
}) => {
  test.slow();
  const server = await startServer();
  try {
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      availability: "ready",
    });
    const before = await readShellState(page);
    expect(before.contentCacheNames).toEqual([before.activeName]);

    const mixedManifestPath = "/reference/test-shell-manifest-mixed.json";
    const mismatchedResources = before.resources.map((resource) =>
      resource.url.endsWith("/reference/app.mjs")
        ? { ...resource, integrity: `sha256:${"0".repeat(64)}` }
        : resource,
    );
    server.setShellManifest(mixedManifestPath, {
      deploymentId: "test-mixed",
      resources: mismatchedResources,
    });
    const mixedRefresh = await requestShellRefresh(page, `${server.url}${mixedManifestPath}`);
    expect(mixedRefresh).toEqual({ ok: false, retained: true });
    const afterMixed = await readShellState(page);
    expect(afterMixed.activeName).toBe(before.activeName);
    expect(afterMixed.urls).toEqual(before.urls);
    expect(afterMixed.contentCacheNames).toEqual([before.activeName]);

    const oversizedManifestRefresh = await requestShellRefresh(
      page,
      `${server.url}/reference/test-shell-manifest-oversized.json`,
    );
    expect(oversizedManifestRefresh).toEqual({ ok: false, retained: true });
    const afterOversizedManifest = await readShellState(page);
    expect(afterOversizedManifest.activeName).toBe(before.activeName);
    expect(afterOversizedManifest.urls).toEqual(before.urls);
    expect(afterOversizedManifest.contentCacheNames).toEqual([before.activeName]);

    const okResource = shellResource(
      `${server.url}/reference/shell-upgrade-ok.mjs`,
      "export const shellUpgradeFixture = true;",
    );
    server.setShellResourceCompressed("/reference/shell-upgrade-ok.mjs", true);
    const failedManifestPath = "/reference/test-shell-manifest-failure.json";
    server.setShellManifest(failedManifestPath, {
      deploymentId: "test-failure",
      resources: [
        ...before.resources,
        okResource,
        shellResource(`${server.url}/reference/shell-upgrade-fail.mjs`, "upgrade failed"),
      ],
    });
    const failedRefresh = await requestShellRefresh(page, `${server.url}${failedManifestPath}`);
    expect(failedRefresh).toEqual({ ok: false, retained: true });
    const afterFailure = await readShellState(page);
    expect(afterFailure.activeName).toBe(before.activeName);
    expect(afterFailure.urls).toEqual(before.urls);
    expect(afterFailure.contentCacheNames).toEqual([before.activeName]);

    const oversizedManifestPath = "/reference/test-shell-manifest-oversized.json";
    server.setShellManifest(oversizedManifestPath, {
      deploymentId: "test-oversized",
      resources: [
        ...before.resources,
        shellResource(`${server.url}/reference/shell-upgrade-large.mjs`, "declared-small"),
      ],
    });
    const oversizedRefresh = await requestShellRefresh(page, `${server.url}${oversizedManifestPath}`);
    expect(oversizedRefresh).toEqual({ ok: false, retained: true });
    const afterOversized = await readShellState(page);
    expect(afterOversized.activeName).toBe(before.activeName);
    expect(afterOversized.urls).toEqual(before.urls);
    expect(afterOversized.contentCacheNames).toEqual([before.activeName]);

    const accumulated = await page.evaluate(
      async ({ activeName, origin }) => {
        const cache = await caches.open(activeName);
        for (let index = 0; index < 130; index += 1) {
          await cache.put(`${origin}/reference/obsolete-entry-${index}.mjs`, new Response("x"));
        }
        return (await cache.keys()).length;
      },
      { activeName: before.activeName, origin: server.url },
    );
    expect(accumulated).toBeGreaterThan(128);

    const replacementManifestPath = "/reference/test-shell-manifest-replacement.json";
    const replacementResources = [...before.resources, okResource].sort((left, right) =>
      left.url.localeCompare(right.url),
    );
    server.setShellManifest(replacementManifestPath, {
      deploymentId: "test-replacement",
      resources: replacementResources,
    });
    const replacementUrls = replacementResources.map((resource) => resource.url);
    const successfulRefresh = await requestShellRefresh(page, `${server.url}${replacementManifestPath}`);
    expect(successfulRefresh).toMatchObject({
      ok: true,
      count: replacementUrls.length,
      deploymentId: "test-replacement",
    });
    const afterSuccess = await readShellState(page);
    expect(afterSuccess.activeName).not.toBe(before.activeName);
    expect(afterSuccess.contentCacheNames).toEqual([afterSuccess.activeName]);
    expect(afterSuccess.urls).toEqual(replacementUrls);
    expect(afterSuccess.urls.some((url) => url.includes("obsolete-"))).toBe(false);
    expect(afterSuccess.byteLengths.length).toBeLessThanOrEqual(128);
    expect(Math.max(...afterSuccess.byteLengths)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(afterSuccess.byteLengths.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );

    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "offline",
      availability: "ready",
      payload: OFFLINE_REFERENCE_PAYLOAD,
    });
  } finally {
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference serializes shell replacement across worker versions", async ({ page, context }) => {
  test.slow();
  const server = await startServer();
  const heldPath = "/reference/shell-upgrade-held-old.mjs";
  try {
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      availability: "ready",
    });
    const before = await readShellState(page);

    const heldSource = "export const heldOldWorkerGeneration = true;";
    const oldManifestPath = "/reference/test-shell-manifest-old-worker.json";
    server.holdShellResource(heldPath, heldSource);
    server.setShellManifest(oldManifestPath, {
      deploymentId: "test-old-worker",
      resources: [...before.resources, shellResource(`${server.url}${heldPath}`, heldSource)],
    });
    const oldRefresh = requestShellRefresh(page, `${server.url}${oldManifestPath}`).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    }));
    await server.waitForHeldShellResource(heldPath);

    await page.evaluate(async () => {
      const scope = new URL("./", window.location.href).href;
      const scriptUrl = new URL("./service-worker-v2.mjs", window.location.href).href;
      const registration = await navigator.serviceWorker.register(scriptUrl, { scope });
      const deadline = Date.now() + 5000;
      while (registration.active?.scriptURL !== scriptUrl) {
        if (Date.now() >= deadline) throw new Error("Replacement service worker did not activate.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    const newManifestPath = "/reference/test-shell-manifest-new-worker.json";
    const newSource = "export const newWorkerGeneration = true;";
    const newResource = shellResource(`${server.url}/reference/shell-upgrade-new-worker.mjs`, newSource);
    const newResources = [...before.resources, newResource].sort((left, right) => left.url.localeCompare(right.url));
    server.setShellManifest(newManifestPath, {
      deploymentId: "test-new-worker",
      resources: newResources,
    });
    const newRefresh = requestShellRefresh(page, `${server.url}${newManifestPath}`);
    await page.waitForTimeout(250);

    server.releaseHeldShellResource(heldPath);
    await oldRefresh;
    await expect(newRefresh).resolves.toMatchObject({ ok: true, deploymentId: "test-new-worker" });
    expect(server.shellManifestRequests(newManifestPath)).toBe(1);
    const after = await readShellState(page);
    expect(after.contentCacheNames).toEqual([after.activeName]);
    expect(after.activeName).toContain("test-new-worker");
    expect(after.urls).toEqual(newResources.map((resource) => resource.url));

    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "offline",
      availability: "ready",
      payload: OFFLINE_REFERENCE_PAYLOAD,
    });
  } finally {
    server.releaseHeldShellResource(heldPath);
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference serves its committed shell while a refresh digest stalls", async ({ page, context }) => {
  test.slow();
  const server = await startServer();
  const heldPath = "/reference/shell-upgrade-digest-stall.mjs";
  let refreshPage;
  try {
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      availability: "ready",
    });
    refreshPage = await context.newPage();
    await refreshPage.goto(`${server.url}/reference/`);
    await expect.poll(() => refreshPage.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      availability: "ready",
    });
    const before = await readShellState(page);

    server.setReferenceWorkerDigestHanging(true);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("./");
      const previous = navigator.serviceWorker.controller;
      if (!registration || !previous) throw new Error("Reference worker is not controlling the page.");
      await registration.update();
      const deadline = Date.now() + 5000;
      while (navigator.serviceWorker.controller === previous) {
        if (Date.now() >= deadline) throw new Error("Digest-stalling replacement worker did not take control.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    server.holdShellResource(heldPath, "x");
    const manifestPath = "/reference/test-shell-manifest-digest-stall.json";
    server.setShellManifest(manifestPath, {
      deploymentId: "test-digest-stall",
      resources: [shellResource(`${server.url}${heldPath}`, "x")],
    });
    const refresh = requestShellRefresh(refreshPage, `${server.url}${manifestPath}`);
    await server.waitForHeldShellResource(heldPath);
    server.releaseHeldShellResource(heldPath);
    await refreshPage.waitForTimeout(100);

    await context.setOffline(true);
    await page.reload({ timeout: 7000, waitUntil: "load" });
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__), { timeout: 7000 }).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "offline",
      availability: "ready",
      payload: OFFLINE_REFERENCE_PAYLOAD,
    });
    await expect(refresh).resolves.toEqual({ ok: false, retained: true });
    const after = await readShellState(page);
    expect(after.activeName).toBe(before.activeName);
    expect(after.urls).toEqual(before.urls);
  } finally {
    server.releaseHeldShellResource(heldPath);
    await refreshPage?.close().catch(() => undefined);
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference retains its committed shell when an updated worker does not reply", async ({ page, context }) => {
  test.slow();
  const server = await startServer();
  try {
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "online",
      availability: "ready",
    });

    server.setReferenceWorkerMessagesMuted(true);
    await page.addInitScript((generationPrefix) => {
      const requestLock = navigator.locks.request.bind(navigator.locks);
      navigator.locks.request = (...args) => {
        const [name, options] = args;
        if (name.startsWith(generationPrefix) && name.endsWith("-read-v1") && options?.mode === "shared") {
          window.__HONUA_PAGE_SHELL_LOCK_REQUESTS__ = (window.__HONUA_PAGE_SHELL_LOCK_REQUESTS__ ?? 0) + 1;
        }
        return requestLock(...args);
      };
    }, SHELL_GENERATION_PREFIX);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("./");
      const previous = navigator.serviceWorker.controller;
      if (!registration || !previous) throw new Error("Reference worker is not controlling the page.");
      await registration.update();
      const deadline = Date.now() + 5000;
      while (navigator.serviceWorker.controller === previous) {
        if (Date.now() >= deadline) throw new Error("Muted replacement worker did not take control.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    await page.reload({ waitUntil: "load" });
    await expect
      .poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__), { timeout: 7000 })
      .toMatchObject({
        ready: true,
        shellReady: true,
        mode: "offline",
        availability: "ready",
        freshness: "stale",
        payload: OFFLINE_REFERENCE_PAYLOAD,
      });
    await expect.poll(() => page.evaluate(() => window.__HONUA_PAGE_SHELL_LOCK_REQUESTS__)).toBe(1);
  } finally {
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("offline reference workflow fails visibly when its persisted region is missing", async ({ page, context }) => {
  test.slow();
  const server = await startServer();
  try {
    await page.goto(`${server.url}/reference/`);
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "online",
      availability: "ready",
    });
    expect(server.offlineDataRequests).toBe(1);
    const removed = await page.evaluate(async () => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name: "honua-offline-region-reference-v1" });
      const inventory = await store.inventory();
      return inventory.regions[0] ? store.removeRegion(inventory.regions[0].id) : false;
    });
    expect(removed).toBe(true);

    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => page.evaluate(() => window.__HONUA_OFFLINE_REFERENCE__)).toMatchObject({
      ready: true,
      shellReady: true,
      mode: "offline",
      availability: "unavailable",
      error: "Persisted region is unavailable (cache-miss).",
    });
    expect(server.offlineDataRequests).toBe(1);
    await expect(page.locator("main")).toHaveAttribute("data-state", "unavailable");
    await expect(page.getByRole("alert")).toContainText("cache-miss");
  } finally {
    await cleanupOfflineReference(page, context);
    await server.close();
  }
});

test("IndexedDB offline region store survives reload and preserves inventory CAS", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    await expect.poll(() => page.evaluate(() => window.__offlineResult)).toEqual({
      receipt: "committed",
      revision: "present",
      regionCount: 1,
    });

    await page.reload();
    await page.context().setOffline(true);
    await page.waitForTimeout(10);
    await expect.poll(() => page.evaluate(() => window.__offlineResult)).toEqual({
      revision: "present",
      regionCount: 1,
      logicalByteLength: 3,
      resource: "one",
      sourceVersion: "1",
      lastAccessedChanged: true,
      intercepted: "one",
      contentType: null,
      sourceHeader: "1",
      headBody: "",
      miss: true,
    });
  } finally {
    await server.close();
  }
});

test("IndexedDB edit queue survives reload and atomically leases dependency-ready work", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    await expect.poll(() => page.evaluate(() => window.__offlineDatabase)).toEqual(expect.any(String));
    const expected = await page.evaluate(async () => {
      const { createIndexedDbOfflineEditQueue } = await import("/dist/src/offline/index.js");
      const name = `${window.__offlineDatabase}-edits`;
      const queue = createIndexedDbOfflineEditQueue({
        name,
        now: () => new Date("2026-08-01T10:00:00.000Z"),
        createLeaseToken: () => "setup-lease",
      });
      const authorizationScopeDigest = `sha256:${"a".repeat(64)}`;
      const first = await queue.enqueue({
        authorizationScopeDigest,
        sourceId: "incidents",
        idempotencyKey: "browser-first",
        edit: { operation: "add", attributes: { status: "open" } },
      });
      const dependent = await queue.enqueue({
        authorizationScopeDigest,
        sourceId: "incidents",
        idempotencyKey: "browser-dependent",
        edit: { operation: "update", featureId: "incident-1", attributes: { status: "assigned" } },
        dependencyIds: [first.edit.id],
      });
      const other = await queue.enqueue({
        authorizationScopeDigest: `sha256:${"b".repeat(64)}`,
        sourceId: "incidents",
        idempotencyKey: "browser-other-partition",
        edit: { operation: "add", attributes: { status: "private" } },
      });
      const value = { name, firstId: first.edit.id, dependentId: dependent.edit.id, otherId: other.edit.id };
      sessionStorage.setItem("offline-edit-queue-fixture", JSON.stringify(value));
      return value;
    });

    await page.reload();
    const result = await page.evaluate(async () => {
      const { createIndexedDbOfflineEditQueue } = await import("/dist/src/offline/index.js");
      const fixture = JSON.parse(sessionStorage.getItem("offline-edit-queue-fixture"));
      const options = {
        name: fixture.name,
        now: () => new Date("2026-08-01T10:00:01.000Z"),
      };
      const partition = {
        authorizationScopeDigest: `sha256:${"a".repeat(64)}`,
        sourceId: "incidents",
      };
      const queueA = createIndexedDbOfflineEditQueue({ ...options, createLeaseToken: () => "lease-a" });
      const queueB = createIndexedDbOfflineEditQueue({ ...options, createLeaseToken: () => "lease-b" });
      const before = await queueA.list(partition);
      const claims = await Promise.all([
        queueA.claimReady({ ...partition, workerId: "worker-a", limit: 10, leaseDurationMs: 60_000 }),
        queueB.claimReady({ ...partition, workerId: "worker-b", limit: 10, leaseDurationMs: 60_000 }),
      ]);
      const claimed = claims.flat();
      await queueA.markApplied(claimed[0].id, claimed[0].lease.token, {
        serverOperationId: "operation-browser-1",
      });
      const next = await queueB.claimReady({
        ...partition,
        workerId: "worker-b",
        limit: 10,
        leaseDurationMs: 60_000,
      });
      const after = await queueA.list(partition);
      await queueA.markApplied(next[0].id, next[0].lease.token, {
        serverOperationId: "operation-browser-2",
      });
      const pruned = await queueA.pruneTerminal({
        ...partition,
        terminalBefore: "2026-08-01T10:00:01.000Z",
        limit: 1,
      });
      const prunedIdentity =
        pruned[0] === fixture.firstId
          ? {
              idempotencyKey: "browser-first",
              edit: { operation: "add", attributes: { status: "open" } },
            }
          : {
              idempotencyKey: "browser-dependent",
              edit: {
                operation: "update",
                featureId: "incident-1",
                attributes: { status: "assigned" },
              },
              dependencyIds: [fixture.firstId],
            };
      let prunedReuseCode;
      try {
        await queueA.enqueue({
          ...partition,
          ...prunedIdentity,
        });
      } catch (error) {
        prunedReuseCode = error.code;
      }
      let prunedDivergentCode;
      try {
        await queueA.enqueue({
          ...partition,
          ...prunedIdentity,
          edit: { ...prunedIdentity.edit, attributes: { status: "divergent" } },
        });
      } catch (error) {
        prunedDivergentCode = error.code;
      }
      const postPrune = await queueA.enqueue({
        ...partition,
        idempotencyKey: "browser-post-prune-dependent",
        edit: { operation: "update", featureId: "incident-3", attributes: { status: "open" } },
        dependencyIds: [pruned[0]],
      });
      const [postPruneLease] = await queueA.claimReady({
        ...partition,
        workerId: "worker-a",
        limit: 1,
        leaseDurationMs: 60_000,
      });
      await queueA.markApplied(postPrune.edit.id, postPruneLease.lease.token, {
        serverOperationId: "operation-post-prune",
      });
      const conflictRoot = await queueA.enqueue({
        ...partition,
        idempotencyKey: "browser-conflict-root",
        edit: { operation: "add", attributes: { status: "conflicted" } },
      });
      const blocked = await queueA.enqueue({
        ...partition,
        idempotencyKey: "browser-blocked-dependent",
        edit: { operation: "update", featureId: "incident-2", attributes: { status: "closed" } },
        dependencyIds: [conflictRoot.edit.id],
      });
      const [conflictLease] = await queueA.claimReady({
        ...partition,
        workerId: "worker-a",
        limit: 1,
        leaseDurationMs: 60_000,
      });
      await queueA.markConflicted(conflictRoot.edit.id, conflictLease.lease.token, {
        conflictId: "browser-conflict",
      });
      let liveFailedDependencyCode;
      try {
        await queueA.enqueue({
          ...partition,
          idempotencyKey: "browser-already-failed-dependent",
          edit: { operation: "add", attributes: { status: "blocked" } },
          dependencyIds: [conflictRoot.edit.id],
        });
      } catch (error) {
        liveFailedDependencyCode = error.code;
      }
      const blockedClaims = await queueA.claimReady({
        ...partition,
        workerId: "worker-a",
        limit: 10,
        leaseDurationMs: 60_000,
      });
      const cancelled = await queueA.cancel(blocked.edit.id, partition, {
        reasonCode: "dependency-conflicted",
      });
      const other = await queueB.get(fixture.otherId, {
        authorizationScopeDigest: `sha256:${"b".repeat(64)}`,
        sourceId: "incidents",
      });
      const metadataKeys = await new Promise((resolve, reject) => {
        const open = indexedDB.open(fixture.name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const getAll = database.transaction("edit-metadata", "readonly").objectStore("edit-metadata").getAll();
          getAll.onerror = () => reject(getAll.error);
          getAll.onsuccess = () => {
            database.close();
            resolve([...new Set(getAll.result.flatMap((record) => Object.keys(record)))].sort());
          };
        };
      });
      const tombstoneKeys = await new Promise((resolve, reject) => {
        const open = indexedDB.open(fixture.name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const getAll = database.transaction("edit-tombstones", "readonly").objectStore("edit-tombstones").getAll();
          getAll.onerror = () => reject(getAll.error);
          getAll.onsuccess = () => {
            database.close();
            resolve([...new Set(getAll.result.flatMap((record) => Object.keys(record)))].sort());
          };
        };
      });
      const remaining = (await queueA.list(partition)).length;
      const upgradedVersion = await new Promise((resolve, reject) => {
        const open = indexedDB.open(fixture.name, 3);
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error("IndexedDB version upgrade was blocked."));
        open.onsuccess = () => {
          resolve(open.result.version);
          open.result.close();
        };
      });
      return {
        before: before.map((edit) => ({ id: edit.id, state: edit.state })),
        claimed: claimed.map((edit) => edit.id),
        claimCounts: claims.map((edits) => edits.length),
        next: next.map((edit) => edit.id),
        after: after.map((edit) => ({ id: edit.id, state: edit.state })),
        pruned: pruned.length,
        prunedReuseCode,
        prunedDivergentCode,
        prunedDependencyClaimed: postPruneLease.id === postPrune.edit.id,
        remaining,
        upgradedVersion,
        liveFailedDependencyCode,
        blockedClaimCount: blockedClaims.length,
        cancelledState: cancelled.state,
        otherState: other?.state,
        metadataKeys,
        tombstoneKeys,
      };
    });

    expect(result.before).toHaveLength(2);
    expect(result.before).toEqual(
      expect.arrayContaining([
        { id: expected.firstId, state: "pending" },
        { id: expected.dependentId, state: "pending" },
      ]),
    );
    expect(result.claimed).toEqual([expected.firstId]);
    expect(result.claimCounts.reduce((total, count) => total + count, 0)).toBe(1);
    expect(result.next).toEqual([expected.dependentId]);
    expect(result.after).toHaveLength(2);
    expect(result.after).toEqual(
      expect.arrayContaining([
        { id: expected.firstId, state: "applied" },
        { id: expected.dependentId, state: "leased" },
      ]),
    );
    expect(result).toMatchObject({
      pruned: 1,
      prunedReuseCode: "edit-pruned",
      prunedDivergentCode: "idempotency-conflict",
      prunedDependencyClaimed: true,
      remaining: 4,
      upgradedVersion: 3,
      liveFailedDependencyCode: "invalid-edit",
      blockedClaimCount: 0,
      cancelledState: "cancelled",
      otherState: "pending",
    });
    expect(result.metadataKeys).not.toEqual(expect.arrayContaining(["edit", "audit", "idempotencyKey", "lease"]));
    expect(result.tombstoneKeys).not.toEqual(
      expect.arrayContaining(["edit", "audit", "idempotencyKey", "lease", "conflict", "cancellation"]),
    );
  } finally {
    await server.close();
  }
});

test("offline fetch uses resource provenance and omits invalid header values", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    const result = await page.evaluate(async () => {
      const { createOfflineRegionFetchHandler } = await import("/dist/src/offline/index.js");
      const read = {
        regionId: "region",
        manifest: {
          expiresAt: undefined,
          source: {
            observation: { state: "live", observedAt: "2026-07-29T00:00:00Z" },
            sourceVersion: "manifest-source",
            schemaVersion: "manifest-schema",
            planVersion: "manifest-plan",
          },
        },
        resource: {
          sourceVersion: "resource-source",
          schemaVersion: `resource-schema-${String.fromCharCode(1)}`,
          planVersion: "resource-plan",
          contentType: undefined,
        },
        bytes: new Uint8Array([111, 110, 101]),
      };
      const handler = createOfflineRegionFetchHandler({
        store: { readResource: async () => read },
        regionId: "region",
        match: () => "resource",
      });
      const response = await handler(new Request("https://example.test/resource"));
      return {
        source: response?.headers.get("x-honua-offline-source-version"),
        schema: response?.headers.get("x-honua-offline-schema-version"),
        plan: response?.headers.get("x-honua-offline-plan-version"),
      };
    });
    expect(result).toEqual({ source: "resource-source", schema: null, plan: "resource-plan" });
  } finally {
    await server.close();
  }
});

test("IndexedDB store reclaims abandoned staging records and touches LRU reads", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    const database = await page.evaluate(() => window.__offlineDatabase);
    await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name });
      const transaction = await store.beginWrite("abandoned");
      await transaction.write({ id: "resource", byteLength: 3 }, new Uint8Array([1, 2, 3]));
    }, database);
    await page.waitForTimeout(10);
    const stagingCount = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name, stagingMaxAgeMs: 0 });
      await store.inventory();
      return await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const count = request.result.transaction("staging", "readonly").objectStore("staging").count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        };
      });
    }, database);
    expect(stagingCount).toBe(0);
  } finally {
    await server.close();
  }
});

test("IndexedDB startup recovery removes corrupt records while preserving valid regions", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    await expect.poll(() => page.evaluate(() => window.__offlineResult)).toMatchObject({ regionCount: 1 });
    const database = await page.evaluate(() => window.__offlineDatabase);
    await page.evaluate(async (name) => {
      const request = indexedDB.open(name);
      await new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      }).then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(["regions", "resources", "staging"], "readwrite");
        transaction.objectStore("regions").put({ id: "broken", manifest: { resources: [] }, logicalByteLength: "bad" });
        transaction.objectStore("resources").put({ key: "orphan\\u0000resource", regionId: "missing", resourceId: "resource", bytes: new Uint8Array([1]) });
        transaction.objectStore("staging").put({ key: "broken-stage", transactionId: "tx", regionId: "missing", resourceId: "resource", bytes: "bad", createdAt: "bad" });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      }));
    }, database);

    const recovered = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name });
      const inventory = await store.inventory();
      const counts = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(["resources", "staging"], "readonly");
          const resources = transaction.objectStore("resources").count();
          const staging = transaction.objectStore("staging").count();
          let resourceCount;
          let stagingCount;
          resources.onsuccess = () => { resourceCount = resources.result; if (stagingCount !== undefined) resolve({ resourceCount, stagingCount }); };
          staging.onsuccess = () => { stagingCount = staging.result; if (resourceCount !== undefined) resolve({ resourceCount, stagingCount }); };
          transaction.onerror = () => reject(transaction.error);
        };
      });
      return { regionCount: inventory.regions.length, counts };
    }, database);
    expect(recovered).toEqual({ regionCount: 1, counts: { resourceCount: 1, stagingCount: 0 } });
  } finally {
    await server.close();
  }
});

test("IndexedDB schema upgrade backfills legacy staging timestamps", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    const legacyDatabase = `${await page.evaluate(() => window.__offlineDatabase)}-legacy`;
    await page.evaluate(async (name) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("inventory", { keyPath: "key" });
        db.createObjectStore("regions", { keyPath: "id" });
        const resources = db.createObjectStore("resources", { keyPath: "key" });
        resources.createIndex("regionId", "regionId");
        const staging = db.createObjectStore("staging", { keyPath: "key" });
        staging.createIndex("transactionId", "transactionId");
      };
      const db = await new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("staging", "readwrite");
        transaction.objectStore("staging").put({ key: "legacy-stage", transactionId: "tx", regionId: "region", resourceId: "resource", bytes: new Uint8Array([1, 2, 3]) });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    }, legacyDatabase);
    const createdAt = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name, stagingMaxAgeMs: 24 * 60 * 60 * 1000 });
      await store.inventory();
      return await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction("staging", "readonly");
          const get = transaction.objectStore("staging").get("legacy-stage");
          get.onsuccess = () => resolve(get.result?.createdAt);
          get.onerror = () => reject(get.error);
        };
      });
    }, legacyDatabase);
    expect(createdAt).toEqual(expect.any(Number));
  } finally {
    await server.close();
  }
});

test("IndexedDB store supports atomic pinning, expiry pruning, and removal", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(`${server.url}?mode=empty`);
    const database = await page.evaluate(() => window.__offlineDatabase);
    const result = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore, createOfflineRegionManifest, downloadOfflineRegion } =
        await import("/dist/src/offline/index.js");
      const bytes = new TextEncoder().encode("one");
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const integrity = "sha256:" + [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const manifest = await createOfflineRegionManifest({
        name: "pinning fixture",
        sourceId: "fixture",
        endpoint: "https://example.test/features",
        authorizationScopeFingerprint: "test-scope",
        bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, crs: "EPSG:4326" },
        sourceVersion: "1",
        schemaVersion: "1",
        planVersion: "1",
        observation: { state: "live", observedAt: "2026-07-29T00:00:00Z" },
        resources: [{ id: "metadata", kind: "metadata", byteLength: bytes.byteLength, integrity }],
      });
      const store = createIndexedDbOfflineRegionStore({ name });
      await downloadOfflineRegion(manifest, {
        store,
        logicalQuotaBytes: bytes.byteLength,
        load: async () => bytes,
      });
      const before = await store.inventory();
      const regionId = before.regions[0].id;
      const pinned = await store.setRegionPinned(regionId, true);
      const unchanged = await store.setRegionPinned(regionId, true);
      const afterPin = await store.inventory();
      const pruned = await store.pruneExpired(new Date("2026-07-29T00:00:00Z"));
      const removed = await store.removeRegion(regionId);
      const absent = await store.removeRegion(regionId);
      return { pinned, unchanged, storedPinned: afterPin.regions[0]?.pinned, pruned, removed, absent, finalCount: (await store.inventory()).regions.length };
    }, database);
    expect(result).toEqual({ pinned: true, unchanged: false, storedPinned: true, pruned: [], removed: true, absent: false, finalCount: 0 });
  } finally {
    await server.close();
  }
});

test("IndexedDB download resumes from verified staged resources", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    const database = await page.evaluate(() => window.__offlineDatabase);
    const result = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore, createOfflineRegionManifest, downloadOfflineRegion } =
        await import("/dist/src/offline/index.js");
      const digest = async (value) => {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
        return "sha256:" + [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      const manifest = await createOfflineRegionManifest({
        name: "resume fixture",
        sourceId: "fixture",
        endpoint: "https://example.test/features",
        authorizationScopeFingerprint: "test-scope",
        bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, crs: "EPSG:4326" },
        sourceVersion: "1",
        schemaVersion: "1",
        planVersion: "1",
        observation: { state: "live", observedAt: "2026-07-29T00:00:00Z" },
        resources: [
          { id: "first", kind: "metadata", byteLength: 3, integrity: await digest("one") },
          { id: "second", kind: "metadata", byteLength: 3, integrity: await digest("two") },
        ],
      });
      const firstStore = createIndexedDbOfflineRegionStore({ name });
      let firstLoads = 0;
      await downloadOfflineRegion(manifest, {
        store: firstStore,
        logicalQuotaBytes: 6,
        load: async (resource) => {
          firstLoads += 1;
          if (resource.id === "second") throw new Error("simulated interruption");
          return new TextEncoder().encode("one");
        },
      }).catch(() => undefined);
      const secondStore = createIndexedDbOfflineRegionStore({ name });
      const loaded = [];
      const receipt = await downloadOfflineRegion(manifest, {
        store: secondStore,
        logicalQuotaBytes: 6,
        load: async (resource) => {
          loaded.push(resource.id);
          return new TextEncoder().encode(resource.id === "first" ? "one" : "two");
        },
      });
      return { firstLoads, loaded, receipt: receipt.integrity, regionCount: (await secondStore.inventory()).regions.length };
    }, database);
    expect(result).toEqual({ firstLoads: 2, loaded: ["second"], receipt: "verified", regionCount: 1 });
  } finally {
    await server.close();
  }
});

async function startServer() {
  const fixture = { database: `honua-offline-test-${Date.now()}-${Math.random().toString(16).slice(2)}` };
  let offlineDataRequests = 0;
  let offlineDataOversized = false;
  let offlineDataCompressed = false;
  let shellHanging = false;
  const compressedShellResources = new Set();
  const heldShellResources = new Map();
  let referenceWorkerDigestHanging = false;
  let referenceWorkerMessagesMuted = false;
  const shellManifests = new Map();
  const shellManifestRequestCounts = new Map();
  let shellUnavailable = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/offline-data.json") {
      offlineDataRequests += 1;
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      const payload = offlineDataOversized ? Buffer.alloc(1024 * 1024, 32) : OFFLINE_REFERENCE_PAYLOAD;
      if (offlineDataCompressed) {
        response.setHeader("content-encoding", "gzip");
        response.end(gzipSync(payload));
      } else {
        response.end(payload);
      }
      return;
    }
    if (shellHanging && (url.pathname.startsWith("/reference/") || url.pathname.startsWith("/dist/"))) return;
    if (shellUnavailable && (url.pathname.startsWith("/reference/") || url.pathname.startsWith("/dist/"))) {
      response.statusCode = 503;
      response.end("shell unavailable");
      return;
    }
    if (url.pathname === "/reference/shell-upgrade-fail.mjs") {
      response.statusCode = 503;
      response.end("upgrade failed");
      return;
    }
    if (url.pathname === "/reference/shell-upgrade-ok.mjs") {
      response.setHeader("content-type", "application/javascript; charset=utf-8");
      const payload = "export const shellUpgradeFixture = true;";
      if (compressedShellResources.has(url.pathname)) {
        response.setHeader("content-encoding", "gzip");
        response.end(gzipSync(payload));
      } else {
        response.end(payload);
      }
      return;
    }
    if (url.pathname === "/reference/shell-upgrade-new-worker.mjs") {
      response.setHeader("content-type", "application/javascript; charset=utf-8");
      response.end("export const newWorkerGeneration = true;");
      return;
    }
    if (url.pathname === "/reference/shell-upgrade-large.mjs") {
      response.setHeader("content-type", "application/javascript; charset=utf-8");
      response.end(Buffer.alloc(4 * 1024 * 1024 + 1, 32));
      return;
    }
    if (url.pathname === "/reference/test-shell-manifest-oversized.json") {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(Buffer.alloc(64 * 1024 + 1, 32));
      return;
    }
    const heldShellResource = heldShellResources.get(url.pathname);
    if (heldShellResource) {
      heldShellResource.markRequested();
      await heldShellResource.released;
      response.setHeader("content-type", "application/javascript; charset=utf-8");
      response.end(heldShellResource.content);
      return;
    }
    const shellManifest = shellManifests.get(url.pathname);
    if (shellManifest) {
      shellManifestRequestCounts.set(url.pathname, (shellManifestRequestCounts.get(url.pathname) ?? 0) + 1);
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(shellManifest));
      return;
    }
    const referenceFiles = new Map([
      ["/reference/", "index.html"],
      ["/reference/index.html", "index.html"],
      ["/reference/app.mjs", "app.mjs"],
      ["/reference/shell-manifest.v1.json", "shell-manifest.v1.json"],
      ["/reference/service-worker.mjs", "service-worker.mjs"],
      ["/reference/service-worker-v2.mjs", "service-worker.mjs"],
      ["/reference-alt/", "index.html"],
      ["/reference-alt/index.html", "index.html"],
      ["/reference-alt/app.mjs", "app.mjs"],
      ["/reference-alt/shell-manifest.v1.json", "shell-manifest.v1.json"],
      ["/reference-alt/service-worker.mjs", "service-worker.mjs"],
    ]);
    const referenceFile = referenceFiles.get(url.pathname);
    if (referenceFile) {
      const file = await readFile(path.join(repoRoot, "docs/examples/offline-region-reference", referenceFile));
      response.setHeader(
        "content-type",
        referenceFile.endsWith(".html")
          ? "text/html; charset=utf-8"
          : referenceFile.endsWith(".json")
            ? "application/json; charset=utf-8"
            : "application/javascript; charset=utf-8",
      );
      if (referenceFile === "service-worker.mjs" || referenceFile === "shell-manifest.v1.json") {
        response.setHeader("cache-control", "no-store");
      }
      let responseFile = file;
      if (url.pathname.endsWith("service-worker-v2.mjs")) {
        responseFile = Buffer.concat([file, Buffer.from("\n// replacement worker version\n")]);
      } else if (url.pathname.endsWith("service-worker.mjs") && referenceWorkerDigestHanging) {
        responseFile = Buffer.from(
          file
            .toString("utf8")
            .replace(
              'const digest = await crypto.subtle.digest("SHA-256", bytes);',
              "const digest = await new Promise(() => {});",
            ),
        );
      } else if (url.pathname.endsWith("service-worker.mjs") && referenceWorkerMessagesMuted) {
        responseFile = Buffer.from(file.toString("utf8").replaceAll("HONUA_PRECACHE_V2", "HONUA_PRECACHE_DISABLED"));
      }
      response.end(responseFile);
      return;
    }
    if (url.pathname === "/broad-worker-setup") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Broad worker setup</title>");
      return;
    }
    if (url.pathname === "/broad-service-worker.mjs") {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/javascript; charset=utf-8");
      response.end(
        'self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting())); self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));',
      );
      return;
    }
    if (url.pathname === "/fixture.json") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(fixture));
      return;
    }
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><script type="module">
        import {
          createIndexedDbOfflineRegionStore,
          createOfflineRegionManifest,
          createOfflineRegionFetchHandler,
          downloadOfflineRegion,
        } from "/dist/src/offline/index.js";
        const digest = async (value) => {
          const bytes = new TextEncoder().encode(value);
          const hash = await crypto.subtle.digest("SHA-256", bytes);
          return "sha256:" + [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        };
        const run = async () => {
          const fixture = await fetch("/fixture.json").then((response) => response.json());
          const database = fixture.database;
          window.__offlineDatabase = database;
          const mode = new URL(location.href).searchParams.get("mode") ?? sessionStorage.getItem("offline-test-mode") ?? "write";
          const store = createIndexedDbOfflineRegionStore({ name: database });
          if (mode === "write") {
            const manifest = await createOfflineRegionManifest({
              name: "reload fixture",
              sourceId: "fixture",
              endpoint: "https://example.test/features",
              authorizationScopeFingerprint: "test-scope",
              bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, crs: "EPSG:4326" },
              sourceVersion: "1",
              schemaVersion: "1",
              planVersion: "1",
              observation: { state: "live", observedAt: "2026-07-29T00:00:00Z" },
              resources: [{ id: "metadata", kind: "metadata", byteLength: 3, integrity: await digest("one") }],
            });
            const receipt = await downloadOfflineRegion(manifest, {
              store,
              logicalQuotaBytes: 3,
              load: async () => new TextEncoder().encode("one"),
            });
            const inventory = await store.inventory();
            window.__offlineResult = { receipt: receipt.integrity === "verified" ? "committed" : "invalid", revision: inventory.revision === "0" ? "zero" : "present", regionCount: inventory.regions.length };
            sessionStorage.setItem("offline-test-mode", "read");
          } else {
            const inventory = await store.inventory();
            const regionId = inventory.regions[0]?.id;
            const resource = regionId ? await store.readResource(regionId, "metadata") : undefined;
            const afterRead = await store.inventory();
            const handler = regionId ? createOfflineRegionFetchHandler({ store, regionId, match: (request) => new URL(request.url).pathname === "/features" ? "metadata" : undefined }) : undefined;
            const response = handler ? await handler(new Request("https://example.test/features")) : undefined;
            const head = handler ? await handler(new Request("https://example.test/features", { method: "HEAD" })) : undefined;
            const miss = handler ? await handler(new Request("https://example.test/other")) : undefined;
            window.__offlineResult = { revision: inventory.revision === "0" ? "zero" : "present", regionCount: inventory.regions.length, logicalByteLength: inventory.regions[0]?.logicalByteLength, resource: resource ? new TextDecoder().decode(resource.bytes) : "missing", sourceVersion: resource?.manifest.source.sourceVersion, lastAccessedChanged: afterRead.regions[0]?.lastAccessedAt > inventory.regions[0]?.lastAccessedAt, intercepted: response ? await response.text() : "missing", contentType: response?.headers.get("content-type"), sourceHeader: response?.headers.get("x-honua-offline-source-version"), headBody: head ? await head.text() : "missing", miss: miss === undefined };
          }
        };
        run().catch((error) => { window.__offlineResult = { error: String(error) }; });
      </script>`);
      return;
    }
    if (url.pathname.startsWith("/dist/")) {
      try {
        const file = await readFile(path.join(repoRoot, url.pathname));
        response.setHeader("content-type", "application/javascript; charset=utf-8");
        response.end(file);
      } catch {
        response.statusCode = 404;
        response.end("not found");
      }
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    get offlineDataRequests() {
      return offlineDataRequests;
    },
    setOfflineDataOversized(value) {
      offlineDataOversized = value;
    },
    setOfflineDataCompressed(value) {
      offlineDataCompressed = value;
    },
    setShellResourceCompressed(resourcePath, value) {
      if (value) compressedShellResources.add(resourcePath);
      else compressedShellResources.delete(resourcePath);
    },
    setShellUnavailable(value) {
      shellUnavailable = value;
    },
    setShellHanging(value) {
      shellHanging = value;
    },
    setReferenceWorkerMessagesMuted(value) {
      referenceWorkerMessagesMuted = value;
    },
    setReferenceWorkerDigestHanging(value) {
      referenceWorkerDigestHanging = value;
    },
    setShellManifest(manifestPath, manifest) {
      shellManifests.set(manifestPath, {
        format: "honua.offline-shell-manifest.v1",
        deploymentId: manifest.deploymentId,
        resources: manifest.resources,
      });
    },
    shellManifestRequests(manifestPath) {
      return shellManifestRequestCounts.get(manifestPath) ?? 0;
    },
    holdShellResource(resourcePath, content) {
      let markRequested;
      let release;
      heldShellResources.set(resourcePath, {
        content,
        requested: new Promise((resolve) => {
          markRequested = resolve;
        }),
        released: new Promise((resolve) => {
          release = resolve;
        }),
        markRequested,
        release,
      });
    },
    waitForHeldShellResource(resourcePath) {
      const resource = heldShellResources.get(resourcePath);
      if (!resource) throw new Error(`Shell resource is not held: ${resourcePath}`);
      return resource.requested;
    },
    releaseHeldShellResource(resourcePath) {
      heldShellResources.get(resourcePath)?.release();
    },
    close: () =>
      new Promise((resolve, reject) => {
        for (const resource of heldShellResources.values()) resource.release();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

async function requestShellRefresh(page, manifestUrl) {
  return page.evaluate(async (value) => {
    const registration = await navigator.serviceWorker.getRegistration("./");
    if (!registration?.active) throw new Error("Offline reference service worker is inactive.");
    const channel = new MessageChannel();
    const reply = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Offline reference shell refresh timed out.")), 5000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(event.data);
      };
    });
    registration.active.postMessage({ type: "HONUA_PRECACHE_V2", manifestUrl: value }, [channel.port2]);
    return reply;
  }, manifestUrl);
}

function shellResource(url, value) {
  const bytes = Buffer.from(value);
  return {
    url,
    byteLength: bytes.byteLength,
    integrity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function readShellState(page) {
  return page.evaluate(
    async (cacheNamespaceBase) => {
      const scopePath = new URL("./", window.location.href).pathname;
      const cacheNamespace = `${cacheNamespaceBase}${encodeURIComponent(scopePath)}-`;
      const controlCacheName = `${cacheNamespace}control-v1`;
      const generationPrefix = `${cacheNamespace}generation-v1-`;
      const legacyCacheName = `${cacheNamespace}v1`;
      const cacheNames = await caches.keys();
      const control = await caches.open(controlCacheName);
      const pointerUrl = new URL("./__honua-active-shell-v1__", window.location.href);
      const pointer = await control.match(new Request(pointerUrl, { credentials: "omit", method: "GET" }));
      const pointedName = pointer ? await pointer.text() : undefined;
      const activeName = pointedName;
      if (!activeName) throw new Error("Offline reference has no active shell cache.");
      const cache = await caches.open(activeName);
      const requests = await cache.keys();
      const resources = await Promise.all(
        requests.map(async (request) => {
          const bytes = await (await cache.match(request)).arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return {
            url: request.url,
            byteLength: bytes.byteLength,
            integrity: `sha256:${[...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("")}`,
          };
        }),
      );
      resources.sort((left, right) => left.url.localeCompare(right.url));
      return {
        activeName,
        contentCacheNames: cacheNames
          .filter((name) => name === legacyCacheName || name.startsWith(generationPrefix))
          .sort(),
        urls: resources.map((resource) => resource.url),
        hasAuthorization: requests.some((request) => request.headers.has("authorization")),
        byteLengths: resources.map((resource) => resource.byteLength),
        resources,
      };
    },
    "honua-offline-region-reference-shell-",
  );
}

async function cleanupOfflineReference(page, context) {
  await context.setOffline(false).catch(() => undefined);
  const cleanup = page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  });
  await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 1000))]).catch(() => undefined);
  await page.close().catch(() => undefined);
}
