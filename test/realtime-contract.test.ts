import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { explainQuery, hashQueryPlan } from "../src/query-planner/index.js";
import {
  HonuaRealtimeResumeError,
  assertRealtimePlanIdentity,
  deriveRealtimeContractAuthority,
  realtimePlanFingerprint,
  redactRealtimeCheckpoint,
  serializeRealtimeCheckpoint,
  serializeRedactedRealtimeCheckpoint,
} from "../src/realtime/index.js";
import type {
  RealtimeDurableCheckpointV1,
  RealtimeResumeContextV1,
  ResumableRealtimeState,
} from "../src/realtime/index.js";

function incidentsPlan() {
  return explainQuery({
    descriptor: {
      id: "incidents",
      protocol: "ogc-features",
      locator: { url: "https://planner.example.test/ogc", collectionId: "incidents" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    },
    query: { where: "status <> 'resolved'", pagination: { limit: 100 }, returnGeometry: true },
  });
}

function baseContext(queryFingerprint: string): RealtimeResumeContextV1 {
  return {
    kind: "honua.realtime-resume-context",
    version: 1,
    sourceId: "incidents",
    queryFingerprint,
    sourceVersion: "incidents-snapshot-v7",
    schemaVersion: "incident-schema-v3",
    authorizationScopeFingerprint: "sha256:dispatch-read-v2",
  };
}

function checkpoint(overrides: Partial<RealtimeDurableCheckpointV1> = {}): RealtimeDurableCheckpointV1 {
  return {
    kind: "honua.realtime-checkpoint",
    version: 1,
    context: baseContext("sha256:accepted-plan-v1"),
    resume: { sequence: 6, cursor: "cursor-6", timestamp: "2026-07-10T23:00:00.000Z" },
    recentEventIds: ["snapshot-5", "delta-6"],
    savedAt: "2026-07-10T23:00:00.000Z",
    ...overrides,
  };
}

describe("realtimePlanFingerprint / assertRealtimePlanIdentity", () => {
  it("matches the query planner's canonical plan hash", () => {
    const plan = incidentsPlan();
    expect(realtimePlanFingerprint(plan)).toBe(hashQueryPlan(plan));
    expect(realtimePlanFingerprint(plan)).toBe(plan.fingerprint);
  });

  it("accepts a resume context bound to the accepted plan", () => {
    const plan = incidentsPlan();
    const context = baseContext(realtimePlanFingerprint(plan));
    expect(() => assertRealtimePlanIdentity(context, plan)).not.toThrow();
  });

  it("rejects a resume context bound to a different plan with the shared checkpoint taxonomy", () => {
    const plan = incidentsPlan();
    const context = baseContext("sha256:some-other-plan");
    let caught: unknown;
    try {
      assertRealtimePlanIdentity(context, plan);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HonuaRealtimeResumeError);
    const error = caught as HonuaRealtimeResumeError;
    expect(error.code).toBe("query-changed");
    expect(error.sdkCode).toBe("realtime.checkpoint.invalid");
  });

  it("rejects when the plan changes but the fingerprint is reused (two distinct queries never share resume identity)", () => {
    const planA = incidentsPlan();
    const planB = explainQuery({
      descriptor: {
        id: "incidents",
        protocol: "ogc-features",
        locator: { url: "https://planner.example.test/ogc", collectionId: "incidents" },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
      },
      query: { where: "status = 'open'", pagination: { limit: 100 }, returnGeometry: true },
    });
    expect(realtimePlanFingerprint(planA)).not.toBe(realtimePlanFingerprint(planB));
    const context = baseContext(realtimePlanFingerprint(planA));
    expect(() => assertRealtimePlanIdentity(context, planB)).toThrow(HonuaRealtimeResumeError);
  });
});

describe("deriveRealtimeContractAuthority", () => {
  const pending: ReadonlyArray<ResumableRealtimeState["phase"]> = [
    "awaiting-snapshot",
    "resuming",
    "resnapshot-required",
  ];

  it.each(pending)('reports "replaying" and unauthoritative while phase is %s', (phase) => {
    const authority = deriveRealtimeContractAuthority({ phase, checkpoint: undefined });
    expect(authority).toEqual({ state: "replaying", authoritative: false });
  });

  it('reports "live" and authoritative once a checkpoint exists and phase is live', () => {
    const authority = deriveRealtimeContractAuthority({ phase: "live", checkpoint: checkpoint() });
    expect(authority.state).toBe("live");
    expect(authority.authoritative).toBe(true);
  });

  it('demotes a live phase to "stale" once the checkpoint exceeds staleAfterMs', () => {
    const now = Date.parse("2026-07-10T23:05:00.000Z");
    const fresh = deriveRealtimeContractAuthority(
      { phase: "live", checkpoint: checkpoint() },
      { staleAfterMs: 10 * 60_000, now },
    );
    expect(fresh.state).toBe("live");
    expect(fresh.ageMs).toBe(5 * 60_000);

    const stale = deriveRealtimeContractAuthority(
      { phase: "live", checkpoint: checkpoint() },
      { staleAfterMs: 60_000, now },
    );
    expect(stale.state).toBe("stale");
    expect(stale.authoritative).toBe(true);
    expect(stale.ageMs).toBe(5 * 60_000);
  });

  it('reports "terminal" on error/closed and preserves authoritative:true when a last-known checkpoint survives', () => {
    const withCheckpoint = deriveRealtimeContractAuthority({ phase: "error", checkpoint: checkpoint() });
    expect(withCheckpoint).toEqual({ state: "terminal", authoritative: true, ageMs: withCheckpoint.ageMs });
    expect(withCheckpoint.authoritative).toBe(true);

    const withoutCheckpoint = deriveRealtimeContractAuthority({ phase: "closed", checkpoint: undefined });
    expect(withoutCheckpoint).toEqual({ state: "terminal", authoritative: false });
  });
});

describe("realtime checkpoint serialization and redaction", () => {
  it("serializes deterministically regardless of property insertion order", () => {
    const a = checkpoint();
    const b = {
      savedAt: a.savedAt,
      recentEventIds: a.recentEventIds,
      resume: { timestamp: a.resume.timestamp, cursor: a.resume.cursor, sequence: a.resume.sequence },
      context: a.context,
      version: a.version,
      kind: a.kind,
    } as RealtimeDurableCheckpointV1;
    expect(serializeRealtimeCheckpoint(a)).toBe(serializeRealtimeCheckpoint(b));
  });

  it("never leaks the raw cursor, watermark, or delta-token into the redacted projection", () => {
    const source = checkpoint({
      resume: { sequence: 9, cursor: "super-secret-cursor", watermark: "wm-42", deltaToken: "dt-99" },
    });
    const redacted = redactRealtimeCheckpoint(source);
    const serialized = serializeRedactedRealtimeCheckpoint(source);
    expect(serialized).not.toContain("super-secret-cursor");
    expect(serialized).not.toContain("wm-42");
    expect(serialized).not.toContain("dt-99");
    expect(redacted.resume.cursor).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(redacted.resume.watermark).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(redacted.resume.deltaToken).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(redacted.recentEventIdCount).toBe(source.recentEventIds.length);
    expect((redacted as unknown as { recentEventIds?: unknown }).recentEventIds).toBeUndefined();
  });

  it("redacts the same raw position to the same digest so correlation across log lines still works", () => {
    const first = redactRealtimeCheckpoint(checkpoint({ resume: { sequence: 1, cursor: "cursor-x" } }));
    const second = redactRealtimeCheckpoint(checkpoint({ resume: { sequence: 2, cursor: "cursor-x" } }));
    expect(first.resume.cursor).toBe(second.resume.cursor);
  });

  it("keeps context fingerprints in the clear in both serializations since they are already opaque", () => {
    const source = checkpoint();
    expect(serializeRealtimeCheckpoint(source)).toContain(source.context.authorizationScopeFingerprint);
    expect(serializeRedactedRealtimeCheckpoint(source)).toContain(source.context.authorizationScopeFingerprint);
  });
});
