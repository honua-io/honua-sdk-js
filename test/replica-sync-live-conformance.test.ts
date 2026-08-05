/**
 * Live lane for the GeoServices replica-sync transport.
 *
 * The lane is opt-in because it needs a deployment with the server's
 * `sync.offline` experimental capability enabled — see `docs/replica-sync.md`
 * for the deployment prerequisites. It is deliberately NOT a PR gate: absence of
 * a flagged deployment is recorded as absence, never as a pass.
 */

import { describe, expect, it } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import {
  createGeoServicesReplicaSyncTransport,
  runReplicaSyncTransportConformance,
} from "../src/replica-sync/index.js";
import {
  REPLICA_SYNC_LIVE_API_KEY_ENV,
  REPLICA_SYNC_LIVE_BASE_URL_ENV,
  REPLICA_SYNC_LIVE_BEARER_ENV,
  REPLICA_SYNC_LIVE_ENABLE_ENV,
  REPLICA_SYNC_LIVE_READ_ONLY_CASES,
  REPLICA_SYNC_LIVE_SERVICE_ENV,
  planReplicaSyncLiveLane,
} from "./helpers/replica-sync-live-lane.js";

describe("replica-sync live lane gate", () => {
  it("stays off unless explicitly enabled", () => {
    expect(planReplicaSyncLiveLane({})).toEqual({ executed: false, reason: "live-lane-disabled" });
    expect(planReplicaSyncLiveLane({ [REPLICA_SYNC_LIVE_ENABLE_ENV]: "false" })).toEqual({
      executed: false,
      reason: "live-lane-disabled",
    });
  });

  it("records a missing deployment as non-execution rather than a pass", () => {
    expect(planReplicaSyncLiveLane({ [REPLICA_SYNC_LIVE_ENABLE_ENV]: "true" })).toEqual({
      executed: false,
      reason: "missing-base-url",
    });
    expect(
      planReplicaSyncLiveLane({
        [REPLICA_SYNC_LIVE_ENABLE_ENV]: "true",
        [REPLICA_SYNC_LIVE_BASE_URL_ENV]: "https://example.invalid",
      }),
    ).toEqual({ executed: false, reason: "missing-service-id" });
  });

  it("does not read enabling the lane as consent to write", () => {
    // Observing a deployment is read-only; resolving a conflict writes to it.
    expect(
      planReplicaSyncLiveLane({
        [REPLICA_SYNC_LIVE_ENABLE_ENV]: "true",
        [REPLICA_SYNC_LIVE_BASE_URL_ENV]: "https://example.invalid",
        [REPLICA_SYNC_LIVE_SERVICE_ENV]: "parcels",
      }),
    ).toMatchObject({ executed: true, mutate: false });
  });
});

const plan = planReplicaSyncLiveLane();

describe.runIf(plan.executed)("replica-sync live conformance", () => {
  it("passes the shared transport conformance suite against a flagged deployment", async () => {
    if (!plan.executed) return;
    const client = new HonuaClient({
      baseUrl: plan.baseUrl,
      ...(process.env[REPLICA_SYNC_LIVE_API_KEY_ENV] === undefined
        ? {}
        : { apiKey: process.env[REPLICA_SYNC_LIVE_API_KEY_ENV] }),
      ...(process.env[REPLICA_SYNC_LIVE_BEARER_ENV] === undefined
        ? {}
        : { bearerToken: process.env[REPLICA_SYNC_LIVE_BEARER_ENV] }),
    });

    const report = await runReplicaSyncTransportConformance({
      label: "geoservices-live",
      datasetId: plan.serviceId,
      ...(plan.unsupportedServiceId === undefined ? {} : { unsupportedDatasetId: plan.unsupportedServiceId }),
      createTransport: () => createGeoServicesReplicaSyncTransport({ client, serviceId: plan.serviceId }),
      // A mutating lane is a separate, explicit opt-in.
      ...(plan.mutate ? {} : { only: REPLICA_SYNC_LIVE_READ_ONLY_CASES }),
    });

    // A case that cannot reach a verdict on this deployment is reported skipped,
    // not hidden — but nothing may fail.
    for (const entry of report.cases) {
      expect(entry, `${entry.name}: ${entry.detail ?? ""}`).toMatchObject({
        status: expect.stringMatching(/passed|skipped/),
      });
    }
    expect(report.failed).toBe(0);
  });
});
