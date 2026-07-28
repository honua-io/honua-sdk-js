import { readFileSync } from "node:fs";

import * as realtime from "@honua/sdk-js/realtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RealtimeCrossTransportCorpusV1,
  runRealtimeCrossTransportConformance,
} from "./helpers/realtime-cross-transport-conformance.js";
import { runRealtimeCrossTransportMatrix } from "./helpers/realtime-cross-transport-matrix.js";

const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/realtime/cross-transport-conformance.v1.json", import.meta.url), "utf8"),
) as RealtimeCrossTransportCorpusV1;
const baseContract = JSON.parse(
  readFileSync(new URL("./fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json", import.meta.url), "utf8"),
) as { readonly context: unknown };

describe("shared realtime cross-transport conformance S1", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one basic history through shipped resumable streaming compositions and OData's common contract", async () => {
    expect(corpus.context).toEqual(baseContract.context);
    const evidence = await runRealtimeCrossTransportConformance({
      sdk: realtime,
      corpus,
      advanceOdataPoll: async (intervalMs) => {
        await vi.advanceTimersByTimeAsync(intervalMs);
      },
    });

    expect(evidence).toMatchObject({
      format: "honua.realtime-cross-transport-s1-evidence.v1",
      corpusVersion: 1,
      scenario: "snapshot-create-update-delete",
    });
    expect(evidence.transports.map((transport) => transport.transport)).toEqual(["sse", "websocket", "odata"]);
    expect(evidence.transports.map((transport) => transport.records)).toEqual([
      corpus.expected.records,
      corpus.expected.records,
      corpus.expected.records,
    ]);
    expect(evidence.transports.find((transport) => transport.transport === "odata")?.freshness).toEqual({
      mode: "poll",
      pollCount: 2,
    });
    expect(
      evidence.transports
        .filter((transport) => transport.transport !== "odata")
        .map((transport) => transport.checkpointTelemetry),
    ).toEqual([
      expect.objectContaining({
        source: "resumable-wrapper",
        redacted: true,
        rawPositionPresent: false,
      }),
      expect.objectContaining({
        source: "resumable-wrapper",
        redacted: true,
        rawPositionPresent: false,
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(corpus.scenarios)("runs $id through all three public adapters", async (scenario) => {
    const evidence = await runRealtimeCrossTransportMatrix({
      sdk: realtime,
      corpus,
      scenarioIds: [scenario.id],
      advanceTime: async (milliseconds) => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      },
      advanceNextTimer: async () => {
        await vi.advanceTimersToNextTimerAsync();
      },
      activeTimerCount: () => vi.getTimerCount(),
    });

    expect(evidence).toMatchObject({
      format: "honua.realtime-cross-transport-evidence.v1",
      schemaVersion: 1,
      corpusVersion: 1,
      scenarioCount: 1,
      transportCount: 3,
      executionCount: 3,
    });
    expect(evidence.scenarios.map((entry) => entry.id)).toEqual([scenario.id]);
    expect(evidence.persistedReplay).toEqual({
      sameScopeCompatible: true,
      checkpointLoads: 2,
      connectionAttempts: 2,
      resumedSequence: corpus.positions.snapshot.sequence,
      acceptedSequence: corpus.positions.delta.sequence,
      cursorReplayed: true,
      watermarkReplayed: true,
    });
    expect(
      evidence.scenarios.flatMap((entry) =>
        entry.transports.map((transport) => `${entry.id}:${transport.transport}:${transport.result}`),
      ),
    ).toHaveLength(3);
    expect(
      evidence.scenarios
        .flatMap((scenario) => scenario.transports)
        .filter((transport) => transport.freshness.mode === "poll")
        .every((transport) => transport.transport === "odata" && transport.freshness.pollCount >= 1),
    ).toBe(true);
    if (scenario.fault === "buffer-overflow") {
      expect(evidence.scenarios[0]?.transports.map((transport) => transport.acceptedEventIds)).toEqual([
        ["snapshot-1", "delta-2", "snapshot-100", "delta-101"],
        ["snapshot-1", "delta-2", "snapshot-100", "delta-101"],
        ["snapshot-1", "delta-2", "snapshot-100", "delta-101"],
      ]);
    }
    expect(
      evidence.scenarios[0]?.transports.map((transport) => ({
        socketsActive: transport.lifecycle.socketsActive,
        requestsActive: transport.lifecycle.requestsActive,
        callbacksActive: transport.lifecycle.callbacksActive,
        checkpointsActive: transport.lifecycle.checkpointsActive,
        repeatedDisposal: transport.lifecycle.repeatedDisposal,
      })),
    ).toEqual([
      {
        socketsActive: 0,
        requestsActive: 0,
        callbacksActive: 0,
        checkpointsActive: 0,
        repeatedDisposal: true,
      },
      {
        socketsActive: 0,
        requestsActive: 0,
        callbacksActive: 0,
        checkpointsActive: 0,
        repeatedDisposal: true,
      },
      {
        socketsActive: 0,
        requestsActive: 0,
        callbacksActive: 0,
        checkpointsActive: 0,
        repeatedDisposal: true,
      },
    ]);
    if (scenario.fault === "cancel") {
      expect(evidence.scenarios[0]?.transports.map((transport) => transport.lifecycle.cancellation)).toEqual([
        {
          inFlightWorkObserved: true,
          abortObserved: true,
          hostileWorkReleased: true,
          lateCallbacks: 0,
          lateDataEvents: 0,
          stateUnchanged: true,
        },
        {
          inFlightWorkObserved: true,
          abortObserved: true,
          hostileWorkReleased: true,
          lateCallbacks: 0,
          lateDataEvents: 0,
          stateUnchanged: true,
        },
        {
          inFlightWorkObserved: true,
          abortObserved: true,
          hostileWorkReleased: true,
          lateCallbacks: 0,
          lateDataEvents: 0,
          stateUnchanged: true,
        },
      ]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cursor", "watermark", "deltaToken"] as const)(
    "rejects a matrix checkpoint when the %s digest has valid syntax but the wrong field-aware value",
    async (field) => {
      const tamperingSdk: typeof realtime = {
        ...realtime,
        createResumableServerSentEventsTransport(transportOptions, resumableOptions) {
          const onTelemetry = resumableOptions.onTelemetry;
          return realtime.createResumableServerSentEventsTransport(transportOptions, {
            ...resumableOptions,
            onTelemetry(event) {
              const checkpoint = event.checkpoint;
              if (checkpoint?.resume[field] === undefined) {
                onTelemetry?.(event);
                return;
              }
              onTelemetry?.({
                ...event,
                checkpoint: {
                  ...checkpoint,
                  resume: {
                    ...checkpoint.resume,
                    [field]: `sha256:${"0".repeat(64)}`,
                  },
                },
              } as typeof event);
            },
          });
        },
      };

      await expect(
        runRealtimeCrossTransportMatrix({
          sdk: tamperingSdk,
          corpus,
          scenarioIds: [corpus.scenarios[0]!.id],
          advanceTime: async (milliseconds) => {
            await vi.advanceTimersByTimeAsync(milliseconds);
          },
          advanceNextTimer: async () => {
            await vi.advanceTimersToNextTimerAsync();
          },
          activeTimerCount: () => vi.getTimerCount(),
        }),
      ).rejects.toThrow(/checkpoint evidence failed/u);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["sequence", "savedAt"] as const)(
    "rejects a matrix checkpoint whose redacted sample is not bound to the durable %s",
    async (binding) => {
      const tamperingSdk: typeof realtime = {
        ...realtime,
        createResumableServerSentEventsTransport(transportOptions, resumableOptions) {
          const onTelemetry = resumableOptions.onTelemetry;
          return realtime.createResumableServerSentEventsTransport(transportOptions, {
            ...resumableOptions,
            onTelemetry(event) {
              const checkpoint = event.checkpoint;
              if (!checkpoint) {
                onTelemetry?.(event);
                return;
              }
              onTelemetry?.(
                binding === "sequence"
                  ? ({
                      ...event,
                      checkpoint: {
                        ...checkpoint,
                        resume: { ...checkpoint.resume, sequence: checkpoint.resume.sequence + 1 },
                      },
                    } as typeof event)
                  : ({
                      ...event,
                      checkpoint: {
                        ...checkpoint,
                        savedAt: new Date(Date.parse(checkpoint.savedAt) + 1).toISOString(),
                      },
                    } as typeof event),
              );
            },
          });
        },
      };

      await expect(
        runRealtimeCrossTransportMatrix({
          sdk: tamperingSdk,
          corpus,
          scenarioIds: [corpus.scenarios[0]!.id],
          advanceTime: async (milliseconds) => {
            await vi.advanceTimersByTimeAsync(milliseconds);
          },
          advanceNextTimer: async () => {
            await vi.advanceTimersToNextTimerAsync();
          },
          activeTimerCount: () => vi.getTimerCount(),
        }),
      ).rejects.toThrow(/checkpoint evidence failed/u);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects pending waiters when a shipped resumable composition reports a sequence gap", async () => {
    const gapCorpus = structuredClone(corpus);
    Reflect.set(gapCorpus.positions.delta, "sequence", 3);

    await expect(
      runRealtimeCrossTransportConformance({
        sdk: realtime,
        corpus: gapCorpus,
        advanceOdataPoll: async (intervalMs) => {
          await vi.advanceTimersByTimeAsync(intervalMs);
        },
      }),
    ).rejects.toThrow(/reconnect attempts exhausted/u);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects pending waiters when the OData adapter reports a projection error", async () => {
    const invalidOdataCorpus = structuredClone(corpus);
    Reflect.set(invalidOdataCorpus.initial[0]!, "status", 42);

    await expect(
      runRealtimeCrossTransportConformance({
        sdk: realtime,
        corpus: invalidOdataCorpus,
        advanceOdataPoll: async (intervalMs) => {
          await vi.advanceTimersByTimeAsync(intervalMs);
        },
      }),
    ).rejects.toThrow(/OData delta entry projection/u);
    expect(vi.getTimerCount()).toBe(0);
  });
});
