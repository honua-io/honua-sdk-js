/**
 * GeoServices GPServer integration coverage.
 *
 * Exercises the public `client.geoprocessing(...)` entry point when the
 * target seed advertises a runnable GPServer service. Shared vector-only
 * seeds usually do not include a job task, so the surface is recorded as
 * skipped unless `HONUA_INTEGRATION_GP_SERVICE_ID` names a seeded GPServer.
 *
 * @module
 */

import { expect, it } from "vitest";
import {
  integrationSuite,
  runWithDiagnostics,
  skippedIntegrationSuite,
  tryResolveIntegrationConfig,
} from "../harness.js";

const REASON = "HONUA_INTEGRATION_GP_SERVICE_ID unset; seeded GPServer task required for live job coverage";

const config = tryResolveIntegrationConfig();

if (config && !config.gpServiceId) {
  skippedIntegrationSuite("GPServer", "gp-server", REASON, () => {
    it.skip("submits a GPServer job when a seeded task is configured", () => {
      expect(true).toBe(true);
    });
  });
} else {
  integrationSuite("GPServer", "gp-server", ({ client, context, config }) => {
    const gp = client.geoprocessing(config.gpServiceId ?? config.serviceId, config.gpTaskName);

    it("submits a GPServer job and reads its status", async () => {
      const job = await runWithDiagnostics(context, "client.geoprocessing().submitJob", async () => {
        const parameters = parseJsonObject(process.env.HONUA_INTEGRATION_GP_PARAMETERS_JSON) ?? {};
        const result = await gp.submitJob({ parameters });
        expect(result.jobId).toBeTruthy();
        expect(result.jobStatus).toBeTruthy();
        return result;
      });
      await runWithDiagnostics(context, "client.geoprocessing().jobStatus", async () => {
        const status = await gp.jobStatus(job.jobId);
        expect(status.jobId).toBe(job.jobId);
        expect(status.jobStatus).toBeTruthy();
      });
    });
  });
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("HONUA_INTEGRATION_GP_PARAMETERS_JSON must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
