/**
 * Skip-attestation renewal planning (honua-io/honua-sdk-js#972).
 *
 * Three sample live lanes publish a *dated skip attestation* instead of
 * executed evidence: their declared mode is `unavailable`, so the honest thing
 * the producer can observe is "this journey could not run here, and here is
 * when I last checked". `configuration.evidenceExpiry.nonExecutedMaxDays`
 * (90 days) is the ceiling on how long such an observation may be claimed as
 * current, and validateCatalog's wall-clock check -- deliberately NOT relaxed
 * for feature PRs -- fails the whole catalog once it lapses. That single
 * failure turns every open PR red on "Verify sample publication contract" and
 * also fails the regeneration workflow's own reseal passes, so the automation
 * that exists to keep evidence fresh cannot heal it (#810, and again #971/#972).
 *
 * Nothing renewed those observations. `refresh-live-expiry` recomputes the
 * catalog's projected `expiresAt` literal from an attestation already on disk,
 * and correctly REFUSES once that attestation has itself outlived the policy
 * window -- refreshing a literal cannot renew an observation. Only re-running
 * the lane's producer can, and until now only a human ever did that.
 *
 * This module is the planning half of the automated answer: given the migration
 * overlay (the authority for which lanes are skip-attested) and the v1 catalog
 * (the authority for each lane's reviewed producer command), it decides which
 * attestations are close enough to their policy horizon to be re-observed now,
 * and which are close enough to alert on. It is deliberately pure and depends
 * only on Node builtins, so the regeneration workflow can evaluate the renewal
 * window BEFORE `npm ci` -- which is what lets a due renewal veto the loop
 * guard's skip on an otherwise quiet trunk.
 *
 * Two thresholds, and the gap between them is the point:
 *
 *   renewWithinDays (30) -- re-observe this far ahead of the horizon. The
 *     regeneration workflow runs every six hours, so the first run inside the
 *     window renews and pushes the horizon back to a full policy window.
 *   alertWithinDays (14) -- the "renewal is not working" signal. Under a
 *     healthy renewal cadence a lane can never reach it, so reaching it means
 *     something is wrong 14 days BEFORE the lapse wedges trunk, instead of the
 *     first symptom being a red gate on somebody else's unrelated PR.
 *
 * The horizon this module plans against is the attestation's own
 * `observedAt + nonExecutedMaxDays`, not the overlay's `expiresAt` literal.
 * That literal is a projection: the refresh step that runs immediately after
 * renewal recomputes it to exactly this value, so the observation's policy
 * horizon -- not whatever the literal currently says -- is the date that can
 * actually wedge trunk. The literal is still reported for context.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export const MIGRATION_PATH = "samples/contract/v2/migrations/catalog.v1-to-v2.json";
export const V1_CATALOG_PATH = "samples/catalog.v1.json";
export const EVIDENCE_SCHEMA_PATH = "samples/contract/v1/schemas/sample-evidence.schema.json";

export const SKIP_ATTESTATION_RENEWAL_POLICY = Object.freeze({
  renewWithinDays: 30,
  alertWithinDays: 14,
});

/**
 * Canonical property order, copied from the evidence schema's own `properties`
 * order. Producers build their envelopes in whatever order their code happens
 * to spread them (the AI builder's, for example, appends `source` and `reason`
 * last), but the committed attestations are all in schema order. Rewriting to
 * this order means a renewal's diff is only the fields that actually changed --
 * not an unreviewable reshuffle of every line in the file.
 */
export const CANONICAL_EVIDENCE_KEYS = Object.freeze([
  "$schema",
  "format",
  "schemaVersion",
  "sampleId",
  "lane",
  "status",
  "reason",
  "observedAt",
  "authMode",
  "sdk",
  "source",
  "provenance",
  "semantics",
  "timing",
  "degradation",
  "realtime",
  "cog",
  "artifacts",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRepositoryRelativePath(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty path`);
  invariant(!path.isAbsolute(value) && !/^[A-Za-z]:/.test(value), `${label} must be repository-relative`);
  invariant(!value.includes("\\"), `${label} must use POSIX separators`);
  invariant(
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    `${label} must not traverse outside the repository`,
  );
}

function parseDateTime(value, label) {
  const parsed = Date.parse(value);
  invariant(typeof value === "string" && Number.isFinite(parsed), `${label} must be an RFC 3339 date-time`);
  return parsed;
}

/**
 * The set of live lanes that publish a skip attestation, read from the same
 * overlay the refresh step reads. Discovery is by declared shape -- overlay
 * `live.status === "skipped"` -- rather than by a hardcoded id list, so a
 * newly skip-attested sample is renewed automatically instead of silently
 * arming the next lapse (which is exactly how the incident dashboard was left
 * out of the #810 fix).
 */
export function skipAttestationLanes(migration, catalogV1) {
  const overrides = migration?.sampleOverrides;
  invariant(overrides && typeof overrides === "object", "migration overlay has no sampleOverrides");
  const v1Samples = new Map((catalogV1?.samples ?? []).map((sample) => [sample.id, sample]));
  const lanes = [];
  for (const [sampleId, override] of Object.entries(overrides)) {
    const live = override?.live;
    if (!live || live.status !== "skipped") continue;
    invariant(
      live.mode === "unavailable" || live.mode === "degraded",
      `${sampleId}: a skip-attested lane must declare an unavailable or degraded mode, not "${live.mode}"`,
    );
    const v1Live = v1Samples.get(sampleId)?.lanes?.live;
    const evidencePath = live.evidencePath ?? v1Live?.evidencePath;
    invariant(evidencePath, `${sampleId}: skip-attested lane has no evidencePath to renew`);
    assertRepositoryRelativePath(evidencePath, `${sampleId}.live.evidencePath`);
    // migrateCatalogV1ToV2 resolves commands as `override.live.commands ?? v1
    // lanes.live.commands`; mirror that precedence exactly so the command this
    // plan names is the one the published catalog names as the lane's reviewed
    // producer, and never a second, divergent definition of the same thing.
    const commands = live.commands ?? v1Live?.commands;
    invariant(
      Array.isArray(commands) && commands.length === 1,
      `${sampleId}: a renewable skip attestation requires exactly one reviewed producer command`,
    );
    lanes.push({
      sampleId,
      mode: live.mode,
      targetMode: live.targetMode ?? null,
      declaredStatus: live.status,
      evidencePath,
      overlayExpiresAt: live.expiresAt ?? null,
      command: commands[0],
    });
  }
  // An empty result is a legitimate end state, not an error: it is what
  // promoting every lane to executed evidence looks like. Renewal simply has
  // nothing to do, and must not fail the workflow it runs inside for it.
  return lanes.sort((left, right) => left.sampleId.localeCompare(right.sampleId));
}

/**
 * Decide, per skip-attested lane, whether its attestation must be re-observed
 * now and whether it is close enough to its horizon to alert on.
 *
 * `readEvidence` is injectable so tests can plan against a fixture tree without
 * touching the repository's real attestations.
 */
export async function planSkipAttestationRenewal(options = {}) {
  const { migration, catalogV1 } = options;
  const policy = { ...SKIP_ATTESTATION_RENEWAL_POLICY, ...(options.policy ?? {}) };
  invariant(
    Number.isInteger(policy.renewWithinDays) && policy.renewWithinDays > 0,
    "renewWithinDays must be a positive integer",
  );
  invariant(
    Number.isInteger(policy.alertWithinDays) && policy.alertWithinDays >= 0,
    "alertWithinDays must be a non-negative integer",
  );
  // The whole design rests on this ordering: renewal fires strictly earlier
  // than the alert, so an alert can only ever mean "renewal did not happen".
  // Inverting them would make every renewal announce itself as a problem and
  // make a real failure indistinguishable from routine operation.
  invariant(
    policy.alertWithinDays < policy.renewWithinDays,
    "alertWithinDays must be strictly less than renewWithinDays so an alert can only mean renewal failed",
  );
  const nonExecutedMaxDays = migration?.configuration?.evidenceExpiry?.nonExecutedMaxDays;
  invariant(
    Number.isInteger(nonExecutedMaxDays) && nonExecutedMaxDays > 0,
    "migration configuration.evidenceExpiry.nonExecutedMaxDays is required",
  );
  invariant(
    policy.renewWithinDays < nonExecutedMaxDays,
    `renewWithinDays (${policy.renewWithinDays}) must be inside the ${nonExecutedMaxDays}-day non-executed policy window`,
  );
  const nowMs = options.now === undefined ? Date.now() : parseDateTime(options.now, "renewal plan now");
  const readEvidence =
    options.readEvidence ??
    (async (evidencePath) => JSON.parse(await readFile(path.join(options.projectRoot ?? ".", evidencePath), "utf8")));

  const lanes = [];
  for (const lane of skipAttestationLanes(migration, catalogV1)) {
    const evidence = await readEvidence(lane.evidencePath);
    invariant(evidence.sampleId === lane.sampleId, `${lane.sampleId}: attestation sampleId drift`);
    invariant(evidence.lane === "live", `${lane.sampleId}: attestation is not a live envelope`);
    invariant(
      evidence.status === lane.declaredStatus,
      `${lane.sampleId}: attestation status "${evidence.status}" does not match the declared lane status "${lane.declaredStatus}"`,
    );
    const observedAtMs = parseDateTime(evidence.observedAt, `${lane.sampleId}.observedAt`);
    const horizonMs = observedAtMs + nonExecutedMaxDays * DAY_MS;
    const daysRemaining = (horizonMs - nowMs) / DAY_MS;
    lanes.push({
      ...lane,
      observedAt: evidence.observedAt,
      reason: evidence.reason ?? null,
      policyExpiresAt: new Date(horizonMs).toISOString(),
      daysRemaining,
      lapsed: daysRemaining <= 0,
      action: daysRemaining <= policy.renewWithinDays ? "renew" : "hold",
      alert: daysRemaining <= policy.alertWithinDays,
    });
  }
  return {
    now: new Date(nowMs).toISOString(),
    policy,
    nonExecutedMaxDays,
    lanes,
  };
}

/** Where a renewed attestation's `$schema` must point, given where it is written. */
export function evidenceSchemaReference(evidencePath) {
  assertRepositoryRelativePath(evidencePath, "evidencePath");
  return path.posix.relative(path.posix.dirname(evidencePath), EVIDENCE_SCHEMA_PATH);
}

/**
 * Producers write their envelope to a run-scoped output path (two directories
 * deep, under test-results/), while the committed attestation lives three deep
 * under examples/<sample>/evidence/. A straight copy therefore leaves `$schema`
 * pointing at nothing -- the single most error-prone step of the manual heal
 * this automation replaces. Recompute it from the destination, and normalize
 * key order, so the installed bytes are a function of the destination rather
 * than of which producer happened to emit them.
 */
export function canonicalAttestation(evidence, evidencePath) {
  const canonical = { $schema: evidenceSchemaReference(evidencePath) };
  for (const key of CANONICAL_EVIDENCE_KEYS) {
    if (key === "$schema") continue;
    if (Object.hasOwn(evidence, key)) canonical[key] = evidence[key];
  }
  const unknown = Object.keys(evidence).filter((key) => !CANONICAL_EVIDENCE_KEYS.includes(key));
  invariant(unknown.length === 0, `renewed attestation carries unknown properties: ${unknown.join(", ")}`);
  return canonical;
}

export function serializeAttestation(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

/**
 * A renewal is only allowed to move the observation forward. It may NOT change
 * what the lane claims: the same sample, the same live lane, the same
 * non-executed status, the same degradation state, and the same journey. A
 * producer that suddenly reports something else (because configuration leaked
 * into the automation's environment, or because the sample changed underneath
 * it) is a change of claim that a human has to review -- not something a
 * scheduled job may commit on its own. Refusing here keeps the automation's
 * authority narrow: it re-dates an existing, already-reviewed attestation and
 * nothing more.
 *
 * `reason` is deliberately allowed to differ. It is prose describing what this
 * particular observation found, and re-observing is exactly the act that may
 * find a different (still unavailable) explanation.
 */
export function assertRenewedAttestation(renewed, { lane, previous }) {
  invariant(renewed.sampleId === lane.sampleId, `${lane.sampleId}: renewed attestation is for ${renewed.sampleId}`);
  invariant(renewed.lane === "live", `${lane.sampleId}: renewed attestation is not a live envelope`);
  invariant(
    renewed.status === lane.declaredStatus,
    `${lane.sampleId}: renewed attestation status "${renewed.status}" does not match the declared "${lane.declaredStatus}"; ` +
      "the producer no longer reproduces this lane's reviewed classification, so it needs human review rather than automated renewal",
  );
  invariant(
    renewed.degradation?.state === previous.degradation?.state,
    `${lane.sampleId}: renewed attestation degradation state "${renewed.degradation?.state}" does not match the committed "${previous.degradation?.state}"`,
  );
  invariant(
    renewed.semantics?.operation === previous.semantics?.operation,
    `${lane.sampleId}: renewed attestation describes journey "${renewed.semantics?.operation}" instead of "${previous.semantics?.operation}"`,
  );
  invariant(
    typeof renewed.reason === "string" && renewed.reason.length > 0,
    `${lane.sampleId}: a non-executed attestation must state a reason`,
  );
  const previousObservedAtMs = parseDateTime(previous.observedAt, `${lane.sampleId}.previous.observedAt`);
  const renewedObservedAtMs = parseDateTime(renewed.observedAt, `${lane.sampleId}.renewed.observedAt`);
  invariant(
    renewedObservedAtMs > previousObservedAtMs,
    `${lane.sampleId}: renewed attestation observedAt ${renewed.observedAt} does not follow the committed ${previous.observedAt}`,
  );
  return renewed;
}

const roundDays = (days) => Math.round(days * 10) / 10;

export function formatRenewalPlan(plan, { renewed = [] } = {}) {
  const renewedIds = new Set(renewed);
  const lines = [
    `Skip-attestation renewal at ${plan.now} ` +
      `(policy window ${plan.nonExecutedMaxDays}d, renew within ${plan.policy.renewWithinDays}d, ` +
      `alert within ${plan.policy.alertWithinDays}d)`,
  ];
  for (const lane of plan.lanes) {
    const state = renewedIds.has(lane.sampleId)
      ? "renewed"
      : lane.action === "renew"
        ? lane.lapsed
          ? "renewal due (LAPSED)"
          : "renewal due"
        : "current";
    lines.push(
      `  ${lane.sampleId}: ${state}; observed ${lane.observedAt}; ` +
        `policy expiry ${lane.policyExpiresAt} (${roundDays(lane.daysRemaining)}d); via ${lane.command}`,
    );
  }
  return lines.join("\n");
}

/**
 * The 14-day early warning, rendered once so the workflow annotation, the job
 * summary, and local output cannot drift apart.
 */
export function renewalAlertMessage(lane, policy = SKIP_ATTESTATION_RENEWAL_POLICY) {
  return lane.lapsed
    ? `${lane.sampleId}: skip attestation LAPSED on ${lane.policyExpiresAt} (observed ${lane.observedAt}). ` +
        "Every sample publication contract gate is failing until it is re-observed: " +
        `run \`${lane.command}\` and install the result at ${lane.evidencePath}.`
    : `${lane.sampleId}: skip attestation expires ${lane.policyExpiresAt} ` +
        `(${roundDays(lane.daysRemaining)} days), inside the ${policy.alertWithinDays}-day alert window. ` +
        "Automated renewal has not re-observed it; when it lapses every open PR fails " +
        `"Verify sample publication contract". Producer: \`${lane.command}\`.`;
}
