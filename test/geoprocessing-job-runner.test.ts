import { describe, expect, it } from "vitest";

import {
  BUFFER_INPUTS,
  EXECUTION_BODY,
  EXECUTION_PATH,
  JOB_PATH,
  PROCESS_ID,
  RESULTS_PATH,
  RESULT_FEATURE,
  RESULT_GEOMETRY_SHA256,
  createPinnedFixtureFetch,
  digestGeometry,
} from "../examples/geoprocessing-job-runner/src/fixtures.js";
import { BufferJobWalkthrough } from "../examples/geoprocessing-job-runner/src/model.js";

describe("Run a buffer job and collect the result", () => {
  it("pins the admitted geometry.buffer inputs and result digest", async () => {
    expect(PROCESS_ID).toBe("geometry.buffer");
    expect(BUFFER_INPUTS).toEqual({ wkb: "AQEAAAA1K7tQM8JwwSnDYAG4hkJB", srid: 3857, distance: 350 });
    expect(RESULT_FEATURE.geometry.coordinates[0]).toHaveLength(33);
    expect(await digestGeometry(RESULT_FEATURE.geometry)).toBe(RESULT_GEOMETRY_SHA256);
  });

  it("uses HonuaClient execute and IJobRun for the exact four-exchange lifecycle", async () => {
    const fixture = createPinnedFixtureFetch();
    const walkthrough = new BufferJobWalkthrough({ baseUrl: "https://fixture.example", fetch: fixture.fetch });
    await walkthrough.run();
    const snapshot = walkthrough.snapshot();
    expect(snapshot.status).toBe("successful");
    expect(snapshot.resultDigest).toBe(RESULT_GEOMETRY_SHA256);
    expect(snapshot.timeline.map((entry) => entry.status)).toEqual(["accepted", "running", "successful", "successful"]);
    expect(fixture.exchanges.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: EXECUTION_PATH },
      { method: "GET", path: JOB_PATH },
      { method: "GET", path: JOB_PATH },
      { method: "GET", path: RESULTS_PATH },
    ]);
    expect(fixture.exchanges[0]).toMatchObject({ body: EXECUTION_BODY, prefer: "respond-async" });
  });

  it("surfaces structured execution errors without fabricating a result", async () => {
    const fixture = createPinnedFixtureFetch({ failExecution: true });
    const walkthrough = new BufferJobWalkthrough({ baseUrl: "https://fixture.example", fetch: fixture.fetch });
    await walkthrough.run();
    expect(walkthrough.snapshot()).toMatchObject({ status: "failed", result: undefined });
    expect(walkthrough.snapshot().error).toContain("Invalid buffer inputs");
  });

  it("cancels an active IJobRun through DELETE and permits restart", async () => {
    const fixture = createPinnedFixtureFetch();
    const walkthrough = new BufferJobWalkthrough({ baseUrl: "https://fixture.example", fetch: fixture.fetch });
    let releaseAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const unsubscribe = walkthrough.subscribe((snapshot) => {
      if (snapshot.status === "accepted") releaseAccepted();
    });
    const running = walkthrough.run();
    await accepted;
    await walkthrough.cancel();
    await running;
    unsubscribe();
    expect(walkthrough.snapshot().status).toBe("dismissed");
    expect(fixture.exchanges.some(({ method, path }) => method === "DELETE" && path === JOB_PATH)).toBe(true);
    await walkthrough.run();
    expect(walkthrough.snapshot().status).toBe("successful");
  });
});
