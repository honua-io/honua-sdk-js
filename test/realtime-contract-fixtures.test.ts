/**
 * Fixture-driven acceptance tests for issue #556: the versioned snapshot,
 * delta, cursor, resume, and plan-identity contract. The fixture at
 * `test/fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json` is
 * the portable, non-TypeScript-specific description of the accepted
 * behavior (duplicate, reorder, gap, expired cursor, resnapshot, delete, and
 * schema change); this file is the SDK-side runner for it.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createResumableRealtimeSubscription,
  evaluateRealtimeCheckpoint,
  reduceRealtimeFeatureState,
} from "../src/realtime/index.js";
import type {
  RealtimeCheckpointCompatibilityCode,
  RealtimeFeatureEvent,
  RealtimeResumeContextV1,
  RealtimeSequencedEvent,
  ResumableRealtimeDeliveryStatus,
  ResumableRealtimeReasonCode,
} from "../src/realtime/index.js";
import { emptyRealtimeFeatureState } from "../src/realtime/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json");

interface EnqueueStep {
  readonly action: "enqueue";
  readonly event: RealtimeSequencedEvent;
  readonly expect: { readonly status: ResumableRealtimeDeliveryStatus; readonly reason?: ResumableRealtimeReasonCode };
}

interface RequireResnapshotStep {
  readonly action: "requireResnapshot";
  readonly reason: "cursor-expired" | "resume-unsupported" | "transport-gap";
  readonly detail?: string;
  readonly expectPhaseAfter: string;
  readonly expectReasonAfter: string;
}

type DeliveryStep = EnqueueStep | RequireResnapshotStep;

interface DeliveryScenario {
  readonly name: string;
  readonly description: string;
  readonly expectedFinalPhase: string;
  readonly steps: readonly DeliveryStep[];
}

interface CompatibilityScenario {
  readonly name: string;
  readonly description: string;
  readonly field: keyof RealtimeResumeContextV1;
  readonly value: string;
  readonly expectedCode: RealtimeCheckpointCompatibilityCode;
}

interface DeleteScenario {
  readonly name: string;
  readonly events: readonly RealtimeFeatureEvent<{ status: string }>[];
  readonly expectedRecordKeys: readonly string[];
  readonly expectedTombstoneKeysAfterDelete: readonly string[];
  readonly expectedTombstoneKeysAfterReopen: readonly string[];
}

interface ContractFixture {
  readonly version: 1;
  readonly kind: "honua.realtime-contract-fixtures";
  readonly context: RealtimeResumeContextV1;
  readonly compatibilityScenarios: readonly CompatibilityScenario[];
  readonly deliveryScenarios: readonly DeliveryScenario[];
  readonly deleteScenario: DeleteScenario;
}

const fixture: ContractFixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("realtime snapshot/delta/cursor/resume contract fixture", () => {
  it("is a well-formed v1 fixture covering every required scenario family", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.kind).toBe("honua.realtime-contract-fixtures");
    const names = fixture.deliveryScenarios.map((scenario) => scenario.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "duplicate-sequence",
        "reordered-delta-arrives-late",
        "sequence-gap-requires-resnapshot",
        "expired-cursor-requires-resnapshot",
      ]),
    );
    const compatibilityCodes = fixture.compatibilityScenarios.map((scenario) => scenario.expectedCode);
    expect(compatibilityCodes).toEqual(
      expect.arrayContaining([
        "source-changed",
        "query-changed",
        "source-version-changed",
        "schema-version-changed",
        "authorization-scope-changed",
      ]),
    );
  });

  for (const scenario of fixture.deliveryScenarios) {
    it(`delivery: ${scenario.name} — ${scenario.description}`, async () => {
      const gate = await createResumableRealtimeSubscription({
        context: fixture.context,
        apply: () => {},
      });

      for (const step of scenario.steps) {
        if (step.action === "requireResnapshot") {
          gate.requireResnapshot(step.reason, step.detail);
          expect(gate.state.phase).toBe(step.expectPhaseAfter);
          expect(gate.state.reason).toBe(step.expectReasonAfter);
          continue;
        }
        const delivery = await gate.enqueue(step.event);
        expect(delivery.status).toBe(step.expect.status);
        if (step.expect.reason !== undefined) {
          expect(delivery.reason).toBe(step.expect.reason);
        }
      }

      expect(gate.state.phase).toBe(scenario.expectedFinalPhase);
    });
  }

  for (const scenario of fixture.compatibilityScenarios) {
    it(`compatibility: ${scenario.name} — no cursor from a mismatched ${scenario.field} is ever accepted`, async () => {
      const durableCheckpoint = {
        kind: "honua.realtime-checkpoint" as const,
        version: 1 as const,
        context: fixture.context,
        resume: { sequence: 10, cursor: "cursor-10" },
        recentEventIds: [],
        savedAt: "2026-07-10T22:00:00.000Z",
      };
      const changedContext: RealtimeResumeContextV1 = { ...fixture.context, [scenario.field]: scenario.value };

      const evaluation = evaluateRealtimeCheckpoint(changedContext, durableCheckpoint);
      expect(evaluation.compatible).toBe(false);
      expect(evaluation.code).toBe(scenario.expectedCode);

      // A resnapshot-required subscription never applies a delta from the mismatched scope.
      const applied: unknown[] = [];
      const gate = await createResumableRealtimeSubscription({
        context: changedContext,
        initialCheckpoint: durableCheckpoint,
        apply: (event) => {
          applied.push(event);
        },
      });
      expect(gate.state.phase).toBe("resnapshot-required");
      expect(gate.state.reason).toBe(scenario.expectedCode);
      await gate.enqueue({ type: "upsert", sequence: 11, feature: { id: 1, feature: { status: "open" } } });
      expect(applied).toHaveLength(0);
    });
  }

  it(`delete: ${fixture.deleteScenario.name}`, () => {
    let state = emptyRealtimeFeatureState<{ status: string }>();
    for (const event of fixture.deleteScenario.events) {
      state = reduceRealtimeFeatureState(state, event);
      if ((event as { eventId?: string }).eventId === "delta-6") {
        expect(Object.keys(state.tombstones).sort()).toEqual([
          ...fixture.deleteScenario.expectedTombstoneKeysAfterDelete,
        ]);
        expect(state.records["incidents:2"]).toBeUndefined();
      }
    }
    expect(Object.keys(state.records).sort()).toEqual([...fixture.deleteScenario.expectedRecordKeys]);
    expect(Object.keys(state.tombstones).sort()).toEqual([...fixture.deleteScenario.expectedTombstoneKeysAfterReopen]);
    expect(state.records["incidents:2"]).toMatchObject({ feature: { status: "reopened" } });
  });
});
