/**
 * Pure unit coverage for the integration metadata reporter. The reporter
 * is split between the Vitest global setup process (which initializes
 * the artifact) and surface-test worker processes (which call
 * {@link recordSurface}). Each worker has its own module instance, so
 * the worker has to restore the metadata document from disk before
 * appending. This file verifies that round trip without spinning up a
 * real Vitest worker pool.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const META_FILE = path.join(PROJECT_ROOT, "test-results", "integration-meta.json");

beforeEach(() => {
  vi.resetModules();
  if (fs.existsSync(META_FILE)) {
    fs.rmSync(META_FILE, { force: true });
  }
});

afterEach(() => {
  if (fs.existsSync(META_FILE)) {
    fs.rmSync(META_FILE, { force: true });
  }
});

async function loadReporter(): Promise<typeof import("./integration/reporter.js")> {
  return import("./integration/reporter.js");
}

const META_FIXTURE = {
  sdkPackage: "@honua/sdk-js",
  sdkVersion: "0.0.3-alpha.0",
  serverVersion: "1.0.0",
  serverReleaseChannel: "preview",
  serverImage: undefined,
  serverCommit: undefined,
  conformanceFixturesVersion: undefined,
  baseUrl: "http://localhost:5555",
  seedProfile: "places-roads-v1",
  serviceId: "test_service_gw0",
  layerId: 1000,
  collectionId: "1000",
  tileMatrixSetId: "WebMercatorQuad",
  startedAt: "2026-04-28T01:23:45Z",
};

describe("integration reporter", () => {
  it("writes the initial document to disk on initializeMeta", async () => {
    const reporter = await loadReporter();
    reporter.initializeMeta(META_FIXTURE);
    const written = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    expect(written.sdkPackage).toBe("@honua/sdk-js");
    expect(written.surfaces).toEqual([]);
  });

  it("appends an exercised surface entry when initializeMeta has primed the module", async () => {
    const reporter = await loadReporter();
    reporter.initializeMeta(META_FIXTURE);
    reporter.recordSurface("feature-server");
    const written = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    expect(written.surfaces).toHaveLength(1);
    expect(written.surfaces[0]).toMatchObject({ surface: "feature-server", status: "exercised" });
    expect(written.surfaces[0].reason).toBeUndefined();
  });

  it("merges new surfaces from a fresh module instance by reading the on-disk artifact", async () => {
    // Simulate Vitest global setup writing the artifact in the main
    // process.
    const setupReporter = await loadReporter();
    setupReporter.initializeMeta(META_FIXTURE);
    setupReporter.recordSurface("feature-server");

    // Simulate a worker process that imports the reporter fresh — its
    // own `mutableMeta` starts undefined, but recordSurface must still
    // add its surface to the artifact instead of silently dropping it.
    vi.resetModules();
    const workerReporter = await loadReporter();
    expect(workerReporter.readMeta()).toBeUndefined();
    workerReporter.recordSurface("ogc-features");

    const written = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    const surfaces = (written.surfaces as Array<{ surface: string; status: string }>).map((entry) => entry.surface);
    expect(surfaces).toEqual(["feature-server", "ogc-features"]);
    const featureSrv = written.surfaces.find((entry: { surface: string }) => entry.surface === "feature-server");
    expect(featureSrv.status).toBe("exercised");
    const ogc = written.surfaces.find((entry: { surface: string }) => entry.surface === "ogc-features");
    expect(ogc.status).toBe("exercised");
  });

  it("records a skipped surface with the supplied reason from a fresh worker instance", async () => {
    const setupReporter = await loadReporter();
    setupReporter.initializeMeta(META_FIXTURE);
    vi.resetModules();
    const workerReporter = await loadReporter();
    workerReporter.recordSurface("image-server", "no first-party adapter (tracked by honua-sdk-js#39)");
    const written = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    expect(written.surfaces).toHaveLength(1);
    expect(written.surfaces[0]).toMatchObject({
      surface: "image-server",
      status: "skipped",
      reason: "no first-party adapter (tracked by honua-sdk-js#39)",
    });
  });

  it("returns silently when neither in-memory state nor an on-disk artifact exists", async () => {
    const reporter = await loadReporter();
    expect(() => reporter.recordSurface("feature-server")).not.toThrow();
    expect(fs.existsSync(META_FILE)).toBe(false);
  });
});
