import type { IJobRun, JobSnapshot, JobStatus } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js/honua";

import {
  BUFFER_INPUTS,
  PROCESS_ID,
  RESULT_GEOMETRY_SHA256,
  decodeResultArtifact,
  digestGeometry,
} from "./fixtures.js";
import type { BufferArtifact, TimelineEntry, WalkthroughSnapshot } from "./types.js";

type SnapshotListener = (snapshot: WalkthroughSnapshot) => void;

export class BufferJobWalkthrough {
  private readonly client: HonuaClient;
  private readonly listeners = new Set<SnapshotListener>();
  private timelineCounter = 0;
  private generation = 0;
  private activeJob: IJobRun<BufferArtifact> | undefined;
  private activeAbort: AbortController | undefined;
  private state: WalkthroughSnapshot = {
    status: "idle",
    busy: false,
    timeline: [],
    result: undefined,
    resultDigest: undefined,
    error: undefined,
  };

  public constructor(options: { baseUrl: string; fetch?: typeof fetch }) {
    this.client = new HonuaClient({ baseUrl: options.baseUrl, ...(options.fetch ? { fetchFn: options.fetch } : {}) });
  }

  public snapshot(): WalkthroughSnapshot {
    return { ...this.state, timeline: [...this.state.timeline] };
  }

  public subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  public async primaryAction(): Promise<void> {
    if (this.state.status === "accepted" || this.state.status === "running") await this.cancel();
    else await this.run();
  }

  public async run(): Promise<void> {
    if (this.state.busy) return;
    const generation = ++this.generation;
    this.activeAbort?.abort();
    this.activeAbort = new AbortController();
    this.update({ status: "submitting", busy: true, timeline: [], error: undefined });

    try {
      const job = await this.client.ogcProcesses().execute<BufferArtifact>({
        processId: PROCESS_ID,
        inputs: {
          wkb: BUFFER_INPUTS.wkb,
          srid: BUFFER_INPUTS.srid,
          distance: BUFFER_INPUTS.distance,
        },
        mode: "async",
      });
      if (generation !== this.generation) return;
      this.activeJob = job;
      this.append("accepted", "Accepted", "Server created the deterministic job receipt.");
      const unwatch = job.watch((snapshot) => {
        if (generation !== this.generation) return;
        this.observe(snapshot);
      });

      try {
        const result = await job.results({
          signal: this.activeAbort.signal,
          deadlineMs: 2_500,
          maxAttempts: 4,
          pollIntervalMs: 120,
          maxPollIntervalMs: 120,
        });
        if (generation !== this.generation) return;
        const feature = decodeResultArtifact(result.outputs.output1);
        const digest = await digestGeometry(feature.geometry);
        if (digest !== RESULT_GEOMETRY_SHA256) {
          throw new Error(`Result geometry digest mismatch: expected ${RESULT_GEOMETRY_SHA256}, received ${digest}.`);
        }
        this.append("successful", "Result collected", "Verified GeoJSON artifact and rendered 33 ring positions.");
        this.update({ status: "successful", busy: false, result: feature, resultDigest: digest });
        this.activeJob = undefined;
      } finally {
        unwatch();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.append("failed", "Failed", message);
      this.update({ status: "failed", busy: false, error: message });
      this.activeJob = undefined;
    }
  }

  public async cancel(): Promise<void> {
    const job = this.activeJob;
    if (!job || (this.state.status !== "accepted" && this.state.status !== "running")) return;
    ++this.generation;
    this.activeAbort?.abort();
    this.update({ busy: true });
    try {
      const status = await job.cancel();
      this.append(status, "Dismissed", "DELETE /jobs/{jobId} acknowledged cancellation.");
      this.update({ status, busy: false, error: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.append("failed", "Cancellation failed", message);
      this.update({ status: "failed", busy: false, error: message });
    } finally {
      this.activeJob = undefined;
    }
  }

  private observe(snapshot: JobSnapshot<BufferArtifact>): void {
    if (snapshot.status === "running") {
      this.append("running", "Running", snapshot.progress?.message ?? "Computing buffer geometry.");
      return;
    }
    if (snapshot.status === "successful") {
      this.append("successful", "Successful", snapshot.progress?.message ?? "Buffer completed.");
      return;
    }
    if (snapshot.status === "failed" || snapshot.status === "dismissed") {
      this.append(snapshot.status, snapshot.status === "failed" ? "Failed" : "Dismissed", snapshot.error?.message ?? "Job ended.");
    }
  }

  private append(status: JobStatus, label: string, detail: string): void {
    const entry: TimelineEntry = { id: ++this.timelineCounter, status, label, detail };
    this.update({ status, timeline: [...this.state.timeline, entry].slice(-4) });
  }

  private update(patch: Partial<WalkthroughSnapshot>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
