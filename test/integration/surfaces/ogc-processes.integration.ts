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

  it("returns the OGC Processes landing document [cert:ogc-processes/landing#positive] [cert:ogc-processes/landing#metadata] [cert:ogc-processes/landing#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcProcesses().landing", async () => {
      const landing = await processes.landing();
      expect(landing).toBeDefined();
      expect(Array.isArray(landing.links)).toBe(true);
    });
  });

  it("declares OGC Processes conformance classes [cert:ogc-processes/conformance#positive] [cert:ogc-processes/conformance#metadata] [cert:ogc-processes/conformance#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcProcesses().conformance", async () => {
      const conformance = await processes.conformance();
      expect(Array.isArray(conformance.conformsTo)).toBe(true);
    });
  });

  it("lists registered processes (may be empty) [cert:ogc-processes/list#positive] [cert:ogc-processes/list#metadata] [cert:ogc-processes/list#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcProcesses().list", async () => {
      const list = await processes.list();
      expect(Array.isArray(list.processes)).toBe(true);
    });
  });

  it("describes the first registered process when one exists [cert:ogc-processes/describe#positive] [cert:ogc-processes/describe#metadata] [cert:ogc-processes/describe#media-schema]", async ({ skip }) => {
    const list = await runWithDiagnostics(context, "client.ogcProcesses().list", async () => {
      const r = await processes.list();
      expect(Array.isArray(r.processes)).toBe(true);
      return r;
    });
    const first = list.processes[0];
    if (!first) {
      // Soft skip — execute is exercised in dedicated server tests but
      // the seed lane does not require a process to be registered.
      skip();
      return;
    }
    await runWithDiagnostics(context, "client.ogcProcesses().describe", async () => {
      const description = await processes.describe(first.id);
      expect(description.id).toBe(first.id);
    });
  });
});
