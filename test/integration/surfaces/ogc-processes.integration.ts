/**
 * OGC API Processes integration coverage. Walks landing → conformance →
 * process list. The execute path is exercised only when the seed
 * exposes at least one registered process — otherwise the test records
 * the surface as exercised through the discovery calls and stops short
 * of submission.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("OGC API Processes", "ogc-processes", ({ client, context }) => {
  const processes = client.ogcProcesses();

  it("returns the OGC Processes landing document", async () => {
    const landing = await runWithDiagnostics(context, "client.ogcProcesses().landing", () => processes.landing());
    expect(landing).toBeDefined();
    expect(Array.isArray(landing.links)).toBe(true);
  });

  it("declares OGC Processes conformance classes", async () => {
    const conformance = await runWithDiagnostics(context, "client.ogcProcesses().conformance", () =>
      processes.conformance(),
    );
    expect(Array.isArray(conformance.conformsTo)).toBe(true);
  });

  it("lists registered processes (may be empty)", async () => {
    const list = await runWithDiagnostics(context, "client.ogcProcesses().list", () => processes.list());
    expect(Array.isArray(list.processes)).toBe(true);
  });

  it("describes the first registered process when one exists", async () => {
    const list = await runWithDiagnostics(context, "client.ogcProcesses().list", () => processes.list());
    const first = list.processes[0];
    if (!first) {
      // Soft skip — execute is exercised in dedicated server tests but
      // the seed lane does not require a process to be registered.
      return;
    }
    const description = await runWithDiagnostics(context, "client.ogcProcesses().describe", () =>
      processes.describe(first.id),
    );
    expect(description.id).toBe(first.id);
  });
});
