import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBuildEnvironment } from "../scripts/lib/fixture-build-environment.mjs";
import {
  SKIP_ATTESTATION_RENEWAL_POLICY,
  assertRenewedAttestation,
  canonicalAttestation,
  evidenceSchemaReference,
  planSkipAttestationRenewal,
  serializeAttestation,
  skipAttestationLanes,
} from "../scripts/lib/skip-attestation-renewal.mjs";
import {
  buildBrowserArtifactManifest,
  classifyConfigurationName,
  collectQualificationEvidence,
  compareReleases,
  extractSampleConfiguration,
  generateCiSelection,
  generateGoldenJourneyVisualEvidence,
  generateSiteProjection,
  generatedOutputDrift,
  generatedOutputs,
  inspectSampleConfiguration,
  isRunnableRootExampleDirectory,
  migrateCatalogV1ToV2,
  parseJsonDocument,
  refreshOverlayLiveExpiry,
  reviewedLiveProducer,
  validateCatalog,
  validateCiSelection,
  validateEvidenceEnvelope,
  validateFixtureBuildHarnessSource,
  validateFixtureBuildHarnesses,
  validateGeneratedOutputDrift,
  validateGoldenJourneyVisualEvidence,
  validateLiveEvidenceProducer,
  validateSiteProjection,
  verifyBrowserArtifactManifest,
} from "../scripts/sample-contract.mjs";
import type { GoldenJourneyVisualEvidence } from "../scripts/sample-contract.mjs";

// validateCatalog and the golden-journey visual-evidence helpers below read
// the real samples/evidence tree (receipts, screenshots, live evidence) for
// the now genuinely qualified First Map, Imagery and Terrain, Universal
// Service Explorer, and ArcGIS Migration Workbench journeys. That real I/O
// regularly exceeds vitest's 5s default under full-suite contention; the
// default empty-evidence case was effectively instant, so this was never
// exercised before. Raise this file's timeout rather than the global
// default; four qualified journeys' worth of receipts (up from one) need
// more headroom than the original single-journey budget.
vi.setConfig({ testTimeout: 40_000 });

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const execFileAsync = promisify(execFile);

// Look-ahead clock lane (honua-io/honua-sdk-js#1079).
//
// This suite builds fixtures from committed evidence files and validates them
// against a clock, so a fixture can be valid today and invalid next month with
// no code change at all -- the calendar alone wedges trunk. That has happened
// twice (#738, then #1078, which found a fixture that synthesized an
// `executed` lane from a committed *skip* attestation and inherited its
// observedAt, so it silently violated the 31-day executed window once the
// attestation passed 24 days old).
//
// `HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS` advances *this suite's* validation
// clock -- never the system clock, never another suite -- so those fixtures are
// exercised weeks past their real boundary:
//
//   npm run samples:contract:lookahead      # +35d and +95d, plus a bisect on failure
//   HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS=35 npx vitest run test/sample-contract.test.ts
//
// +35d crosses the 31-day executed window and +95d crosses the 90-day
// non-executed window, which are the two policy horizons in
// `samples/contract/v2/migrations/catalog.v1-to-v2.json`.
//
// Two rules keep the lane honest, and both are pinned by tests below:
//
//  1. Anything this suite synthesizes from a committed attestation must be
//     re-dated to `validationTime.now`. Use `readAttestationSeed`; it does this
//     for you. A hand-rolled `readJson` of a committed attestation that then
//     claims a different status is exactly the #1078 bomb.
//  2. Committed evidence that is merely due for renewal inside the look-ahead
//     window is the renewal automation's job (#979), not a contract violation.
//     `validationTime` therefore pins `evidenceCurrencyNow` to the real clock,
//     so the shifted lane keeps every policy invariant live while asking "is
//     this committed attestation still current?" at the real instant. Without
//     that split the lane would fail on every run past the shortest committed
//     window and become a standing false alarm.
const lookAheadDays = Number.parseFloat(process.env.HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS ?? "0");
if (!Number.isFinite(lookAheadDays) || lookAheadDays < 0) {
  throw new Error(
    `HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS must be a non-negative number of days, received "${process.env.HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS}"`,
  );
}
const realTimeNow = new Date().toISOString();
const validationTime = {
  now: new Date(Date.parse(realTimeNow) + lookAheadDays * 24 * 60 * 60 * 1000).toISOString(),
  evidenceCurrencyNow: realTimeNow,
};

// Loads a committed live-evidence attestation to seed a synthetic lane, with
// its observation re-dated to the validation clock.
//
// Committed attestations age in place between re-observations; a synthetic lane
// built from one is held to whatever window its *claimed* status carries. Seed a
// synthetic `executed` lane (31-day window) from a committed `skipped` one
// (90-day window) without re-dating and the fixture quietly violates policy once
// the attestation is older than the difference -- `validateCatalog` then reports
// an expiry violation instead of the assertion the test is about, on a date
// nobody chose. Re-dating makes the fixture's age a property of the test run
// rather than of when the attestation was last renewed.
const readAttestationSeed = async (path: string, clock: { now: string } = validationTime) => {
  const seed = await readJson(path);
  seed.observedAt = clock.now;
  if (seed.provenance) {
    seed.provenance.observedAt = clock.now;
  }
  return seed;
};
const goldenJourneyIds = [
  "first-map",
  "service-explorer",
  "planning-permitting",
  "incident-operations",
  "imagery-terrain",
  "cloud-native-analysis",
  "arcgis-migration",
];
const visualSemanticGates = [
  "packed-build",
  "browser",
  "accessibility",
  "console",
  "responsive",
  "screenshot",
  "performance",
  "fixture",
  "live",
] as const;

function visualEvidenceAdversary(
  journeyId: string,
  sampleId: string,
  observedAt: string,
  expiresAt: string,
): GoldenJourneyVisualEvidence["qualifiedGoldenJourneys"][number] {
  const runRoot = `samples/evidence/${sampleId}/runs/11111111-1111-4111-8111-111111111111`;
  const screenshot = (variant: "desktop" | "mobile", width: number, height: number) => ({
    variant,
    projectName: "chromium",
    browserName: "chromium",
    sourcePath: `${runRoot}/artifacts/screenshot-${variant}.png`,
    mediaType: "image/png",
    viewport: { width, height },
    bytes: 1,
    sha256: "a".repeat(64),
    reproducibility: {
      captureCount: 2,
      comparison: "byte-identical",
      repeatSourcePath: `${runRoot}/artifacts/screenshot-${variant}-repeat.png`,
      repeatBytes: 1,
      repeatSha256: "a".repeat(64),
    },
  });
  return {
    journeyId,
    sampleId,
    source: {
      repository: "honua-io/honua-sdk-js",
      // Derived from the sample so two synthetic entries never claim one
      // executable tree; duplicate source identities are their own admission
      // failure (honua-io/honua-sdk-js#550).
      path: `examples/${sampleId}`,
      revision: "b".repeat(40),
      evidenceNeutralSha256: "c".repeat(64),
    },
    runtime: {
      playwrightVersion: "1.58.0",
      projectName: "chromium",
      browserName: "chromium",
      browserVersion: "123.0.0.0",
      platform: "linux",
      architecture: "x64",
    },
    observedAt,
    expiresAt,
    screenshots: [screenshot("desktop", 1280, 720), screenshot("mobile", 390, 844)],
    semanticEvidence: visualSemanticGates.map((gate) => ({
      gate,
      sdkMode: gate === "packed-build" ? "packed" : "source",
      receiptPath: `samples/evidence/${sampleId}/receipts/${gate}.v1.json`,
      receiptSha256: "d".repeat(64),
      runRoot,
      observedAt,
      expiresAt,
      reportKind: `${gate}-report`,
      reportPath: `${runRoot}/artifacts/${gate}.json`,
      reportBytes: 1,
      reportSha256: "e".repeat(64),
    })),
    liveEvidence: {
      mode: "public-live",
      status: "executed",
      observedAt,
      expiresAt,
      evidencePath: `${runRoot}/artifacts/live-evidence.json`,
      provenance: { state: "live", observedAt, attribution: "Fixture adversary" },
      semantics: { operation: "query", outcome: "passed", itemCount: 1, assertions: ["bounded"] },
      timing: { totalMs: 1 },
      degradation: { state: "none", reasons: [] },
    },
  };
}

describe("sample publication contract", () => {
  it("discovers every runnable example and reserves exactly seven golden journeys", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    expect(catalog.configuration.browserSecretPolicy).toMatch(/^Approved browser configuration/);
    const packageJson = await readJson("package.json");

    await expect(validateCatalog(catalog, packageJson, validationTime)).resolves.toBeUndefined();
    expect(catalog.samples).toHaveLength(35);
    expect(
      catalog.samples.filter((sample: { sourceKind: string }) => sample.sourceKind === "root-example"),
    ).toHaveLength(31);
    expect(
      catalog.samples.filter((sample: { sourceKind: string }) => sample.sourceKind === "docs-example"),
    ).toHaveLength(4);
    expect(catalog.goldenJourneys.map((journey: { id: string }) => journey.id)).toEqual(goldenJourneyIds);
    expect(catalog.samples.filter((sample: { track: string }) => sample.track === "golden")).toHaveLength(4);
    expect(catalog.goldenJourneys.filter((journey: { status: string }) => journey.status === "qualified")).toHaveLength(
      4,
    );
    expect(catalog.goldenJourneys.filter((journey: { status: string }) => journey.status === "planned")).toHaveLength(
      3,
    );
    expect(catalog.samples.find((sample: { id: string }) => sample.id === "cesium-route-playback")).toMatchObject({
      lifecycle: { state: "rework", targetRelease: "0.2.0-beta.0" },
      data: { configurationStatus: "legacy-unsafe", config: [] },
    });
    expect(
      catalog.samples.find((sample: { id: string }) => sample.id === "planning-permitting-workbench"),
    ).toMatchObject({
      track: "lab",
      journeyId: "planning-permitting",
      lifecycle: { state: "active" },
      renderers: ["none"],
      evidence: {
        live: {
          mode: "public-live",
          status: "planned",
          commands: ["npm run evidence:planning:live"],
        },
      },
    });
    expect(catalog.samples.find((sample: { id: string }) => sample.id === "edit-workflow-demo")).toMatchObject({
      track: "recipe",
      lifecycle: {
        state: "replace",
        replacement: { kind: "journey", id: "planning-permitting" },
      },
    });
    expect(catalog.samples.find((sample: { id: string }) => sample.id === "geocoding-quickstart")).toMatchObject({
      track: "recipe",
      lifecycle: { state: "active" },
      data: { mode: "fixture", authMode: "none", configurationStatus: "not-required", config: [] },
    });
    expect(catalog.samples.find((sample: { id: string }) => sample.id === "sketch-editing")).toMatchObject({
      track: "recipe",
      lifecycle: { state: "active" },
    });
    expect(catalog.siteMappings).toHaveLength(21);
  });

  it("accepts only the reviewed bounded Coverage and WCS browser command", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const packageJson = await readJson("package.json");
    expect(packageJson.scripts["test:playwright:coverages-wcs"]).toBe(
      "vite build --config examples/coverages-wcs-basic/vite.config.ts && playwright test test/playwright/coverages-wcs-basic.spec.mjs",
    );
    const commandPolicyOptions = { ...validationTime, relaxDerivedArtifacts: true, verifyCheckout: false };
    await expect(validateCatalog(catalog, packageJson, commandPolicyOptions)).resolves.toBeUndefined();

    const unboundedPackage = structuredClone(packageJson);
    unboundedPackage.scripts["test:playwright:coverages-wcs"] =
      `${packageJson.scripts["test:playwright:coverages-wcs"]} && node -e "process.exit(0)"`;
    await expect(validateCatalog(catalog, unboundedPackage, commandPolicyOptions)).rejects.toThrow(
      "coverages-wcs-basic: automatic validation command is not in the reviewed bounded registry: npm run test:playwright:coverages-wcs",
    );
  });

  it("replays the reviewed v1 migration without semantic drift", async () => {
    const v1 = await readJson("samples/catalog.v1.json");
    const migration = await readJson("samples/contract/v2/migrations/catalog.v1-to-v2.json");
    const canonical = await readJson("samples/catalog.v2.json");

    const migrated = await migrateCatalogV1ToV2(v1, migration);
    expect(migrated).toEqual(canonical);
    expect(migrated.samples.find((sample) => sample.id === "migration-workbench")).toMatchObject({
      track: "golden",
      journeyId: "arcgis-migration",
      supportTier: "supported",
      lifecycle: { state: "active" },
      data: { configurationStatus: "not-required", config: [] },
      validation: [
        "npm run demo:migration-workbench:typecheck",
        "npm run demo:migration-workbench:build",
        "npm run test:playwright:migration-workbench",
      ],
      evidence: {
        fixture: {
          status: "executed",
          commands: ["npm run demo:migration-workbench:mock"],
        },
        live: {
          mode: "demo-live",
          status: "executed",
          commands: ["npm run evidence:migration-workbench:live"],
        },
      },
    });

    delete migration.sampleOverrides[Object.keys(migration.sampleOverrides)[0]];
    await expect(migrateCatalogV1ToV2(v1, migration)).rejects.toThrow(
      "migration overrides must cover every v1 sample exactly",
    );
  });

  it("moves a resealed golden sample's overlay live-evidence expiry to observedAt plus the policy window", async () => {
    // Resealing renews samples/evidence/<id>/live.v1.json's observedAt, but
    // samples/catalog.v2.json's live.expiresAt is projected from this
    // migration overlay's sampleOverrides[id].live.expiresAt literal, which
    // reseal alone never touches -- the class of bug behind
    // honua-io/honua-sdk-js#788 (receipts renew forever while the catalog's
    // own expiry claim silently drifts toward, and eventually past, "now").
    // refreshOverlayLiveExpiry is the fix: it re-derives that literal from
    // the sample's own fresh evidence every time it is called, so a stale
    // catalog expiry sitting alongside fresh receipts cannot arise as long
    // as every reseal calls it.
    // Read the real migration overlay for its reviewed policy config and
    // schema shape, but build an isolated sampleOverrides fixture for the
    // sample under test rather than asserting against whatever the current
    // repo's real maplibre-quickstart override happens to hold: the repo's
    // evidence provenance (which reseal last touched which golden sample,
    // and when) is allowed to vary -- e.g. a merge that reseals some golden
    // samples and not others -- and this invariant must hold under any such
    // combination, not just the one this test happened to be written
    // against. A deliberately unrelated, far-past placeholder expiresAt
    // guarantees "before" can never coincidentally equal "after" (which is
    // always freshly derived from the real evidence's own observedAt), no
    // matter what the real overlay's current value is.
    const migration = await readJson("samples/contract/v2/migrations/catalog.v1-to-v2.json");
    const evidence = await readJson("samples/evidence/maplibre-quickstart/live.v1.json");
    const stalePlaceholderExpiresAt = "2000-01-01T00:00:00.000Z";
    const staleOverlay = structuredClone(migration);
    staleOverlay.sampleOverrides["maplibre-quickstart"].live.expiresAt = stalePlaceholderExpiresAt;

    const refreshed = await refreshOverlayLiveExpiry(staleOverlay, ["maplibre-quickstart"]);

    expect(refreshed).toEqual([
      {
        sampleId: "maplibre-quickstart",
        observedAt: evidence.observedAt,
        previousExpiresAt: stalePlaceholderExpiresAt,
        expiresAt: staleOverlay.sampleOverrides["maplibre-quickstart"].live.expiresAt,
      },
    ]);
    const refreshedExpiresAt = staleOverlay.sampleOverrides["maplibre-quickstart"].live.expiresAt;
    // The refreshed literal is no longer identical to the stale placeholder (it moved)...
    expect(refreshedExpiresAt).not.toBe(stalePlaceholderExpiresAt);
    // ...and is now derived exactly from this fresh evidence's own
    // observedAt plus the executed-lane policy window, so it can never again
    // disagree with what reseal actually observed.
    const observedAtMs = Date.parse(evidence.observedAt);
    const expectedExpiresAtMs =
      observedAtMs + migration.configuration.evidenceExpiry.executedMaxDays * 24 * 60 * 60 * 1000;
    expect(Date.parse(refreshedExpiresAt)).toBe(expectedExpiresAtMs);
    // The stale-expiry-alongside-fresh-evidence shape validateCatalog would
    // have rejected (or worse, silently accepted right up until it lapsed)
    // is exactly what this proves is no longer reachable through this
    // helper: the refreshed value is always derived from the real
    // observation, never from whenever the catalog literal happened to be
    // hand-set. Compare against observedAt (not Date.now()) so this holds
    // regardless of how fresh the checked-in fixture evidence itself is.
    expect(Date.parse(refreshedExpiresAt) - observedAtMs).toBe(
      migration.configuration.evidenceExpiry.executedMaxDays * 24 * 60 * 60 * 1000,
    );

    await expect(refreshOverlayLiveExpiry(structuredClone(migration), ["not-a-real-sample"])).rejects.toThrow(
      "unknown sample override",
    );
    const nonLiveOverlay = structuredClone(migration);
    nonLiveOverlay.sampleOverrides["oauth-signin"].live.status = "planned";
    await expect(refreshOverlayLiveExpiry(nonLiveOverlay, ["oauth-signin"])).rejects.toThrow("is not evidence-bound");
  });

  // honua-io/honua-sdk-js#810. A skip-attested live lane is the harder half of
  // #788's bug class: nothing reseals a skip attestation, so its observedAt
  // never moves, and the catalog literal projected from it was hand-set at
  // qualification time -- the incident dashboard's was 14 days against a
  // 90-day non-executed policy, so it lapsed 76 days before the observation it
  // describes had to. When it lapsed, validateCatalog's wall-clock expiry check
  // (deliberately NOT relaxed by HONUA_DERIVED_ARTIFACTS_RELAX) failed every
  // `samples:verify` on trunk AND every reseal pass inside the regeneration
  // workflow -- including passes targeting entirely unrelated samples -- so the
  // automation that exists to prevent the lapse could not run at all.
  //
  // The contract these two cases pin: a skip lane is refreshable by the
  // automation path from its own real observation, and once even that
  // observation has aged past its full policy window the refresh refuses
  // honestly (naming the sample and the remedy) instead of writing an
  // already-lapsed literal that resurfaces later as an opaque catalog error.
  it("refreshes a skip-attested lane from its own observation and refuses once that observation outlives its policy window", async () => {
    const migration = await readJson("samples/contract/v2/migrations/catalog.v1-to-v2.json");
    const skipLaneIds = Object.entries(migration.sampleOverrides)
      .filter(([, override]: [string, any]) => override.live?.status === "skipped")
      .map(([sampleId]) => sampleId)
      .sort();
    expect(skipLaneIds.length).toBeGreaterThan(0);
    const nonExecutedWindowMs = migration.configuration.evidenceExpiry.nonExecutedMaxDays * 24 * 60 * 60 * 1000;

    // Every skip lane refreshes to exactly its attestation's own observedAt
    // plus the non-executed window -- no lane depends on a reseal having run,
    // which is what makes refreshing them safe before the first reseal pass.
    for (const sampleId of skipLaneIds) {
      const overlay = structuredClone(migration);
      const lane = overlay.sampleOverrides[sampleId].live;
      lane.expiresAt = "2000-01-01T00:00:00.000Z";
      const evidence = await readJson(lane.evidencePath);
      expect(evidence.status).toBe("skipped");

      const refreshed = await refreshOverlayLiveExpiry(overlay, [sampleId]);

      expect(refreshed).toEqual([
        {
          sampleId,
          observedAt: evidence.observedAt,
          previousExpiresAt: "2000-01-01T00:00:00.000Z",
          expiresAt: lane.expiresAt,
        },
      ]);
      expect(Date.parse(lane.expiresAt)).toBe(Date.parse(evidence.observedAt) + nonExecutedWindowMs);
      // No explicit "is in the future" assertion is needed: the refresh above
      // now refuses outright once an observation has outlived its window, so
      // reaching this line at all means the lane is still honestly refreshable.
      // A skip attestation that ages out therefore fails here with the
      // actionable "re-observe it" message rather than at some later gate.
    }

    // An observation older than the whole non-executed window cannot be healed
    // by recomputing the literal, and the refresh must say so rather than
    // writing a past expiry that fails later as a catalog-projection error.
    const lapsedSampleId = skipLaneIds[0];
    const lapsedOverlay = structuredClone(migration);
    const lapsedEvidence = await readJson(lapsedOverlay.sampleOverrides[lapsedSampleId].live.evidencePath);
    const beyondWindowNow = new Date(Date.parse(lapsedEvidence.observedAt) + nonExecutedWindowMs + 1).toISOString();
    const previousLapsedExpiresAt = lapsedOverlay.sampleOverrides[lapsedSampleId].live.expiresAt;
    await expect(refreshOverlayLiveExpiry(lapsedOverlay, [lapsedSampleId], { now: beyondWindowNow })).rejects.toThrow(
      /is older than its .* policy window/,
    );
    await expect(refreshOverlayLiveExpiry(lapsedOverlay, [lapsedSampleId], { now: beyondWindowNow })).rejects.toThrow(
      "re-run this lane's evidence producer to re-observe it",
    );
    // The refusal leaves the overlay untouched: no half-refreshed literal to
    // commit, and no already-lapsed value projected into the catalog.
    expect(lapsedOverlay.sampleOverrides[lapsedSampleId].live.expiresAt).toBe(previousLapsedExpiresAt);
  });

  // The recurrence half of #810: refreshability is only useful if the
  // regeneration workflow actually exercises it for these lanes, and does so
  // before the first reseal pass -- the pass a lapsed expiry would otherwise
  // fail. Pinning the step ordering and the covered sample set here means
  // adding a skip-attested sample without wiring it into the refresh (which is
  // how the incident dashboard was left out) fails this test instead of
  // silently arming the next trunk-wide outage.
  it("refreshes every skip-attested lane's catalog expiry before the regeneration workflow's first reseal pass", async () => {
    const migration = await readJson("samples/contract/v2/migrations/catalog.v1-to-v2.json");
    const skipLaneIds = Object.entries(migration.sampleOverrides)
      .filter(([, override]: [string, any]) => override.live?.status === "skipped")
      .map(([sampleId]) => sampleId)
      .sort();
    const workflow = await readFile(".github/workflows/regenerate-derived-artifacts.yml", "utf8");

    const refreshIndex = workflow.indexOf("- name: Refresh catalog live-evidence expiry for skip-attested lanes");
    const commitIndex = workflow.indexOf("- name: Stage and commit refreshed skip-attestation catalog locally");
    const passOneIndex = workflow.indexOf("- name: Reseal sample evidence (pass one");
    expect(refreshIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(refreshIndex);
    // Committed before pass one, because every reseal pass requires a clean
    // checkout of the evidence-neutral roots the catalog and overlay live in.
    expect(passOneIndex).toBeGreaterThan(commitIndex);

    const refreshStep = workflow.slice(refreshIndex, commitIndex);
    const sampleArgument = /samples:refresh-live-expiry -- --sample ([\w,-]+)/.exec(refreshStep);
    expect(sampleArgument).not.toBeNull();
    expect(sampleArgument![1].split(",").sort()).toEqual(skipLaneIds);
    // migrate-v1 projects the refreshed overlay into samples/catalog.v2.json
    // and write-ci-selection reprojects the dist copy of the same literal;
    // without both, pass one still reads the lapsed value.
    const bootstrapIds = ["imagery-cog-quickstart", "maplibre-quickstart", "migration-workbench", "service-explorer"];
    expect(refreshStep).toContain(`npm run samples:migrate:v1 -- --qualification-bootstrap ${bootstrapIds.join(",")}`);
    expect(refreshStep).toContain("npm run samples:write-ci-selection");

    const goldenRefreshIndex = workflow.indexOf(
      "- name: Refresh catalog live-evidence expiry for resealed golden lanes",
    );
    const recordIndex = workflow.indexOf("- name: Record established release-matrix lanes");
    const passTwoIndex = workflow.indexOf("- name: Reseal sample evidence (pass two");
    expect(goldenRefreshIndex).toBeGreaterThan(passOneIndex);
    expect(recordIndex).toBeGreaterThan(goldenRefreshIndex);
    expect(passTwoIndex).toBeGreaterThan(recordIndex);
    expect(workflow.slice(goldenRefreshIndex, recordIndex)).toContain(
      `npm run samples:migrate:v1 -- --qualification-bootstrap ${bootstrapIds.join(",")}`,
    );
    const catalogCommitStep = workflow.slice(recordIndex, passTwoIndex);
    expect(catalogCommitStep).toContain('release_matrix_lanes="samples/contract/v2/release-matrix-lanes.v1.json"');
    expect(catalogCommitStep).toContain('git ls-files --error-unmatch "$release_matrix_lanes"');
    expect(catalogCommitStep).toContain('git add -A -- "$release_matrix_lanes"');
  });

  // honua-io/honua-sdk-js#972. Everything above keeps a skip attestation's
  // catalog *projection* honest; none of it renews the observation the
  // projection describes. A skip attestation is a dated observation with a
  // 90-day ceiling and nothing re-observed it, so every ~90 days one lapsed,
  // validateCatalog's wall-clock check failed the whole catalog, and every open
  // PR went red on "Verify sample publication contract" -- including the
  // regeneration workflow's own reseal passes, which is what made each outage
  // self-sustaining. The tests below pin the renewal contract that closes it.
  describe("skip-attestation renewal", () => {
    const nonExecutedMaxDays = 90;
    const observedAt = "2026-01-01T00:00:00.000Z";
    const laneEvidencePath = "test-results/skip-attestation-renewal/live-skipped.v1.json";
    const dayMs = 24 * 60 * 60 * 1000;
    // now = observedAt + `age` days, i.e. `90 - age` days of policy window left.
    const atAge = (days: number) => new Date(Date.parse(observedAt) + days * dayMs).toISOString();

    const attestation = (overrides: Record<string, unknown> = {}) => ({
      $schema: "../../../samples/contract/v1/schemas/sample-evidence.schema.json",
      format: "honua.sdk.sample-evidence.v1",
      schemaVersion: 1,
      sampleId: "fixture-skip-lane",
      lane: "live",
      status: "skipped",
      reason: "No live configuration was supplied; no fixture data was substituted.",
      observedAt,
      authMode: "anonymous",
      sdk: { package: "@honua/sdk-js", version: "0.0.0", gitCommit: null },
      source: {
        provider: "fixture",
        identity: "fixture-source",
        endpoint: null,
        deploymentVersion: null,
        dataVersion: null,
      },
      provenance: null,
      semantics: { operation: "fixture-journey", outcome: null, itemCount: null, assertions: [] },
      timing: { totalMs: null, firstSuccessfulInteractionMs: null },
      degradation: { state: "unavailable", reasons: ["live-config-unavailable"] },
      artifacts: [],
      ...overrides,
    });

    const fixtureMigration = () => ({
      configuration: { evidenceExpiry: { executedMaxDays: 31, nonExecutedMaxDays, maxFutureSkewSeconds: 300 } },
      sampleOverrides: {
        "fixture-skip-lane": {
          live: {
            mode: "unavailable",
            targetMode: "public-live",
            status: "skipped",
            evidencePath: laneEvidencePath,
            expiresAt: "2026-04-01T00:00:00.000Z",
          },
        },
        "fixture-executed-lane": {
          live: { mode: "public-live", status: "executed", evidencePath: "samples/evidence/x/live.v1.json" },
        },
      },
    });

    const fixtureCatalogV1 = () => ({
      samples: [
        {
          id: "fixture-skip-lane",
          lanes: { live: { status: "skipped", commands: ["npm run demo:spatial-analytics:live-evidence"] } },
        },
      ],
    });

    const planFixture = (now: string, policy?: Record<string, number>) =>
      planSkipAttestationRenewal({
        migration: fixtureMigration(),
        catalogV1: fixtureCatalogV1(),
        now,
        ...(policy ? { policy } : {}),
        readEvidence: async () => attestation(),
      });

    // The core time-travel proof: an attestation observed at T is re-observed
    // strictly BEFORE its policy horizon at T+90d, with a full renewal window
    // of margin -- not at the boundary, and never after it. The 6-hourly
    // regeneration cadence means the first run inside the window renews, so the
    // realised margin is the window minus at most six hours.
    it("renews a near-lapse lane before the policy boundary and holds while it is still current", async () => {
      const { renewWithinDays, alertWithinDays } = SKIP_ATTESTATION_RENEWAL_POLICY;

      // Comfortably current: one day before the renewal window opens.
      const current = await planFixture(atAge(nonExecutedMaxDays - renewWithinDays - 1));
      expect(current.lanes).toHaveLength(1);
      expect(current.lanes[0]).toMatchObject({
        sampleId: "fixture-skip-lane",
        action: "hold",
        alert: false,
        lapsed: false,
      });
      expect(current.lanes[0].policyExpiresAt).toBe(atAge(nonExecutedMaxDays));
      // The horizon it plans against is the observation's own, not the
      // overlay's hand-set literal (which is projected FROM it moments later).
      expect(current.lanes[0].overlayExpiresAt).toBe("2026-04-01T00:00:00.000Z");

      // The moment the window opens, renewal is due -- with the full window of
      // runway left, so the six-hour cadence has ~120 chances to act.
      const opening = await planFixture(atAge(nonExecutedMaxDays - renewWithinDays));
      expect(opening.lanes[0]).toMatchObject({ action: "renew", alert: false, lapsed: false });
      expect(opening.lanes[0].daysRemaining).toBeCloseTo(renewWithinDays, 6);

      // Deep inside the window but still days from the boundary: still "renew",
      // and now ALSO alerting -- which can only be reached if every renewal
      // opportunity in the preceding two weeks was missed.
      const alerting = await planFixture(atAge(nonExecutedMaxDays - alertWithinDays));
      expect(alerting.lanes[0]).toMatchObject({ action: "renew", alert: true, lapsed: false });

      // Past the boundary: this is the state that wedged trunk. Renewal is
      // still the answer (re-observing always works, unlike refreshing the
      // projected literal, which refuses here by design).
      const lapsed = await planFixture(atAge(nonExecutedMaxDays + 1));
      expect(lapsed.lanes[0]).toMatchObject({ action: "renew", alert: true, lapsed: true });
      expect(lapsed.lanes[0].daysRemaining).toBeLessThan(0);

      // Renewal strictly precedes the alert, so an alert always means "renewal
      // did not happen" and never "renewal is happening normally". Inverting
      // that ordering is rejected rather than silently making the early warning
      // meaningless.
      expect(alertWithinDays).toBeLessThan(renewWithinDays);
      await expect(planFixture(atAge(1), { renewWithinDays: 10, alertWithinDays: 10 })).rejects.toThrow(
        "alertWithinDays must be strictly less than renewWithinDays",
      );
      // A renewal window at or beyond the policy window would mean every lane is
      // permanently "due", which is renewal churn rather than renewal.
      await expect(planFixture(atAge(1), { renewWithinDays: nonExecutedMaxDays, alertWithinDays: 14 })).rejects.toThrow(
        "must be inside the 90-day non-executed policy window",
      );

      // Only skip-attested lanes are planned; an executed lane is renewed by
      // resealing and must not be re-observed by this path.
      expect(current.lanes.map((lane: { sampleId: string }) => lane.sampleId)).toEqual(["fixture-skip-lane"]);
    });

    // The installer half. Producers write to a run-scoped path two directories
    // deep; the committed attestation lives three deep. Getting `$schema` wrong
    // was the most error-prone step of the manual heal, so it is derived from
    // the destination rather than copied.
    it("normalizes a produced attestation onto the committed lane's shape", async () => {
      expect(evidenceSchemaReference("examples/spatial-analytics-workbench/evidence/live-skipped.v1.json")).toBe(
        "../../../samples/contract/v1/schemas/sample-evidence.schema.json",
      );
      expect(evidenceSchemaReference("samples/evidence/maplibre-quickstart/live.v1.json")).toBe(
        "../../contract/v1/schemas/sample-evidence.schema.json",
      );

      // A producer that spreads `source`/`reason` last (the AI builder does)
      // still lands in schema order, so a renewal's diff is the fields that
      // changed and not a reshuffle of the whole file.
      const produced = attestation();
      const shuffled: Record<string, unknown> = { ...produced };
      delete shuffled.$schema;
      delete shuffled.source;
      delete shuffled.reason;
      shuffled.source = produced.source;
      shuffled.reason = produced.reason;
      const canonical = canonicalAttestation(shuffled, laneEvidencePath);
      expect(Object.keys(canonical)).toEqual(Object.keys(produced));
      expect(canonical.$schema).toBe(evidenceSchemaReference(laneEvidencePath));
      expect(serializeAttestation(canonical).endsWith("}\n")).toBe(true);
      expect(() => canonicalAttestation({ ...produced, surprise: 1 }, laneEvidencePath)).toThrow(
        "unknown properties: surprise",
      );

      // Every real committed attestation already matches what a renewal would
      // write, so renewal changes the observation and nothing else.
      const migration = await readJson("samples/contract/v2/migrations/catalog.v1-to-v2.json");
      const catalogV1 = await readJson("samples/catalog.v1.json");
      for (const lane of skipAttestationLanes(migration, catalogV1)) {
        const committed = await readJson(lane.evidencePath);
        expect(committed.$schema).toBe(evidenceSchemaReference(lane.evidencePath));
        expect(Object.keys(canonicalAttestation(committed, lane.evidencePath))).toEqual(Object.keys(committed));
      }
    });

    // Renewal may re-date a reviewed attestation; it may never change what the
    // attestation claims. A scheduled job with commit authority that could
    // publish a different classification would be strictly worse than the lapse
    // it replaces.
    it("refuses a renewal that changes what the lane claims", () => {
      const lane = { sampleId: "fixture-skip-lane", declaredStatus: "skipped", evidencePath: laneEvidencePath };
      const previous = attestation();
      const fresh = attestation({ observedAt: atAge(60), reason: "A different, still-unavailable explanation." });

      // Re-dating with a changed reason is the normal case: `reason` is prose
      // about what THIS observation found, and re-observing may honestly find a
      // different unavailability.
      expect(assertRenewedAttestation(fresh, { lane, previous })).toBe(fresh);

      expect(() =>
        assertRenewedAttestation(attestation({ observedAt: atAge(60), status: "executed" }), { lane, previous }),
      ).toThrow("needs human review rather than automated renewal");
      expect(() =>
        assertRenewedAttestation(
          attestation({ observedAt: atAge(60), degradation: { state: "degraded", reasons: [] } }),
          { lane, previous },
        ),
      ).toThrow("degradation state");
      expect(() =>
        assertRenewedAttestation(
          attestation({
            observedAt: atAge(60),
            semantics: { operation: "some-other-journey", outcome: null, itemCount: null, assertions: [] },
          }),
          { lane, previous },
        ),
      ).toThrow("describes journey");
      // A producer that reported a stale or identical timestamp has not
      // re-observed anything, so it cannot renew anything either.
      expect(() => assertRenewedAttestation(attestation(), { lane, previous })).toThrow(
        "does not follow the committed",
      );
    });

    // Dry run against a fixture catalog, through the real CLI: this is the
    // rehearsal path an operator (or a reviewer of this automation) can use to
    // see exactly which lanes a given date would re-observe, without touching a
    // single committed attestation.
    it("reports, but does not perform, renewals in dry-run mode against a fixture catalog", async () => {
      const fixtureRoot = "test-results/skip-attestation-renewal";
      const migrationPath = `${fixtureRoot}/catalog.v1-to-v2.json`;
      const catalogPath = `${fixtureRoot}/catalog.v1.json`;
      try {
        await mkdir(fixtureRoot, { recursive: true });
        await writeFile(migrationPath, JSON.stringify(fixtureMigration(), null, 2), "utf8");
        await writeFile(catalogPath, JSON.stringify(fixtureCatalogV1(), null, 2), "utf8");
        await writeFile(laneEvidencePath, `${JSON.stringify(attestation(), null, 2)}\n`, "utf8");
        const before = await readFile(laneEvidencePath, "utf8");

        const { stdout } = await execFileAsync(process.execPath, [
          "scripts/renew-skip-attestations.mjs",
          "--dry-run",
          "--json",
          "--now",
          atAge(nonExecutedMaxDays - 3),
          "--migration",
          migrationPath,
          "--catalog-v1",
          catalogPath,
        ]);
        const report = JSON.parse(stdout);
        expect(report.dryRun).toBe(true);
        expect(report.renewals).toEqual([]);
        expect(report.lanes).toHaveLength(1);
        expect(report.lanes[0]).toMatchObject({
          sampleId: "fixture-skip-lane",
          action: "renew",
          alert: true,
          lapsed: false,
          command: "npm run demo:spatial-analytics:live-evidence",
        });
        // The rehearsal wrote nothing.
        expect(await readFile(laneEvidencePath, "utf8")).toBe(before);

        // ...and a fixture can only ever be a rehearsal: pointing the *writing*
        // mode at non-reviewed contract inputs is refused, so nothing a test or
        // a stray file lays down can steer what the scheduled job commits.
        await expect(
          execFileAsync(process.execPath, [
            "scripts/renew-skip-attestations.mjs",
            "--migration",
            migrationPath,
            "--catalog-v1",
            catalogPath,
          ]),
        ).rejects.toThrow("only honoured with --dry-run");
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });

    // Renewal against the repository's own contract: every skip-attested lane
    // is discovered (by declared shape, not a hardcoded list), bound to the
    // producer the published catalog names, and currently far from its horizon.
    it("plans every real skip-attested lane against its reviewed producer", async () => {
      const migration = await readJson("samples/contract/v2/migrations/catalog.v1-to-v2.json");
      const catalogV1 = await readJson("samples/catalog.v1.json");
      const catalog = await readJson("samples/catalog.v2.json");
      const plan = await planSkipAttestationRenewal({ migration, catalogV1 });

      const overlaySkipIds = Object.entries(migration.sampleOverrides)
        .filter(([, override]: [string, any]) => override.live?.status === "skipped")
        .map(([sampleId]) => sampleId)
        .sort();
      expect(plan.lanes.map((lane: { sampleId: string }) => lane.sampleId)).toEqual(overlaySkipIds);
      expect(plan.nonExecutedMaxDays).toBe(migration.configuration.evidenceExpiry.nonExecutedMaxDays);

      for (const lane of plan.lanes) {
        const sample = catalog.samples.find((candidate: { id: string }) => candidate.id === lane.sampleId);
        // The command this plan would run is the one the published catalog
        // names as the lane's reviewed producer -- never a second definition.
        expect(sample.evidence.live.commands).toEqual([lane.command]);
        expect(sample.evidence.live.evidencePath).toBe(lane.evidencePath);
        expect(sample.evidence.live.mode).toBe("unavailable");
        // Every lane resolves to a generator that exists and can be executed
        // directly, without the npm wrapper's build steps: those exist only for
        // the executed branch an `unavailable` lane never takes.
        const producer = reviewedLiveProducer(lane.command);
        expect(producer).toBeTruthy();
        await expect(readFile(producer!.generatorPath, "utf8")).resolves.toBeTruthy();
        // Nothing in the repository is currently near its horizon; if this
        // fails, renewal has stopped working and a lapse is imminent.
        expect(lane.daysRemaining).toBeGreaterThan(SKIP_ATTESTATION_RENEWAL_POLICY.alertWithinDays);
      }
    });

    // The recurrence half, mirroring the #810 ordering test above: renewal is
    // only useful if the automation actually runs it, before the step that
    // depends on it, and can carry its output all the way through the protected
    // automation-PR path.
    it("wires renewal into the regeneration workflow ahead of the expiry refresh it feeds", async () => {
      const migration = await readJson("samples/contract/v2/migrations/catalog.v1-to-v2.json");
      const catalogV1 = await readJson("samples/catalog.v1.json");
      const lanes = skipAttestationLanes(migration, catalogV1);
      const workflow = await readFile(".github/workflows/regenerate-derived-artifacts.yml", "utf8");

      const probeIndex = workflow.indexOf("- name: Check skip-attestation renewal window");
      const guardIndex = workflow.indexOf("- name: Skip if tip is a regeneration commit");
      const decisionIndex = workflow.indexOf("- name: Resolve regeneration decision");
      const renewIndex = workflow.indexOf("- name: Renew skip attestations approaching their policy expiry");
      const refreshIndex = workflow.indexOf("- name: Refresh catalog live-evidence expiry for skip-attested lanes");
      const commitIndex = workflow.indexOf("- name: Stage and commit refreshed skip-attestation catalog locally");

      // The probe runs before the loop guard so a due renewal can veto the
      // guard's skip. Without that veto, a quiet trunk (tip already a
      // regeneration merge) skips every scheduled run -- and an attestation
      // ages on wall-clock time, not on merge activity, so renewal would stop
      // happening exactly when nothing else is moving.
      expect(probeIndex).toBeGreaterThan(-1);
      expect(guardIndex).toBeGreaterThan(probeIndex);
      expect(decisionIndex).toBeGreaterThan(guardIndex);
      expect(workflow.slice(decisionIndex, renewIndex)).toContain(
        'if [[ "$GUARD_SKIP" == "true" && "$RENEWAL_DUE" != "true" ]]; then',
      );
      expect(workflow).toContain("RENEWAL_DUE: ${{ steps.renewal.outputs.renewal_due }}");
      // Every gated step consumes the combined decision, so the guard and the
      // renewal veto cannot disagree across the workflow.
      expect(workflow).not.toContain("steps.guard.outputs.skip == 'false'");

      // Re-observation must precede the refresh that reprojects the expiry
      // literal FROM the observation, and both must precede the commit that
      // lands them together.
      expect(renewIndex).toBeGreaterThan(-1);
      expect(refreshIndex).toBeGreaterThan(renewIndex);
      expect(commitIndex).toBeGreaterThan(refreshIndex);
      expect(workflow.slice(renewIndex, refreshIndex)).toContain("npm run samples:renew-skip-attestations");

      // Renewed attestations ride the same commit as the literal derived from
      // them, and the write-enabled job's path allowlist admits them -- without
      // both, a renewal is produced and then silently dropped.
      //
      // release-please.yml carries the mirror of that allowlist: regeneration
      // PRODUCES these commits, the release job CONSUMES them and decides a
      // release may publish from them and move its tag onto them. A path in one
      // and not the other stalls every release (or, in the other direction,
      // would let non-generated content ride into a release), so both are
      // asserted here as well as by test/scripts/release-seal.test.mjs, which
      // pins the two sets equal.
      const commitStep = workflow.slice(
        commitIndex,
        workflow.indexOf("- name: Install the sealed release-matrix receipt"),
      );
      const publishStep = workflow.slice(workflow.indexOf("- name: Validate and publish regeneration commits"));
      const releaseWorkflow = await readFile(".github/workflows/release-please.yml", "utf8");
      for (const lane of lanes) {
        const evidenceDirectory = lane.evidencePath.slice(0, lane.evidencePath.lastIndexOf("/"));
        expect(commitStep).toContain(evidenceDirectory);
        expect(publishStep).toContain(`${evidenceDirectory}/*`);
        expect(releaseWorkflow).toContain(`${evidenceDirectory}/*`);
      }
    });

    // The renewal-window probe runs BEFORE `npm ci`, so its static import graph
    // has to stay free of anything node_modules provides. sample-contract.mjs
    // requires ajv and typescript at module scope, so it is imported
    // dynamically and only on the writing path.
    it("keeps the pre-install renewal probe free of installed dependencies", async () => {
      for (const scriptPath of ["scripts/renew-skip-attestations.mjs", "scripts/lib/skip-attestation-renewal.mjs"]) {
        const source = await readFile(scriptPath, "utf8");
        const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";$/gmu)].map((match) => match[1]);
        expect(specifiers.length).toBeGreaterThan(0);
        for (const specifier of specifiers) {
          expect(specifier.startsWith("node:") || specifier === "./lib/skip-attestation-renewal.mjs").toBe(true);
        }
        expect(source).not.toMatch(/^import\s[^;]*?from\s+"\.\/sample-contract\.mjs";$/mu);
      }
    });
  });

  it("rejects duplicate JSON properties before permissive parsing can hide them", () => {
    expect(() =>
      parseJsonDocument('{"data":{"attribution":"first","attribution":"second"}}', "duplicate-catalog.json"),
    ).toThrow('duplicate-catalog.json:1: duplicate JSON property "attribution"');
    expect(parseJsonDocument('{"data":{"attribution":"single"}}')).toEqual({
      data: { attribution: "single" },
    });
  });

  it("discovers runnable roots without treating reserved infrastructure as a sample", () => {
    expect(isRunnableRootExampleDirectory("maplibre-quickstart", ["index.html"])).toBe(true);
    expect(isRunnableRootExampleDirectory("node-backend-quickstart", ["src/server.ts"])).toBe(true);
    expect(isRunnableRootExampleDirectory("_kit", ["index.html", "package.json"])).toBe(false);
    expect(isRunnableRootExampleDirectory("shared-test-helpers", ["README.md", "tsconfig.json"])).toBe(false);
  });

  it("compares lifecycle targets with full semantic prerelease precedence", () => {
    expect(compareReleases("0.2.0-alpha.9", "0.2.0-beta.0")).toBeLessThan(0);
    expect(compareReleases("0.2.0-beta.0", "0.2.0-beta.0")).toBe(0);
    expect(compareReleases("0.2.0-beta.1", "0.2.0-beta.0")).toBeGreaterThan(0);
    expect(compareReleases("0.2.0", "0.2.0-beta.0")).toBeGreaterThan(0);
  });

  // Reads real qualification evidence for all four golden journeys
  // (collectQualificationEvidence) plus generates golden-journey visual
  // evidence from it; give this test its own headroom rather than
  // inflating the whole file's budget.
  it("generates one shared docs/site taxonomy and an executable CI selection", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const packageJson = await readJson("package.json");
    const projection = generateSiteProjection(catalog, packageJson);
    const ciSelection = generateCiSelection(catalog);
    const qualificationEvidence = await collectQualificationEvidence(catalog);
    const visualEvidence = await generateGoldenJourneyVisualEvidence(catalog, qualificationEvidence);

    await expect(validateSiteProjection(projection)).resolves.toBeUndefined();
    await expect(validateCiSelection(ciSelection)).resolves.toBeUndefined();
    await expect(
      validateGoldenJourneyVisualEvidence(visualEvidence, catalog, qualificationEvidence),
    ).resolves.toBeUndefined();

    expect(projection).toMatchObject({
      format: "honua.site.sdk-sample-projection.v3",
      schemaVersion: 3,
    });
    expect(projection.samples).toHaveLength(35);
    expect(projection.routes).toHaveLength(21);
    expect(projection.goldenJourneys.map((journey: { id: string }) => journey.id)).toEqual(goldenJourneyIds);
    expect(
      projection.goldenJourneys.find((journey: { id: string }) => journey.id === "incident-operations"),
    ).toMatchObject({ status: "planned", candidateSampleId: "realtime-incident-dashboard" });
    expect(ciSelection.samples).toHaveLength(35);
    expect(ciSelection.profiles).toHaveLength(catalog.qualityProfiles.length);
    expect(visualEvidence).toMatchObject({
      format: "honua.sdk.golden-journey-visual-evidence.v1",
      schemaVersion: 1,
      policy: {
        sourceRepository: "honua-io/honua-sdk-js",
        requiredScreenshotVariants: [
          { id: "desktop", viewport: { width: 1280, height: 720 } },
          { id: "mobile", viewport: { width: 390, height: 844 } },
        ],
        screenshotReproducibility: {
          reportFormat: "honua.sdk.sample-screenshot-gate.v3",
          captureCount: 2,
          comparison: "byte-identical",
          scope: "same-page-session",
          runtimeBinding: [
            "playwright-version",
            "project-name",
            "browser-name",
            "browser-version",
            "platform",
            "architecture",
          ],
        },
      },
    });
    // maplibre-quickstart, imagery-cog-quickstart, migration-workbench, and
    // service-explorer are the four real, evidence-backed golden journeys;
    // check their stable identity fields rather than the full volatile
    // object (timestamps, run IDs, screenshot hashes all legitimately
    // change every capture).
    expect(visualEvidence.qualifiedGoldenJourneys).toHaveLength(4);
    expect(
      [...visualEvidence.qualifiedGoldenJourneys].sort((left, right) => left.journeyId.localeCompare(right.journeyId)),
    ).toMatchObject([
      { journeyId: "arcgis-migration", sampleId: "migration-workbench" },
      { journeyId: "first-map", sampleId: "maplibre-quickstart" },
      { journeyId: "imagery-terrain", sampleId: "imagery-cog-quickstart" },
      { journeyId: "service-explorer", sampleId: "service-explorer" },
    ]);
    expect(projection.externalReplacements).toEqual(catalog.externalReplacements);
    expect(JSON.stringify(projection)).not.toContain('"commands"');
    expect(JSON.stringify(projection)).not.toContain("VITE_");
    // Projection v3 carries every release-manifest runnability without
    // changing the frozen v2 consumer contract.
    expect(projection.sampleBundles).toMatchObject({
      format: "honua.sdk.sample-bundles.v2",
      schemaVersion: 2,
      publication: { manifestAsset: "sample-bundles.v2.json" },
    });
    for (const [sampleId, runnability] of [
      ["maplibre-quickstart", "standalone"],
      ["service-explorer", "requires-live-endpoint"],
    ] as const) {
      expect(projection.sampleBundles.published).toContainEqual(expect.objectContaining({ id: sampleId, runnability }));
    }
    for (const sample of catalog.samples) {
      const projected = projection.samples.find((candidate: { id: string }) => candidate.id === sample.id);
      const selected = ciSelection.samples.find((candidate: { id: string }) => candidate.id === sample.id);
      expect(projected).toMatchObject({
        track: sample.track,
        supportTier: sample.supportTier,
        lifecycle: sample.lifecycle,
        validationProfile: sample.validationProfile,
      });
      expect(selected).toMatchObject({
        track: sample.track,
        supportTier: sample.supportTier,
        validationProfile: sample.validationProfile,
      });
      expect(selected?.commandPlan.validation.commands.length).toBeGreaterThan(0);
    }
    const quickstart = ciSelection.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart");
    expect(quickstart?.commandPlan.validation).toMatchObject({ execution: "automatic" });
    expect(quickstart?.commandPlan.validation.commands).not.toContain("npm run demo:quickstart:mock");
    expect(quickstart?.commandPlan.fixtureEvidence).toEqual({
      execution: "orchestrated",
      commands: ["npm run demo:quickstart:mock"],
    });
    expect(quickstart?.commandPlan.liveEvidence).toEqual({
      execution: "scheduled-only",
      commands: ["npm run evidence:first-map:live"],
    });
    const imagery = ciSelection.samples.find((sample: { id: string }) => sample.id === "imagery-cog-quickstart");
    expect(imagery).toMatchObject({ validationProfile: "golden-browser" });
    expect(imagery?.commandPlan.liveEvidence).toEqual({
      execution: "scheduled-only",
      commands: ["npm run evidence:cog:live"],
    });
    const planning = ciSelection.samples.find(
      (sample: { id: string }) => sample.id === "planning-permitting-workbench",
    );
    expect(planning).toMatchObject({
      track: "lab",
      validationProfile: "browser-lab",
      commandPlan: {
        validation: {
          execution: "automatic",
          commands: [
            "npm run demo:planning-workbench:typecheck",
            "npm run demo:planning-workbench:build",
            "npm run test:playwright:planning-workbench",
          ],
        },
        fixtureEvidence: {
          execution: "orchestrated",
          commands: ["npm run demo:planning-workbench:mock"],
        },
        liveEvidence: { execution: "scheduled-only", commands: ["npm run evidence:planning:live"] },
      },
    });
    expect(
      projection.routes
        .filter((route) => ["imagery-terrain", "maui-3d", "wms-overlay"].includes(String(route.id)))
        .map((route) => String(route.sampleId)),
    ).toEqual(["imagery-cog-quickstart", "imagery-cog-quickstart", "imagery-cog-quickstart"]);
    expect(
      projection.routes
        .filter((route) => ["editing", "planning-permitting"].includes(String(route.id)))
        .map((route) => String(route.sampleId)),
    ).toEqual(["planning-permitting-workbench", "planning-permitting-workbench"]);
    expect(projection.samples.some((sample: { id: string }) => sample.id === "two-protocols")).toBe(false);

    const malformedProjection = structuredClone(projection);
    delete malformedProjection.samples[0].lifecycle.state;
    await expect(validateSiteProjection(malformedProjection)).rejects.toThrow("JSON Schema validation failed");

    const sensitiveProjection = structuredClone(projection);
    sensitiveProjection.externalReplacements[0].url = "https://example.test/replacement?clientSecret=secret";
    await expect(validateSiteProjection(sensitiveProjection)).rejects.toThrow(
      "forbidden credential query parameter clientSecret",
    );

    const flattenedCi = structuredClone(ciSelection);
    const flattenedSample = flattenedCi.samples[0] as unknown as Record<string, unknown>;
    flattenedSample.commands = ["npm run demo:quickstart:mock"];
    delete flattenedSample.commandPlan;
    await expect(validateCiSelection(flattenedCi)).rejects.toThrow("JSON Schema validation failed");
  }, 80_000);

  // Also reads real qualification evidence for all four golden journeys;
  // give it its own headroom for the same reason as the test above.
  it("rejects overstated, stale, cross-runtime, and non-realtime visual evidence", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const qualificationEvidence = await collectQualificationEvidence(catalog);
    const canonical = await generateGoldenJourneyVisualEvidence(catalog, qualificationEvidence);
    const observedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const overstated = structuredClone(canonical);
    overstated.qualifiedGoldenJourneys.push(
      visualEvidenceAdversary("first-map", "maplibre-quickstart", observedAt, expiresAt),
    );
    await expect(validateGoldenJourneyVisualEvidence(overstated, catalog, qualificationEvidence)).rejects.toThrow(
      "orphaned, missing, or overstated",
    );

    const staleCatalog = structuredClone(catalog);
    staleCatalog.goldenJourneys[0].status = "qualified";
    staleCatalog.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").track = "golden";
    // Replace (not push) only the first-map entry: canonical now carries all
    // four real qualified journeys (first-map, imagery-terrain,
    // arcgis-migration, and service-explorer), and the orphaned/overstated
    // coverage check requires visualEvidence to exactly match the catalog's
    // qualified set, so this sub-case isolates a stale freshness window on
    // one journey without orphaning or dropping the other three's genuine
    // evidence.
    const stale = structuredClone(canonical);
    stale.qualifiedGoldenJourneys = stale.qualifiedGoldenJourneys.map((entry) =>
      entry.journeyId === "first-map"
        ? visualEvidenceAdversary(
            "first-map",
            "maplibre-quickstart",
            "2026-07-01T00:00:00.000Z",
            "2026-07-08T00:00:00.000Z",
          )
        : entry,
    );
    await expect(validateGoldenJourneyVisualEvidence(stale, staleCatalog, qualificationEvidence)).rejects.toThrow(
      "stale or has an invalid freshness window",
    );

    const staleLive = structuredClone(canonical);
    staleLive.qualifiedGoldenJourneys = staleLive.qualifiedGoldenJourneys.map((entry) =>
      entry.journeyId === "first-map"
        ? visualEvidenceAdversary("first-map", "maplibre-quickstart", observedAt, expiresAt)
        : entry,
    );
    const staleLiveEntry = staleLive.qualifiedGoldenJourneys.find((entry) => entry.journeyId === "first-map");
    if (!staleLiveEntry) throw new Error("expected a first-map entry in staleLive.qualifiedGoldenJourneys");
    staleLiveEntry.liveEvidence.observedAt = "2026-07-01T00:00:00.000Z";
    staleLiveEntry.liveEvidence.expiresAt = "2026-07-08T00:00:00.000Z";
    await expect(validateGoldenJourneyVisualEvidence(staleLive, staleCatalog, qualificationEvidence)).rejects.toThrow(
      "stale or has an invalid freshness window",
    );

    const incidentCatalog = structuredClone(catalog);
    const incidentJourney = incidentCatalog.goldenJourneys.find(
      (journey: { id: string }) => journey.id === "incident-operations",
    );
    incidentJourney.status = "qualified";
    incidentCatalog.samples.find((sample: { id: string }) => sample.id === "realtime-incident-dashboard").track =
      "golden";
    // Insert (not push) at the reserved goldenJourneys array position for
    // incident-operations (index 3, between first-map and imagery-terrain):
    // the orphaned/missing/overstated check compares qualifiedGoldenJourneys
    // against the catalog's own qualified-journey order, so an append would
    // trip that check instead of exercising the realtime invariant below.
    const staticIncident = structuredClone(canonical);
    const incidentJourneyIndex = incidentCatalog.goldenJourneys.findIndex(
      (journey: { id: string }) => journey.id === "incident-operations",
    );
    const qualifiedBeforeIncident = incidentCatalog.goldenJourneys
      .slice(0, incidentJourneyIndex)
      .filter((journey: { status: string }) => journey.status === "qualified").length;
    staticIncident.qualifiedGoldenJourneys.splice(
      qualifiedBeforeIncident,
      0,
      visualEvidenceAdversary("incident-operations", "realtime-incident-dashboard", observedAt, expiresAt),
    );
    await expect(
      validateGoldenJourneyVisualEvidence(staticIncident, incidentCatalog, qualificationEvidence),
    ).rejects.toThrow("must remain realtime");

    const crossRuntime = structuredClone(canonical);
    crossRuntime.policy.screenshotReproducibility.scope = "cross-platform";
    await expect(validateGoldenJourneyVisualEvidence(crossRuntime, catalog, qualificationEvidence)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    // Two entries cannot resolve to one sample, journey, or executable tree:
    // that is how a second implementation would ride qualified evidence
    // (honua-io/honua-sdk-js#550 duplicate-identity handling).
    const duplicateIdentity = structuredClone(canonical);
    duplicateIdentity.qualifiedGoldenJourneys[1].source.path = duplicateIdentity.qualifiedGoldenJourneys[0].source.path;
    await expect(
      validateGoldenJourneyVisualEvidence(duplicateIdentity, catalog, qualificationEvidence),
    ).rejects.toThrow("duplicate journey, sample, or source identities");

    const borrowedReceipt = structuredClone(canonical);
    borrowedReceipt.qualifiedGoldenJourneys = borrowedReceipt.qualifiedGoldenJourneys.map((entry) => {
      if (entry.journeyId !== "first-map") return entry;
      const adversary = visualEvidenceAdversary("first-map", "maplibre-quickstart", observedAt, expiresAt);
      adversary.semanticEvidence[0].receiptPath = "samples/evidence/service-explorer/receipts/packed-build.v1.json";
      return adversary;
    });
    await expect(
      validateGoldenJourneyVisualEvidence(borrowedReceipt, staleCatalog, qualificationEvidence),
    ).rejects.toThrow("visual evidence receipt is orphaned from its sample");

    const borrowedScreenshot = structuredClone(canonical);
    borrowedScreenshot.qualifiedGoldenJourneys = borrowedScreenshot.qualifiedGoldenJourneys.map((entry) => {
      if (entry.journeyId !== "first-map") return entry;
      const adversary = visualEvidenceAdversary("first-map", "maplibre-quickstart", observedAt, expiresAt);
      adversary.screenshots[0].sourcePath =
        "samples/evidence/service-explorer/runs/11111111-1111-4111-8111-111111111111/artifacts/screenshot-desktop.png";
      return adversary;
    });
    await expect(
      validateGoldenJourneyVisualEvidence(borrowedScreenshot, staleCatalog, qualificationEvidence),
    ).rejects.toThrow("screenshot is orphaned from its own evidence run");

    const sourceModePacked = structuredClone(canonical);
    sourceModePacked.qualifiedGoldenJourneys = sourceModePacked.qualifiedGoldenJourneys.map((entry) => {
      if (entry.journeyId !== "first-map") return entry;
      const adversary = visualEvidenceAdversary("first-map", "maplibre-quickstart", observedAt, expiresAt);
      const packed = adversary.semanticEvidence.find((receipt) => receipt.gate === "packed-build");
      if (!packed) throw new Error("expected a packed-build receipt in the adversary");
      packed.sdkMode = "source";
      return adversary;
    });
    await expect(
      validateGoldenJourneyVisualEvidence(sourceModePacked, staleCatalog, qualificationEvidence),
    ).rejects.toThrow("must come from the packed SDK mode");

    // A structurally consistent entry that advertises artifacts the checkout
    // does not contain must fail publication rather than ship an unverifiable
    // golden card.
    const unverifiableArtifacts = structuredClone(canonical);
    unverifiableArtifacts.qualifiedGoldenJourneys = unverifiableArtifacts.qualifiedGoldenJourneys.map((entry) =>
      entry.journeyId === "first-map"
        ? visualEvidenceAdversary("first-map", "maplibre-quickstart", observedAt, expiresAt)
        : entry,
    );
    await expect(
      validateGoldenJourneyVisualEvidence(unverifiableArtifacts, staleCatalog, qualificationEvidence),
    ).rejects.toThrow("is broken or missing");
  }, 80_000);

  // This test calls generatedOutputs() twice (current + bumped-version
  // catalogs), roughly doubling the file's already-doubled four-journey I/O
  // budget; give it its own headroom rather than inflating every other test
  // in this file to match.
  it("derives release versions without catalog edits and still detects semantic drift", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const packageJson = await readJson("package.json");
    const currentOutputs = await generatedOutputs(catalog, packageJson);
    const versionMatch = /^(\d+)\.(\d+)\.(\d+)([-+].+)?$/.exec(packageJson.version);
    if (!versionMatch) {
      throw new Error(`Expected a semantic package version, received ${packageJson.version}`);
    }
    const bumpedVersion = `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 1}${versionMatch[4] ?? ""}`;
    const bumpedPackage = { ...packageJson, version: bumpedVersion };

    await expect(validateCatalog(catalog, bumpedPackage, validationTime)).rejects.toThrow(
      `live evidence SDK version ${packageJson.version} does not match ${bumpedVersion}`,
    );
    const bumpedOutputs = await generatedOutputs(catalog, bumpedPackage);
    const bumpedProjection = JSON.parse(bumpedOutputs.get("samples/dist/honua-site-samples.v3.json")!);
    expect(bumpedProjection.catalog.version).toBe(bumpedVersion);
    expect(bumpedProjection.samples[0].sdk.version).toBe(bumpedVersion);
    expect(generatedOutputDrift(bumpedOutputs, currentOutputs)).toEqual([
      "samples/dist/honua-site-samples.v2.json",
      "samples/dist/honua-site-samples.v3.json",
      "samples/dist/capability-sample-matrix.v1.json",
      "samples/dist/honua-site-consumer-handoff.v1.json",
      "samples/dist/honua-site-consumer-handoff.v2.json",
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json",
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json",
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v4.json",
    ]);

    const semanticDrift = new Map(currentOutputs);
    semanticDrift.set(
      "docs/generated/sample-catalog.md",
      currentOutputs.get("docs/generated/sample-catalog.md")!.replace("# SDK sample catalog", "# Stale catalog"),
    );
    expect(generatedOutputDrift(currentOutputs, semanticDrift)).toEqual(["docs/generated/sample-catalog.md"]);

    const integrityDrift = new Map(currentOutputs);
    const fixturePath = "samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json";
    const consumerFixture = JSON.parse(currentOutputs.get(fixturePath)!);
    consumerFixture.input.sha256 = "0".repeat(64);
    integrityDrift.set(fixturePath, `${JSON.stringify(consumerFixture, null, 2)}\n`);
    expect(generatedOutputDrift(currentOutputs, integrityDrift)).toEqual([fixturePath]);
    expect(generatedOutputDrift(bumpedOutputs, integrityDrift)).toEqual([
      "samples/dist/honua-site-samples.v2.json",
      "samples/dist/honua-site-samples.v3.json",
      "samples/dist/capability-sample-matrix.v1.json",
      "samples/dist/honua-site-consumer-handoff.v1.json",
      "samples/dist/honua-site-consumer-handoff.v2.json",
      fixturePath,
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json",
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v4.json",
    ]);
    expect(() => validateGeneratedOutputDrift([fixturePath])).toThrow(/has drifted/u);
    expect(() => validateGeneratedOutputDrift([fixturePath], { relaxed: true })).not.toThrow();
  }, 100_000);

  it("rejects taxonomy, lifecycle, inventory, and evidence-policy drift", async () => {
    const packageJson = await readJson("package.json");

    const unsorted = await readJson("samples/catalog.v2.json");
    unsorted.samples[0].capabilities = [...unsorted.samples[0].capabilities].reverse();
    await expect(validateCatalog(unsorted, packageJson, validationTime)).rejects.toThrow("must be sorted");

    const renamedJourney = await readJson("samples/catalog.v2.json");
    renamedJourney.goldenJourneys[0].id = "renamed-first-map";
    await expect(validateCatalog(renamedJourney, packageJson, validationTime)).rejects.toThrow(
      "golden journey IDs must be reserved",
    );

    const missingExample = await readJson("samples/catalog.v2.json");
    missingExample.samples = missingExample.samples.filter(
      (sample: { id: string }) => sample.id !== "shared-renderer-state",
    );
    await expect(validateCatalog(missingExample, packageJson, validationTime)).rejects.toThrow(
      "runnable docs example inventory drift",
    );

    const expiredLifecycle = await readJson("samples/catalog.v2.json");
    expiredLifecycle.samples.find(
      (sample: { id: string }) => sample.id === "app-bootstrap-basic",
    ).lifecycle.targetRelease = packageJson.version;
    await expect(validateCatalog(expiredLifecycle, packageJson, validationTime)).rejects.toThrow(
      `lifecycle retire expired at ${packageJson.version}`,
    );

    const missingReplacement = await readJson("samples/catalog.v2.json");
    const merged = missingReplacement.samples.find((sample: { lifecycle: { state: string } }) =>
      ["merge", "replace", "retire"].includes(sample.lifecycle.state),
    );
    delete merged.lifecycle.replacement;
    await expect(validateCatalog(missingReplacement, packageJson, validationTime)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const replacementCycle = await readJson("samples/catalog.v2.json");
    const first = replacementCycle.samples.find((sample: { id: string }) => sample.id === "geoprocessing-job-runner");
    const second = replacementCycle.samples.find((sample: { id: string }) => sample.id === "stac-imagery-browser");
    first.lifecycle.replacement = { kind: "sample", id: second.id };
    second.lifecycle.state = "merge";
    second.lifecycle.targetRelease = "0.2.0-beta.0";
    second.lifecycle.replacement = { kind: "sample", id: first.id };
    await expect(validateCatalog(replacementCycle, packageJson, validationTime)).rejects.toThrow(
      "sample/journey replacement cycle: sample:geoprocessing-job-runner -> sample:stac-imagery-browser -> sample:geoprocessing-job-runner",
    );

    const expandedJourneyCycle = await readJson("samples/catalog.v2.json");
    const imagery = expandedJourneyCycle.samples.find(
      (sample: { id: string }) => sample.id === "imagery-cog-quickstart",
    );
    imagery.lifecycle.state = "merge";
    imagery.lifecycle.targetRelease = "0.2.0-beta.0";
    imagery.lifecycle.replacement = { kind: "journey", id: "imagery-terrain" };
    await expect(validateCatalog(expandedJourneyCycle, packageJson, validationTime)).rejects.toThrow(
      "sample/journey replacement cycle: sample:imagery-cog-quickstart -> journey:imagery-terrain -> sample:imagery-cog-quickstart",
    );

    const unboundExecuted = await readJson("samples/catalog.v2.json");
    const planned = unboundExecuted.samples.find(
      (sample: { evidence: { live: { status: string } } }) => sample.evidence.live.status === "planned",
    );
    planned.evidence.live.status = "executed";
    planned.evidence.live.commands = ["npm run bench:live"];
    await expect(validateCatalog(unboundExecuted, packageJson, validationTime)).rejects.toThrow(
      "executed live status requires evidencePath",
    );

    const expiredEvidence = await readJson("samples/catalog.v2.json");
    const bound = expiredEvidence.samples.find(
      (sample: { evidence: { live: { status: string } } }) => sample.evidence.live.status === "skipped",
    );
    // Just-expired, derived from the clock rather than hardcoded. A literal
    // date has to sit after the seed attestation's observedAt (or the "expiry
    // must follow observation time" invariant fires first and this assertion
    // never runs), so it silently becomes wrong the moment renewal re-observes
    // that lane past the literal. Deriving it holds for any still-current
    // attestation, whenever it was last re-observed.
    //
    // Expiry is a *currency* claim, so it derives from the currency clock: this
    // fixture has to stay just-expired at every look-ahead offset, and a lane
    // dated `validationTime.now - 1s` would still be in the future as far as
    // the currency check is concerned once the validation clock is shifted.
    bound.evidence.live.expiresAt = new Date(Date.parse(validationTime.evidenceCurrencyNow) - 1000).toISOString();
    await expect(validateCatalog(expiredEvidence, packageJson, validationTime)).rejects.toThrow(
      "live evidence expired",
    );

    const unsafeActiveConfig = await readJson("samples/catalog.v2.json");
    const cesium = unsafeActiveConfig.samples.find((sample: { id: string }) => sample.id === "cesium-route-playback");
    cesium.lifecycle = { state: "active", reason: "Invalid promotion fixture." };
    await expect(validateCatalog(unsafeActiveConfig, packageJson, validationTime)).rejects.toThrow(
      "cesium-route-playback: legacy-unsafe configuration requires bounded rework",
    );

    const sensitiveReplacementUrl = await readJson("samples/catalog.v2.json");
    sensitiveReplacementUrl.externalReplacements[0].url = "https://example.test/replacement?X-Goog-Signature=secret";
    await expect(validateCatalog(sensitiveReplacementUrl, packageJson, validationTime)).rejects.toThrow(
      "forbidden credential query parameter X-Goog-Signature",
    );

    const embeddedUrlCredential = await readJson("samples/catalog.v2.json");
    embeddedUrlCredential.externalReplacements[0].url = "https://publisher:password@example.test/replacement";
    await expect(validateCatalog(embeddedUrlCredential, packageJson, validationTime)).rejects.toThrow(
      "URL must not contain embedded credentials",
    );

    const literalCredential = await readJson("samples/catalog.v2.json");
    literalCredential.samples[0].summary = "Unsafe Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";
    await expect(validateCatalog(literalCredential, packageJson, validationTime)).rejects.toThrow(
      "contains a credential value",
    );

    const benignCredentialLanguage = await readJson("samples/catalog.v2.json");
    benignCredentialLanguage.samples[0].summary =
      "Bearer authentication, Bearer credentials, authorization=required, and AKIA12345678 are documentation text.";
    await expect(validateCatalog(benignCredentialLanguage, packageJson, validationTime)).resolves.toBeUndefined();
  });

  it("binds exact source configuration reads and makes browser credential exposure explicit", async () => {
    const packageJson = await readJson("package.json");
    const catalog = await readJson("samples/catalog.v2.json");
    const node = catalog.samples.find((sample: { id: string }) => sample.id === "node-backend-quickstart");
    expect(node.data.config).toEqual(
      expect.arrayContaining(["HONUA_API_KEY", "HONUA_BASE_URL", "HONUA_SERVICE_ACCOUNT_TOKEN", "HOST", "PORT"]),
    );
    expect(
      node.data.configClassifications.every((entry: { exposure: string }) => entry.exposure === "server-only"),
    ).toBe(true);
    expect(
      node.data.configClassifications.find(
        (entry: { name: string }) => entry.name === "HONUA_SERVICE_ACCOUNT_TOKEN_TTL_MS",
      ),
    ).toEqual({
      name: "HONUA_SERVICE_ACCOUNT_TOKEN_TTL_MS",
      exposure: "server-only",
      valueKind: "non-secret",
    });
    expect(
      node.data.configClassifications.find((entry: { name: string }) => entry.name === "HONUA_SERVICE_ACCOUNT_TOKEN"),
    ).toMatchObject({ valueKind: "credential", credentialScope: "secret" });
    for (const name of [
      "VITE_CLIENT_SECRET",
      "VITE_DATABASE_PASSWORD",
      "VITE_SIGNING_PRIVATE_KEY",
      "VITE_STORAGE_ACCESS_KEY_ID",
      "VITE_CLIENT_SECRET_TOKEN_TTL_MS",
    ]) {
      expect(classifyConfigurationName(name)).toMatchObject({
        exposure: "browser-public",
        valueKind: "credential",
        credentialScope: "secret",
      });
    }
    const kepler = catalog.samples.find((sample: { id: string }) => sample.id === "kepler-analytics");
    expect(kepler).toMatchObject({
      lifecycle: { state: "rework" },
      data: { configurationStatus: "legacy-unsafe" },
    });
    expect(
      kepler.data.configClassifications.find((entry: { name: string }) => entry.name === "VITE_MAPBOX_TOKEN"),
    ).toEqual({
      name: "VITE_MAPBOX_TOKEN",
      exposure: "browser-public",
      valueKind: "credential",
      credentialScope: "public-token",
    });

    const missingRead = structuredClone(catalog);
    const missingNode = missingRead.samples.find((sample: { id: string }) => sample.id === "node-backend-quickstart");
    const missingIndex = missingNode.data.config.indexOf("HONUA_SERVICE_ACCOUNT_TOKEN");
    missingNode.data.config.splice(missingIndex, 1);
    missingNode.data.configClassifications.splice(missingIndex, 1);
    await expect(validateCatalog(missingRead, packageJson, validationTime)).rejects.toThrow(
      "node-backend-quickstart: configuration declaration drift",
    );

    const inventedRead = structuredClone(catalog);
    const inventedNode = inventedRead.samples.find((sample: { id: string }) => sample.id === "node-backend-quickstart");
    inventedNode.data.config.push("ZZZ_INVENTED_CONFIG");
    inventedNode.data.configClassifications.push({
      name: "ZZZ_INVENTED_CONFIG",
      exposure: "server-only",
      valueKind: "non-secret",
    });
    await expect(validateCatalog(inventedRead, packageJson, validationTime)).rejects.toThrow(
      "node-backend-quickstart: configuration declaration drift",
    );

    const hiddenBrowserCredential = structuredClone(catalog);
    const hiddenKepler = hiddenBrowserCredential.samples.find(
      (sample: { id: string }) => sample.id === "kepler-analytics",
    );
    hiddenKepler.data.configurationStatus = "approved";
    delete hiddenKepler.data.configurationGap;
    await expect(validateCatalog(hiddenBrowserCredential, packageJson, validationTime)).rejects.toThrow(
      "kepler-analytics: browser-public credentials require legacy-unsafe status and bounded rework",
    );

    const maplibre = catalog.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart");
    expect(maplibre.data).toMatchObject({
      configurationStatus: "approved",
      config: [
        "VITE_HONUA_QUICKSTART_BASEMAP_STYLE",
        "VITE_HONUA_QUICKSTART_ENDPOINT",
        "VITE_HONUA_QUICKSTART_PROTOCOL",
        "VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT",
        "VITE_HONUA_QUICKSTART_WHERE",
      ],
    });
    expect(
      maplibre.data.configClassifications.every(
        (entry: { exposure: string; valueKind: string }) =>
          entry.exposure === "browser-public" && entry.valueKind === "non-secret",
      ),
    ).toBe(true);
    await expect(validateCatalog(catalog, packageJson, validationTime)).resolves.toBeUndefined();

    const inventedExemption = structuredClone(catalog);
    inventedExemption.configuration.environmentReadExemptions.push({
      name: "HONUA_FAKE_BUILTIN",
      provider: "vite",
      reason: "Invalid test exemption.",
    });
    inventedExemption.configuration.environmentReadExemptions.sort((left: { name: string }, right: { name: string }) =>
      left.name.localeCompare(right.name),
    );
    await expect(validateCatalog(inventedExemption, packageJson, validationTime)).rejects.toThrow(
      "configuration exemption HONUA_FAKE_BUILTIN is not an approved standard built-in",
    );

    const credentialPolicyDrift = structuredClone(catalog);
    credentialPolicyDrift.configuration.credentialQueryParameters.pop();
    await expect(validateCatalog(credentialPolicyDrift, packageJson, validationTime)).rejects.toThrow(
      "configuration.credentialQueryParameters must exactly match the canonical normalized credential-key set",
    );
  });

  it("resolves finite environment aliases and fails closed on dynamic reads", async () => {
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-static")).resolves.toEqual([
      "HONUA_ALIASED_URL",
      "HONUA_DESTRUCTURED_URL",
      "HONUA_DYNAMIC_URL",
    ]);
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-lexical-keys")).resolves.toEqual([
      "HONUA_LEXICAL_CHAIN_URL",
      "HONUA_LITERAL_CHAIN_URL",
    ]);
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-unresolved")).rejects.toThrow(
      "unresolved dynamic environment read",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-mutable-key")).rejects.toThrow(
      "finite environment key binding environmentKey must be const",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-assigned-key")).rejects.toThrow(
      "finite environment key binding environmentKey must not be assigned",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-shadowed-key")).rejects.toThrow(
      "shadowed finite environment key environmentKey",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-var-shadowed-key")).rejects.toThrow(
      "shadowed finite environment key environmentKey",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-property-key")).rejects.toThrow(
      "unresolved call into dynamic environment reader readEnvironment",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-dynamic-process-root")).rejects.toThrow(
      "unresolved dynamic environment root",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-dynamic-import-root")).rejects.toThrow(
      "unresolved dynamic environment root",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-rest")).rejects.toThrow(
      "environment rest destructuring is not statically bounded",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-parameter-rest")).rejects.toThrow(
      "environment rest destructuring is not statically bounded",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-exported-arrow-reader")).rejects.toThrow(
      "exported dynamic environment reader readEnvironment is not statically bounded",
    );
    await expect(
      extractSampleConfiguration("test/fixtures/sample-contract/env-exported-specifier-reader"),
    ).rejects.toThrow("exported dynamic environment reader readEnvironment is not statically bounded");
    await expect(
      extractSampleConfiguration("test/fixtures/sample-contract/env-dynamic-call-target-shadow"),
    ).rejects.toThrow("dynamic environment reader readEnvironment has no finite call sites");
    await expect(
      extractSampleConfiguration("test/fixtures/sample-contract/env-process-promise-reader"),
    ).rejects.toThrow("node:process dynamic imports must be awaited before environment access");
  });

  it("inventories computed environment roots and fixed object-binding defaults", async () => {
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-computed-roots")).resolves.toEqual([
      "HONUA_COMPUTED_NODE_URL",
      "VITE_COMPUTED_BROWSER_URL",
    ]);
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-binding-defaults")).resolves.toEqual({
      names: ["HONUA_BINDING_DEFAULT_URL", "HONUA_PARAMETER_DEFAULT_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-process-aliases")).resolves.toEqual({
      names: ["HONUA_DESTRUCTURED_ENV_URL", "HONUA_PROCESS_ALIAS_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-process-imports")).resolves.toEqual({
      names: ["HONUA_DEFAULT_PROCESS_IMPORT_URL", "HONUA_NAMED_ENV_IMPORT_URL", "HONUA_NAMESPACE_PROCESS_IMPORT_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-process-loaders")).resolves.toEqual({
      names: ["HONUA_CJS_TOKEN", "HONUA_DYNAMIC_TOKEN"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-global-process-roots")).resolves.toEqual(
      {
        names: ["HONUA_COMPUTED_GLOBAL_THIS_PROCESS_URL", "HONUA_GLOBAL_PROCESS_URL", "HONUA_GLOBAL_THIS_PROCESS_URL"],
        wholeEnvironmentEscapes: [],
      },
    );
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-shadowed-host-roots")).resolves.toEqual({
      names: [],
      wholeEnvironmentEscapes: [],
    });
  });

  it("traces scoped environment carriers and reports whole-object browser escapes", async () => {
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-forwarded")).resolves.toEqual({
      names: ["HONUA_FORWARDED_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-defaulted")).resolves.toEqual({
      names: ["HONUA_DEFAULTED_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-browser-projected")).resolves.toEqual({
      names: ["VITE_PROJECTED_URL"],
      wholeEnvironmentEscapes: [],
    });

    const wholeBrowserEnvironment = await inspectSampleConfiguration("test/fixtures/sample-contract/env-browser-whole");
    expect(wholeBrowserEnvironment.names).toEqual(["VITE_WHOLE_INVENTORIED_URL"]);
    expect(wholeBrowserEnvironment.wholeEnvironmentEscapes).toHaveLength(2);
    expect(wholeBrowserEnvironment.wholeEnvironmentEscapes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "test/fixtures/sample-contract/env-browser-whole/index.ts",
          line: 2,
          roots: ["import.meta.env"],
          reason: "passed to an untraceable call",
        }),
        expect.objectContaining({
          file: "test/fixtures/sample-contract/env-browser-whole/index.ts",
          line: 3,
          roots: ["import.meta.env"],
          reason: "passed to an untraceable call",
        }),
      ]),
    );

    const localBrowserEnvironment = await inspectSampleConfiguration("test/fixtures/sample-contract/env-browser-local");
    expect(localBrowserEnvironment.names).toEqual(["VITE_LOCAL_URL"]);
    expect(localBrowserEnvironment.wholeEnvironmentEscapes).toEqual([
      expect.objectContaining({ roots: ["import.meta.env"], reason: "used as a whole object" }),
      expect.objectContaining({ roots: ["import.meta.env"], reason: "passed whole to a local call" }),
    ]);

    const shadowedCallTarget = await inspectSampleConfiguration("test/fixtures/sample-contract/env-call-target-shadow");
    expect(shadowedCallTarget.names).toEqual([]);
    expect(shadowedCallTarget.wholeEnvironmentEscapes).toEqual([
      expect.objectContaining({ roots: ["process.env"], reason: "passed to an untraceable call" }),
    ]);

    const processHostEscapes = await inspectSampleConfiguration(
      "test/fixtures/sample-contract/env-process-host-escapes",
    );
    expect(processHostEscapes.names).toEqual([]);
    expect(processHostEscapes.wholeEnvironmentEscapes).toEqual([
      expect.objectContaining({ roots: ["process.env"], reason: "passed to an untraceable call" }),
      expect.objectContaining({ roots: ["process.env"], reason: "used as a whole object" }),
    ]);
  });

  it("isolates fixture Vite environments and gates every build launcher", async () => {
    const environment = createFixtureBuildEnvironment(
      { VITE_DECLARED: "fixture", VITE_EMPTY: "" },
      {
        PATH: "/usr/bin",
        HONUA_KEEP: "yes",
        VITE_DECLARED: "ambient",
        VITE_UNDECLARED_FIXTURE_SENTINEL: "must-not-leak",
        vite_mixed_case_sentinel: "must-not-leak",
      },
    );
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HONUA_KEEP: "yes",
      VITE_DECLARED: "fixture",
      VITE_EMPTY: "",
    });
    expect(() => createFixtureBuildEnvironment({ HONUA_NOT_PUBLIC: "invalid" }, {})).toThrow(
      "Fixture build overrides must use uppercase VITE_* names",
    );

    const fixtureEnvironmentImport =
      'import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";';
    const helperImport = [
      'import { spawnSync } from "node:child_process";',
      'import { runNpmScriptSync } from "../../scripts/lib/npm-cli.mjs";',
      fixtureEnvironmentImport,
    ].join("\n");
    expect(
      validateFixtureBuildHarnessSource(
        `${helperImport}\nrunNpmScriptSync("demo:fixture:build", { env: createFixtureBuildEnvironment() });`,
      ),
    ).toBe(1);
    expect(
      validateFixtureBuildHarnessSource(
        `${helperImport}
import { startSampleFixtureHarness } from "../../samples/scenarios/index.mjs";
void startSampleFixtureHarness;
runNpmScriptSync("demo:fixture:build", { env: createFixtureBuildEnvironment() });`,
      ),
    ).toBe(1);
    expect(
      validateFixtureBuildHarnessSource(
        `${helperImport}
const launchFixtureBuild = runNpmScriptSync;
launchFixtureBuild("demo:fixture:build", { env: createFixtureBuildEnvironment() });`,
      ),
    ).toBe(1);
    expect(() =>
      validateFixtureBuildHarnessSource(
        `import * as npmCli from "../../scripts/lib/npm-cli.mjs";
${fixtureEnvironmentImport}
npmCli.runNpmScriptSync("demo:fixture:build", { env: createFixtureBuildEnvironment() });`,
      ),
    ).toThrow("npm CLI helper must use a named import");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `import { runNpmSync } from "../../scripts/lib/npm-cli.mjs";
${fixtureEnvironmentImport}
runNpmSync(["run", "demo:fixture:build"], { env: createFixtureBuildEnvironment() });`,
      ),
    ).toThrow("may import only runNpmScriptSync");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
runNpmScriptSync(
  "demo:fixture:build",
  { env: createFixtureBuildEnvironment() },
  { spawnSync: unsafeSpawn },
);`,
      ),
    ).toThrow("unsupported fixture npm script invocation");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment(),
  shell: process.platform === "win32",
});`,
      ),
    ).toThrow("unsupported fixture build option shell");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const launchFixtureBuild = runNpmScriptSync;
consume(launchFixtureBuild);`,
      ),
    ).toThrow("npm script launch functions cannot escape direct calls or const aliases");
    expect(() =>
      validateFixtureBuildHarnessSource(`${helperImport}\nrunNpmScriptSync("demo:fixture:build", {});`),
    ).toThrow("fixture build must declare an explicit env option");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}\nrunNpmScriptSync("demo:fixture:build", { env: process.env });`,
      ),
    ).toThrow("fixture build env must come directly from createFixtureBuildEnvironment");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const argv = ["run", "demo:second:build", "--silent"];
runNpmScriptSync("demo:fixture:build", { env: createFixtureBuildEnvironment() });
spawnSync("npm", argv, { env: process.env });`,
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const argv = createArgv();
spawnSync("npm", argv, { env: createFixtureBuildEnvironment() });`,
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `import { spawnSync as launch } from "node:child_process";
${fixtureEnvironmentImport}
launch("npm", ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("fixture builds must use runNpmScriptSync");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `import * as childProcess from "node:child_process";
${fixtureEnvironmentImport}
childProcess.execFileSync("npm", ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("fixture builds must use runNpmScriptSync");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { execSync } from "node:child_process";\nexecSync("npm run demo:fixture:build --silent");',
      ),
    ).toThrow("execSync permits only allowlisted non-build commands");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `const { spawnSync: launch } = require("node:child_process");
${fixtureEnvironmentImport}
launch("npm", ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("fixture builds must use runNpmScriptSync");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `import { spawnSync } from "node:child_process";
${fixtureEnvironmentImport}
const launch = spawnSync;
launch("npm", ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("fixture builds must use runNpmScriptSync");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { spawnSync } from "node:child_process";\nconst holder = { launch: spawnSync };\nholder.launch(dynamicCommand);',
      ),
    ).toThrow("child-process launch functions cannot escape direct calls or const aliases");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import * as childProcess from "node:child_process";\nconst method = "spawnSync";\nchildProcess[method](dynamicCommand);',
      ),
    ).toThrow("child-process namespaces cannot escape launch API member access or const aliases");
    expect(() => validateFixtureBuildHarnessSource('consume(require("node:child_process"));')).toThrow(
      "child-process namespaces cannot escape launch API member access or const aliases",
    );
    expect(() => validateFixtureBuildHarnessSource('consume(await import("node:child_process"));')).toThrow(
      "child-process namespaces cannot escape launch API member access or const aliases",
    );
    const validFixtureBuild = `${helperImport}
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment(),
});`;
    for (const source of [
      `${validFixtureBuild}
import("node:child_process").then((childProcess) =>
  childProcess.spawnSync("npm", ["run", "demo:quickstart:build", "--silent"], { env: process.env }),
);`,
      `${validFixtureBuild}
const childProcess = await import("node:child_process");
childProcess.default.spawnSync("npm", ["run", "demo:quickstart:build", "--silent"], { env: process.env });`,
    ]) {
      expect(() => validateFixtureBuildHarnessSource(source, "mock-server.mjs", "demo:fixture:build")).toThrow(
        "child-process namespaces cannot escape launch API member access or const aliases",
      );
    }
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
import "./unsafe-build.mjs";
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment(),
});`,
        "mock-server.mjs",
        "demo:fixture:build",
      ),
    ).toThrow("fixture build harnesses cannot import unreviewed local or data modules");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${validFixtureBuild}
await import("DATA:text/javascript,export default 1");`,
        "mock-server.mjs",
        "demo:fixture:build",
      ),
    ).toThrow("fixture build harnesses cannot dynamically load unreviewed local or data modules");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'process.getBuiltinModule("node:child_process").spawnSync("npm", dynamicArguments);',
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'const moduleName = "node:child_process";\nconst childProcess = await import(moduleName);\nchildProcess.spawnSync("npm", dynamicArguments);',
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { createRequire as cr } from "node:module";\nconst load = cr(import.meta.url);\nconst moduleName = "node:child_process";\nconst childProcess = load(moduleName);\nchildProcess.spawnSync("npm", dynamicArguments);',
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    for (const source of [
      'import * as Module from "node:module";\nconst load = Module.createRequire(import.meta.url);\nconst childProcess = load("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
      'import Module from "node:module";\nconst load = Module.createRequire(import.meta.url);\nconst childProcess = load("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
    ]) {
      expect(() => validateFixtureBuildHarnessSource(source)).toThrow("spawnSync argv must be statically bounded");
    }
    for (const source of [
      'import proc from "node:process";\nconst processAlias = proc;\nconst childProcess = processAlias.getBuiltinModule("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
      'import { getBuiltinModule as loadBuiltin } from "node:process";\nconst load = loadBuiltin;\nconst childProcess = load("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
      'const childProcess = globalThis.process.getBuiltinModule("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
      'const proc = globalThis.process;\nconst load = proc.getBuiltinModule;\nconst childProcess = load("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
    ]) {
      expect(() => validateFixtureBuildHarnessSource(source)).toThrow("spawnSync argv must be statically bounded");
    }
    expect(() =>
      validateFixtureBuildHarnessSource("async function load(moduleName) { return import(moduleName); }"),
    ).toThrow("static process-launch value moduleName must be a lexical const");
    expect(
      validateFixtureBuildHarnessSource(
        "function respond(payload) { return payload; }\nfunction require(moduleName) { return respond(moduleName); }\nrespond(dynamicPayload);\nrequire(dynamicModuleName);",
      ),
    ).toBe(0);
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { execFileSync } from "node:child_process";\nexecFileSync("git", dynamicGitArguments);',
      ),
    ).toThrow("execFileSync argv must be statically bounded");
    expect(
      validateFixtureBuildHarnessSource(
        'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status", "--short"]);',
      ),
    ).toBe(0);
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["-c", "alias.x=!npm run demo:fixture:build", "x"]);',
      ),
    ).toThrow("fixture builds must use runNpmScriptSync");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { spawnSync } from "node:child_process";\nspawnSync("npm", ["run", "build"]);',
      ),
    ).toThrow("spawnSync process launch is not a proven non-build command");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { spawnSync } from "node:child_process";\nspawnSync("python", ["safe.py"]);',
      ),
    ).toThrow("spawnSync process launch is not a proven non-build command");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
function launch(argv) {
  spawnSync("npm", argv, { env: createFixtureBuildEnvironment() });
  { const argv = ["run", "demo:borrowed:build", "--silent"]; void argv; }
}`,
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
runNpmScriptSync(condition ? "demo:fixture:build" : "unsafe-script", {
  env: createFixtureBuildEnvironment(),
});`,
      ),
    ).toThrow("unsupported fixture npm script invocation");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const leaked = process.env.VITE_HONUA_LEAKED_URL;
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment({ VITE_HONUA_FIXTURE_URL: leaked }),
});`,
      ),
    ).toThrow("fixture build overrides cannot derive from ambient environment variables");
    for (const source of [
      `${helperImport}
import proc from "node:process";
const processAlias = proc;
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment({ VITE_HONUA_FIXTURE_URL: processAlias.env.VITE_HONUA_FIXTURE_URL }),
});`,
      `${helperImport}
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment({ VITE_HONUA_FIXTURE_URL: globalThis.process.env.VITE_HONUA_FIXTURE_URL }),
});`,
      `${helperImport}
const processAlias = globalThis.process;
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment({ VITE_HONUA_FIXTURE_URL: processAlias.env.VITE_HONUA_FIXTURE_URL }),
});`,
    ]) {
      expect(() => validateFixtureBuildHarnessSource(source)).toThrow(
        "fixture build overrides cannot derive from ambient environment variables",
      );
    }
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment({ VITE_HONUA_API_TOKEN: "not-even-a-real-token" }),
});`,
      ),
    ).toThrow("fixture build override VITE_HONUA_API_TOKEN is credential-classified");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment({ ...fixtureOverrides }),
});`,
      ),
    ).toThrow("fixture build overrides must use explicit property assignments");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const overrides = { VITE_HONUA_FIXTURE_URL: "fixture" };
overrides.VITE_HONUA_FIXTURE_URL = process.env.VITE_HONUA_FIXTURE_URL;
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment(overrides),
});`,
      ),
    ).toThrow("fixture build override objects must remain immutable and cannot escape");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
try { throw () => process.env; } catch (createFixtureBuildEnvironment) {
  runNpmScriptSync("demo:fixture:build", {
    env: createFixtureBuildEnvironment(),
  });
}`,
      ),
    ).toThrow("fixture build env must come directly from createFixtureBuildEnvironment");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
runNpmScriptSync("demo:fixture:build", {
  env: createFixtureBuildEnvironment(),
  ...unsafeOptions,
});`,
      ),
    ).toThrow("fixture build options cannot use spreads");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
runNpmScriptSync("demo:wrong:build", {
  env: createFixtureBuildEnvironment(),
});`,
        "mock-server.mjs",
        "demo:fixture:build",
      ),
    ).toThrow("expected exactly one demo:fixture:build fixture build");
    await expect(validateFixtureBuildHarnesses()).resolves.toBe(24);
  });

  it("keeps the columnar browser validation exact and bounded", async () => {
    const packageJson = await readJson("package.json");
    const catalog = await readJson("samples/catalog.v2.json");
    const columnar = catalog.samples.find((sample: { id: string }) => sample.id === "columnar-query-quickstart");
    expect(columnar.validation).toContain("npm run test:playwright:columnar-query");
    const policyValidationTime = { ...validationTime, verifyCheckout: false };
    await expect(validateCatalog(catalog, packageJson, policyValidationTime)).resolves.toBeUndefined();

    const unboundedPackage = structuredClone(packageJson);
    unboundedPackage.scripts["test:playwright:columnar-query"] += " && vite";
    await expect(validateCatalog(catalog, unboundedPackage, policyValidationTime)).rejects.toThrow(
      "automatic validation command is not in the reviewed bounded registry",
    );
  });

  it("accepts only bounded, whole catalog commands", async () => {
    const packageJson = await readJson("package.json");

    const shellInjection = await readJson("samples/catalog.v2.json");
    shellInjection.samples[0].validation[0] = "npm run demo:quickstart:build && curl https://example.test";
    await expect(validateCatalog(shellInjection, packageJson, validationTime)).rejects.toThrow(
      "unsafe or unsupported catalog command",
    );

    const uninstalledNpx = await readJson("samples/catalog.v2.json");
    uninstalledNpx.samples[0].validation[0] = "npx cowsay test/sample.test.ts";
    await expect(validateCatalog(uninstalledNpx, packageJson, validationTime)).rejects.toThrow(
      "unsafe or unsupported catalog command",
    );

    const pathTraversal = await readJson("samples/catalog.v2.json");
    pathTraversal.samples[0].validation[0] = "npx vitest run ../outside.test.ts";
    await expect(validateCatalog(pathTraversal, packageJson, validationTime)).rejects.toThrow(
      "unsafe or unsupported catalog command",
    );

    const viteDevValidation = await readJson("samples/catalog.v2.json");
    viteDevValidation.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").validation[0] =
      "npm run demo:quickstart";
    await expect(validateCatalog(viteDevValidation, packageJson, validationTime)).rejects.toThrow(
      "automatic validation command is not in the reviewed bounded registry",
    );

    const deceptiveValidation = await readJson("samples/catalog.v2.json");
    const deceptiveValidationPackage = structuredClone(packageJson);
    deceptiveValidationPackage.scripts["demo:quickstart:build"] = "vite";
    await expect(validateCatalog(deceptiveValidation, deceptiveValidationPackage, validationTime)).rejects.toThrow(
      "automatic validation command is not in the reviewed bounded registry",
    );

    const viteDevLive = await readJson("samples/catalog.v2.json");
    viteDevLive.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").evidence.live.commands = [
      "npm run demo:quickstart",
    ];
    await expect(validateCatalog(viteDevLive, packageJson, validationTime)).rejects.toThrow(
      "scheduled live command is not in the reviewed bounded producer registry",
    );

    const deceptiveProducer = await readJson("samples/catalog.v2.json");
    deceptiveProducer.samples.find(
      (sample: { id: string }) => sample.id === "maplibre-quickstart",
    ).evidence.live.commands = ["npm run demo:evil:live-smoke"];
    const deceptivePackage = structuredClone(packageJson);
    deceptivePackage.scripts["demo:evil:live-smoke"] = "vite";
    await expect(validateCatalog(deceptiveProducer, deceptivePackage, validationTime)).rejects.toThrow(
      "scheduled live command is not in the reviewed bounded producer registry",
    );

    const reboundProducer = await readJson("samples/catalog.v2.json");
    const reboundPackage = structuredClone(packageJson);
    reboundPackage.scripts["evidence:first-map:live"] = "node scripts/overture-live-evidence.mjs";
    await expect(validateCatalog(reboundProducer, reboundPackage, validationTime)).rejects.toThrow(
      "scheduled live command is not in the reviewed bounded producer registry",
    );

    for (const hook of ["prebench:live", "postbench:live"]) {
      const hookedPackage = structuredClone(packageJson);
      hookedPackage.scripts[hook] = "node scripts/forged-live-hook.mjs";
      await expect(
        validateCatalog(await readJson("samples/catalog.v2.json"), hookedPackage, validationTime),
      ).rejects.toThrow("scheduled live command is not in the reviewed bounded producer registry");
    }

    for (const [script, definition] of [
      ["build", "tsc -p forged.json"],
      ["build:split-packages", "node scripts/forged-live-hook.mjs"],
      ["clean", "rm -rf dist forged"],
      ["prepare:test-sdk", "node scripts/forged-live-hook.mjs"],
      ["prepare:test-sdk:adopt", "node scripts/forged-live-hook.mjs"],
      ["prebuild", "node scripts/forged-live-hook.mjs"],
      ["postbuild", "node scripts/forged-live-hook.mjs"],
      ["prebuild:split-packages", "node scripts/forged-live-hook.mjs"],
      ["postbuild:split-packages", "node scripts/forged-live-hook.mjs"],
      ["preclean", "node scripts/forged-live-hook.mjs"],
      ["postclean", "node scripts/forged-live-hook.mjs"],
      ["preprepare:test-sdk", "node scripts/forged-live-hook.mjs"],
      ["postprepare:test-sdk", "node scripts/forged-live-hook.mjs"],
      ["preprepare:test-sdk:adopt", "node scripts/forged-live-hook.mjs"],
      ["postprepare:test-sdk:adopt", "node scripts/forged-live-hook.mjs"],
    ]) {
      const driftedDependencyPackage = structuredClone(packageJson);
      driftedDependencyPackage.scripts[script] = definition;
      await expect(
        validateCatalog(await readJson("samples/catalog.v2.json"), driftedDependencyPackage, validationTime),
      ).rejects.toThrow("scheduled live command is not in the reviewed bounded producer registry");
    }
  });

  it("keeps candidates non-golden until the full qualification contract is satisfied", async () => {
    const packageJson = await readJson("package.json");

    const promoteIncident = async () => {
      const catalog = await readJson("samples/catalog.v2.json");
      catalog.goldenJourneys.find((journey: { id: string }) => journey.id === "incident-operations").status =
        "qualified";
      const sample = catalog.samples.find(
        (candidate: { id: string }) => candidate.id === "realtime-incident-dashboard",
      );
      sample.track = "golden";
      sample.validationProfile = "golden-browser";
      return { catalog, sample };
    };

    const unsupported = await promoteIncident();
    unsupported.sample.supportTier = "experimental";
    await expect(validateCatalog(unsupported.catalog, packageJson, validationTime)).rejects.toThrow(
      "realtime-incident-dashboard: golden samples must be supported",
    );

    const inactive = await promoteIncident();
    inactive.sample.lifecycle = {
      state: "rework",
      reason: "Promotion regression fixture.",
      targetRelease: "0.2.0-beta.0",
    };
    await expect(validateCatalog(inactive.catalog, packageJson, validationTime)).rejects.toThrow(
      "realtime-incident-dashboard: golden samples must be active",
    );

    const missingFixture = await promoteIncident();
    missingFixture.sample.evidence.fixture.status = "planned";
    await expect(validateCatalog(missingFixture.catalog, packageJson, validationTime)).rejects.toThrow(
      "realtime-incident-dashboard: golden samples require executed fixture evidence",
    );

    const missingLive = await promoteIncident();
    await expect(validateCatalog(missingLive.catalog, packageJson, validationTime)).rejects.toThrow(
      "realtime-incident-dashboard: golden samples require current executed live evidence",
    );

    const prematurePromotion = await readJson("samples/catalog.v2.json");
    prematurePromotion.samples.find((sample: { id: string }) => sample.id === "realtime-incident-dashboard").track =
      "golden";
    await expect(validateCatalog(prematurePromotion, packageJson, validationTime)).rejects.toThrow(
      "incident-operations: planned journey candidate cannot use the golden track",
    );

    const metadataOnly = await promoteIncident();
    const evidencePath = "test-results/metadata-only-golden-evidence.json";
    const metadataOnlyExpiresAt = new Date(
      new Date(validationTime.now).getTime() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const executedEvidence = await readAttestationSeed(
      "examples/realtime-incident-dashboard/evidence/live-skipped.v1.json",
    );
    executedEvidence.status = "executed";
    executedEvidence.reason = null;
    executedEvidence.provenance = {
      sourceId: "honua-demo:incident-realtime",
      observedAt: executedEvidence.observedAt,
      validAt: null,
      state: "live",
      attribution: "Honua demo synthetic incident data",
    };
    executedEvidence.semantics.outcome = "connected";
    executedEvidence.timing.totalMs = 1;
    executedEvidence.degradation = { state: "none", reasons: [] };
    metadataOnly.sample.evidence.live = {
      mode: "demo-live",
      status: "executed",
      commands: ["npm run bench:live"],
      evidencePath,
      expiresAt: metadataOnlyExpiresAt,
    };
    try {
      await mkdir("test-results", { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(executedEvidence, null, 2)}\n`);
      await expect(
        validateCatalog(metadataOnly.catalog, packageJson, { ...validationTime, verifyCheckout: false }),
      ).rejects.toThrow("realtime-incident-dashboard: missing gate receipt directory");
      await expect(
        validateCatalog(metadataOnly.catalog, packageJson, {
          ...validationTime,
          qualificationBootstrapSampleId: "realtime-incident-dashboard",
          verifyCheckout: false,
        }),
      ).resolves.toBeUndefined();
      await expect(
        validateCatalog(metadataOnly.catalog, packageJson, {
          ...validationTime,
          qualificationBootstrapSampleId: "not-a-golden-sample",
          verifyCheckout: false,
        }),
      ).rejects.toThrow("qualification bootstrap requires a qualified golden sample");
    } finally {
      await rm(evidencePath, { force: true });
    }
  });

  it("bootstraps more than one golden sample against the same source without circular evidence dependencies", async () => {
    // Regression coverage for honua-io/honua-sdk-js#735: the qualification
    // bootstrap used to accept only one exempted sample id, so promoting (or
    // resealing) a second golden sample while another already exists was
    // circular — validating the catalog for either one required the other to
    // already carry a fresh, digest-matching receipt set, which neither could
    // produce first. See PR #653's "Scope note: golden-track promotion
    // deferred" for the originally-encountered failure mode.
    const packageJson = await readJson("package.json");
    const expiresAt = new Date(new Date(validationTime.now).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const incidentEvidencePath = "test-results/qualification-bootstrap-incident-evidence.json";
    const spatialEvidencePath = "test-results/qualification-bootstrap-spatial-evidence.json";

    const promoteIncident = (catalog: any) => {
      catalog.goldenJourneys.find((journey: { id: string }) => journey.id === "incident-operations").status =
        "qualified";
      const sample = catalog.samples.find(
        (candidate: { id: string }) => candidate.id === "realtime-incident-dashboard",
      );
      sample.track = "golden";
      sample.validationProfile = "golden-browser";
      sample.evidence.live = {
        mode: "demo-live",
        status: "executed",
        commands: ["npm run bench:live"],
        evidencePath: incidentEvidencePath,
        expiresAt,
      };
      return sample;
    };

    const promoteSpatialAnalytics = (catalog: any) => {
      catalog.goldenJourneys.find((journey: { id: string }) => journey.id === "cloud-native-analysis").status =
        "qualified";
      const sample = catalog.samples.find(
        (candidate: { id: string }) => candidate.id === "spatial-analytics-workbench",
      );
      sample.track = "golden";
      sample.validationProfile = "golden-browser";
      sample.supportTier = "supported";
      sample.lifecycle = { state: "active", reason: "Qualification bootstrap regression fixture." };
      sample.evidence.live = {
        mode: "demo-live",
        status: "executed",
        commands: ["npm run demo:spatial-analytics:live-evidence"],
        evidencePath: spatialEvidencePath,
        expiresAt,
      };
      return sample;
    };

    const buildCatalog = async () => {
      const catalog = await readJson("samples/catalog.v2.json");
      promoteIncident(catalog);
      promoteSpatialAnalytics(catalog);
      return catalog;
    };

    try {
      await mkdir("test-results", { recursive: true });

      const incidentEvidence = await readAttestationSeed(
        "examples/realtime-incident-dashboard/evidence/live-skipped.v1.json",
      );
      incidentEvidence.status = "executed";
      incidentEvidence.reason = null;
      incidentEvidence.provenance = {
        sourceId: "honua-demo:incident-realtime",
        observedAt: incidentEvidence.observedAt,
        validAt: null,
        state: "live",
        attribution: "Honua demo synthetic incident data",
      };
      incidentEvidence.semantics.outcome = "connected";
      incidentEvidence.timing.totalMs = 1;
      incidentEvidence.degradation = { state: "none", reasons: [] };
      await writeFile(incidentEvidencePath, `${JSON.stringify(incidentEvidence, null, 2)}\n`);

      const spatialEvidence = await readAttestationSeed(
        "examples/spatial-analytics-workbench/evidence/live-skipped.v1.json",
      );
      spatialEvidence.status = "executed";
      spatialEvidence.reason = null;
      spatialEvidence.sdk.gitCommit = "a6e2bb0785bcdebf47a1f5bd8254cf62e138963b";
      spatialEvidence.provenance = {
        sourceId: "honua-demo:spatial-analytics",
        observedAt: spatialEvidence.observedAt,
        validAt: null,
        state: "live",
        attribution: "Honua demo synthetic spatial analytics data",
      };
      spatialEvidence.semantics.outcome = "connected";
      spatialEvidence.timing.totalMs = 1;
      spatialEvidence.degradation = { state: "none", reasons: [] };
      spatialEvidence.artifacts = [
        {
          kind: "producer-generator",
          path: "examples/spatial-analytics-workbench/live-evidence.mjs",
          sha256: "0".repeat(64),
        },
      ];
      await writeFile(spatialEvidencePath, `${JSON.stringify(spatialEvidence, null, 2)}\n`);

      const catalogOptions = { ...validationTime, verifyCheckout: false, relaxDerivedArtifacts: true };

      // Neither newly-promoted golden sample has a qualification receipt set
      // yet, and neither is exempted: both failures are named together in one
      // actionable error (REQ-003) instead of surfacing only the first one
      // encountered and sending an operator chasing the other one next.
      await expect(validateCatalog(await buildCatalog(), packageJson, catalogOptions)).rejects.toThrow(
        "qualification bootstrap circularity: golden sample qualification receipts for " +
          "[realtime-incident-dashboard, spatial-analytics-workbench]",
      );

      // The single-target bootstrap can only ever exempt one sample: naming
      // just spatial-analytics-workbench still blocks on
      // realtime-incident-dashboard, which the current source cannot resolve
      // (the exact circularity issue #735 reports), and the error is explicit
      // about which sample still needs to be included.
      await expect(
        validateCatalog(await buildCatalog(), packageJson, {
          ...catalogOptions,
          qualificationBootstrapSampleId: "spatial-analytics-workbench",
        }),
      ).rejects.toThrow(
        "qualification bootstrap circularity: golden sample qualification receipts for [realtime-incident-dashboard]",
      );
      await expect(
        validateCatalog(await buildCatalog(), packageJson, {
          ...catalogOptions,
          qualificationBootstrapSampleId: "realtime-incident-dashboard",
        }),
      ).rejects.toThrow(
        "qualification bootstrap circularity: golden sample qualification receipts for [spatial-analytics-workbench]",
      );

      // Naming every golden sample that needs fresh receipts against this
      // exact source in one qualification bootstrap pass breaks the cycle
      // (REQ-001): both a string-array and, for a single id, a bare string
      // (REQ-002's backward-compatible byte-stable form) are accepted.
      await expect(
        validateCatalog(await buildCatalog(), packageJson, {
          ...catalogOptions,
          qualificationBootstrapSampleId: ["realtime-incident-dashboard", "spatial-analytics-workbench"],
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(incidentEvidencePath, { force: true });
      await rm(spatialEvidencePath, { force: true });
    }
  });

  // Look-ahead clock lane (honua-io/honua-sdk-js#1079). The three tests below
  // pin the lane's own contract, and they run in the ordinary real-time pass as
  // well as the shifted one so the lane cannot quietly rot into a no-op.
  const lookAheadOffsets = [35, 95];
  const shiftValidationClock = (days: number) => ({
    ...validationTime,
    now: new Date(Date.parse(validationTime.now) + days * 24 * 60 * 60 * 1000).toISOString(),
  });

  it("holds the shipped catalog valid against a forward-shifted validation clock", async () => {
    // The false-alarm invariant. A healthy committed attestation must still
    // pass when the validation clock is advanced past both policy horizons:
    // +35d clears the 31-day executed window and +95d the 90-day non-executed
    // one, whatever the committed observations happen to be today. Currency
    // stays pinned to the real clock (see the header) because an attestation
    // that merely falls due for renewal inside the window is the renewal
    // automation's business (#979), not a contract violation -- without that
    // split this lane would fail on every run past the shortest window and be
    // worth exactly nothing.
    const packageJson = await readJson("package.json");
    for (const days of lookAheadOffsets) {
      await expect(
        validateCatalog(await readJson("samples/catalog.v2.json"), packageJson, shiftValidationClock(days)),
      ).resolves.toBeUndefined();
    }
  });

  it("rejects a synthetic executed lane that inherits a committed attestation's observation", async () => {
    // The detector, pinned against the exact shape that broke trunk on
    // 2026-08-05 (#1078): a synthetic `executed` lane seeded from a committed
    // *skip* attestation. The skip lives under the 90-day non-executed window
    // and ages in place; the synthetic lane claims `executed` and is held to
    // the 31-day window against whatever observation it carries. Inherit the
    // seed's date and the fixture drifts out of policy on a date nobody chose.
    const packageJson = await readJson("package.json");
    const seedPath = "examples/realtime-incident-dashboard/evidence/live-skipped.v1.json";
    const evidencePath = "test-results/lookahead-inherited-observation-evidence.json";

    const buildCatalog = async (evidence: any, clock: { now: string }) => {
      const catalog = await readJson("samples/catalog.v2.json");
      const sample = catalog.samples.find(
        (candidate: { id: string }) => candidate.id === "realtime-incident-dashboard",
      );
      sample.evidence.live = {
        mode: "demo-live",
        status: "executed",
        commands: ["npm run bench:live"],
        evidencePath,
        expiresAt: new Date(Date.parse(clock.now) + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
      evidence.status = "executed";
      evidence.reason = null;
      evidence.provenance = {
        sourceId: "honua-demo:incident-realtime",
        observedAt: evidence.observedAt,
        validAt: null,
        state: "live",
        attribution: "Honua demo synthetic incident data",
      };
      evidence.semantics.outcome = "connected";
      evidence.timing.totalMs = 1;
      evidence.degradation = { state: "none", reasons: [] };
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      return catalog;
    };

    // Stands in for a committed attestation last re-observed ten days ago,
    // rather than reading however fresh the real one happens to be today. Ten
    // days is comfortably inside the executed window at the real clock
    // (10 + 7 = 17 of 31) and comfortably outside it at either look-ahead
    // offset, which is the whole premise of the lane: valid now, invalid then,
    // with nothing changing in between.
    const inheritedObservedAt = new Date(Date.parse(validationTime.now) - 10 * 24 * 60 * 60 * 1000).toISOString();

    try {
      await mkdir("test-results", { recursive: true });
      const options = { relaxDerivedArtifacts: true, verifyCheckout: false };

      for (const days of [0, ...lookAheadOffsets]) {
        const clock = shiftValidationClock(days);

        // Re-dated through readAttestationSeed: the lane is seven days wide at
        // every offset, so it passes whatever the calendar says.
        const redated = await buildCatalog(await readAttestationSeed(seedPath, clock), clock);
        await expect(validateCatalog(redated, packageJson, { ...clock, ...options })).resolves.toBeUndefined();

        // Inherited: the identical lane, except its observation stayed where
        // the seed left it. Green at the real clock and red at both look-ahead
        // offsets -- the gate reverting PR #1078 would have tripped weeks
        // early. The message names the observation the span is measured from,
        // so the fix does not require re-deriving the policy arithmetic
        // (REQ-002).
        const seed = await readAttestationSeed(seedPath, clock);
        seed.observedAt = inheritedObservedAt;
        const inherited = await buildCatalog(seed, clock);
        const assertion = expect(validateCatalog(inherited, packageJson, { ...clock, ...options }));
        if (days === 0) {
          await assertion.resolves.toBeUndefined();
        } else {
          await assertion.rejects.toThrow(
            new RegExp(
              `realtime-incident-dashboard: evidence expiry exceeds 31-day policy: .+ is ${days + 17}\\.\\d days after observation ${inheritedObservedAt}`,
            ),
          );
        }
      }
    } finally {
      await rm(evidencePath, { force: true });
    }
  });

  it("keeps every committed attestation this suite reads behind the re-dating seed reader", async () => {
    // REQ-003 as a structural rule rather than a review habit: a committed live
    // attestation may only enter this file through readAttestationSeed, which
    // re-dates its observation to the validation clock. A bare readJson of one
    // is the #738/#1078 bug verbatim, and it stays green for weeks after it is
    // written, so nothing else here can catch it.
    const source = await readFile("test/sample-contract.test.ts", "utf8");
    const bareAttestationReads = [...source.matchAll(/readJson\(\s*"([^"]*\/evidence\/live-[^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(
      bareAttestationReads,
      "read committed live attestations through readAttestationSeed so the synthetic lane carries its own observation",
    ).toEqual([]);

    // ...and the reader really does re-date, envelope and provenance alike.
    const seed = await readAttestationSeed("examples/realtime-incident-dashboard/evidence/live-skipped.v1.json");
    expect(seed.observedAt).toBe(validationTime.now);
    expect(seed.provenance?.observedAt ?? validationTime.now).toBe(validationTime.now);
  });

  it("uses one credential-safe evidence envelope for fixture, live, and unavailable lanes", async () => {
    for (const name of ["fixture", "live", "skipped"]) {
      const evidence = await readJson(`samples/contract/v1/fixtures/sample-evidence.${name}.json`);
      expect(validateEvidenceEnvelope(evidence)).toBe(evidence);
    }

    const invalid = await readJson("samples/contract/v1/fixtures/sample-evidence.skipped.json");
    invalid.reason = null;
    expect(() => validateEvidenceEnvelope(invalid)).toThrow("requires a reason");

    for (const parameter of [
      "client_secret",
      "access-token",
      "auth_token",
      "x-api-key",
      "x_amz_signature",
      "X-Goog-Signature",
      "clientSecret",
      "ｘ－ａｐｉ－ｋｅｙ",
    ]) {
      const credentialUrl = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
      credentialUrl.source.endpoint = `https://example.test/features?${parameter}=secret`;
      expect(() => validateEvidenceEnvelope(credentialUrl)).toThrow(
        `forbidden credential query parameter ${parameter}`,
      );
    }

    const benignQuery = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    benignQuery.source.endpoint =
      "https://example.test/features?monkey=1&hockey=2&keyboard=3&tokenizer=4&secretary=5&signature_version=v4&token_type=bearer";
    expect(validateEvidenceEnvelope(benignQuery)).toBe(benignQuery);

    const websocketCredentials = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    websocketCredentials.source.endpoint = "wss://publisher:password@example.test/events";
    expect(() => validateEvidenceEnvelope(websocketCredentials)).toThrow("URL must not contain embedded credentials");

    const customSchemeQuery = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    customSchemeQuery.source.identity = "s3://sample-bucket/data?clientSecret=secret";
    expect(() => validateEvidenceEnvelope(customSchemeQuery)).toThrow(
      "forbidden credential query parameter clientSecret",
    );

    for (const literal of [
      "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "AKIA1234567890ABCDEF",
      "-----BEGIN PRIVATE KEY-----",
      "client_secret=s3cr3t-value",
    ]) {
      const literalCredentialEvidence = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
      literalCredentialEvidence.source.identity = literal;
      expect(() => validateEvidenceEnvelope(literalCredentialEvidence)).toThrow("contains a credential value");
    }

    const benignCredentialLanguage = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    benignCredentialLanguage.source.identity =
      "Bearer authentication, Bearer credentials, authorization=required, and AKIA12345678 are documentation text.";
    expect(validateEvidenceEnvelope(benignCredentialLanguage)).toBe(benignCredentialLanguage);

    for (const { key, value } of [
      { key: "apiKey", value: "this-is-an-actual-secret-value-123456" },
      { key: "password", value: "correct-horse-battery-staple" },
      { key: "password", value: 8675309 },
    ]) {
      const nestedSecret = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
      nestedSecret.extra = { nested: { [key]: value } };
      expect(() => validateEvidenceEnvelope(nestedSecret)).toThrow(
        "contains a credential value under a sensitive property name",
      );
    }

    const benignSensitiveProperties = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    benignSensitiveProperties.extra = {
      apiKey: "HONUA_API_KEY",
      authorization: "required",
      clientSecret: "not-applicable",
      password: "redacted",
    };
    expect(validateEvidenceEnvelope(benignSensitiveProperties)).toBe(benignSensitiveProperties);

    const sensitiveUrlProperty = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    sensitiveUrlProperty.extra = { "s3://sample-bucket/data?password=secret": "documentation" };
    expect(() => validateEvidenceEnvelope(sensitiveUrlProperty)).toThrow(
      "forbidden credential query parameter password",
    );

    const cyclicEvidence = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cyclicEvidence.extra = cycle;
    expect(() => validateEvidenceEnvelope(cyclicEvidence)).toThrow("contains a cyclic metadata reference");

    const deepEvidence = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    let deepCursor = deepEvidence as Record<string, unknown>;
    for (let depth = 0; depth < 70; depth += 1) {
      const next: Record<string, unknown> = {};
      deepCursor.extra = next;
      deepCursor = next;
    }
    expect(() => validateEvidenceEnvelope(deepEvidence)).toThrow("exceeds the metadata depth limit of 64");

    for (const lane of ["fixture.v1", "live-skipped.v1"]) {
      const safeAgentEvidence = await readJson(`examples/ai-spatial-app-builder/evidence/${lane}.json`);
      expect(validateEvidenceEnvelope(safeAgentEvidence)).toBe(safeAgentEvidence);
    }

    const missingSource = await readJson("examples/ai-spatial-app-builder/evidence/fixture.v1.json");
    delete missingSource.source;
    expect(() => validateEvidenceEnvelope(missingSource)).toThrow("source.provider is required");

    const futureObservation = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    futureObservation.observedAt = "2026-01-01T00:10:01.000Z";
    futureObservation.provenance.observedAt = futureObservation.observedAt;
    expect(() =>
      validateEvidenceEnvelope(futureObservation, {
        now: "2026-01-01T00:05:00.000Z",
        maxFutureSkewSeconds: 300,
      }),
    ).toThrow("evidence observedAt is more than 300 seconds in the future");

    const inconsistentProvenance = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    inconsistentProvenance.provenance.observedAt = "2026-01-01T00:06:01.000Z";
    expect(() =>
      validateEvidenceEnvelope(inconsistentProvenance, {
        now: "2026-01-01T01:00:00.000Z",
        maxFutureSkewSeconds: 300,
      }),
    ).toThrow("evidence provenance.observedAt cannot follow evidence observedAt beyond clock skew");
  });

  it("records the configured live-data endpoint instead of the proposal host", async () => {
    const outputPath = "test-results/ai-spatial-app-builder-live-evidence.json";
    try {
      const { stdout } = await execFileAsync(process.execPath, ["examples/ai-spatial-app-builder/live-evidence.mjs"], {
        env: {
          ...process.env,
          HONUA_AGENT_HOST_URL: "https://agent.example.test/proposals",
          HONUA_LIVE_DATA_URL: "https://data.example.test/features",
        },
      });
      const evidence = JSON.parse(stdout);
      expect(evidence.source.endpoint).toBe("https://data.example.test/features");
      expect(evidence.reason).toContain("no request was sent");
    } finally {
      await rm(outputPath, { force: true });
    }
  });

  it("content-binds executed live evidence to its current generator, sample, and journey", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const sample = catalog.samples.find((candidate: { id: string }) => candidate.id === "maplibre-quickstart");
    expect(sample.evidence.live).toMatchObject({
      mode: "public-live",
      status: "executed",
      commands: ["npm run evidence:first-map:live"],
      evidencePath: "samples/evidence/maplibre-quickstart/live.v1.json",
    });
    // refresh-live-expiry (honua-io/honua-sdk-js#788) recomputes this from
    // the live lane's own fresh evidence every reseal, so it legitimately
    // moves on every reseal rather than pinning to one qualification day;
    // assert it is a well-formed, currently-unexpired RFC 3339 date-time
    // instead of a fixed literal.
    expect(new Date(sample.evidence.live.expiresAt).toISOString()).toBe(sample.evidence.live.expiresAt);
    expect(Date.parse(sample.evidence.live.expiresAt)).toBeGreaterThan(Date.now());
    const evidence = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    evidence.sampleId = sample.id;
    delete evidence.realtime;
    evidence.semantics.operation = "first-map-anonymous-public-endpoint";
    evidence.semantics.outcome = "map-popup-filter-plan-ready";
    evidence.artifacts = [
      {
        kind: "producer-generator",
        path: "scripts/first-map-live-evidence.mjs",
        sha256: createHash("sha256")
          .update(await readFile("scripts/first-map-live-evidence.mjs"))
          .digest("hex"),
      },
    ];

    expect(validateEvidenceEnvelope(evidence)).toBe(evidence);
    await expect(validateLiveEvidenceProducer(evidence, sample)).resolves.toBeUndefined();

    const nonBenchSample = structuredClone(sample);
    nonBenchSample.evidence.live.commands = ["npm run demo:spatial-analytics:live-evidence"];
    const nonBenchGeneratorPath = "examples/spatial-analytics-workbench/live-evidence.mjs";
    const nonBenchEvidence = structuredClone(evidence);
    nonBenchEvidence.artifacts[0] = {
      kind: "producer-generator",
      path: nonBenchGeneratorPath,
      sha256: createHash("sha256")
        .update(await readFile(nonBenchGeneratorPath))
        .digest("hex"),
    };
    await expect(validateLiveEvidenceProducer(nonBenchEvidence, nonBenchSample)).resolves.toBeUndefined();

    const skippedCatalog = await readJson("samples/catalog.v2.json");
    const skippedSample = skippedCatalog.samples.find(
      (candidate: { id: string }) => candidate.id === "realtime-incident-dashboard",
    );
    const skippedEvidence = await readJson(skippedSample.evidence.live.evidencePath);
    await expect(validateLiveEvidenceProducer(skippedEvidence, skippedSample)).resolves.toBeUndefined();

    const staleSkippedProducer = structuredClone(skippedEvidence);
    staleSkippedProducer.artifacts[0].sha256 = "0".repeat(64);
    await expect(validateLiveEvidenceProducer(staleSkippedProducer, skippedSample)).rejects.toThrow(
      "producer generator digest drift",
    );
    await expect(
      validateLiveEvidenceProducer(staleSkippedProducer, skippedSample, { relaxed: true }),
    ).resolves.toBeUndefined();

    const misplacedSkippedProducer = structuredClone(skippedEvidence);
    misplacedSkippedProducer.artifacts[0].path = "package.json";
    misplacedSkippedProducer.artifacts[0].sha256 = createHash("sha256")
      .update(await readFile("package.json"))
      .digest("hex");
    await expect(validateLiveEvidenceProducer(misplacedSkippedProducer, skippedSample)).rejects.toThrow(
      "producer generator path for npm run bench:live must be scripts/live-benchmark-evidence.mjs",
    );

    const unclaimedSkippedProducer = structuredClone(skippedEvidence);
    unclaimedSkippedProducer.artifacts = [];
    await expect(validateLiveEvidenceProducer(unclaimedSkippedProducer, skippedSample)).resolves.toBeUndefined();

    const arbitraryFile = structuredClone(nonBenchEvidence);
    arbitraryFile.artifacts[0].path = "package.json";
    arbitraryFile.artifacts[0].sha256 = createHash("sha256")
      .update(await readFile("package.json"))
      .digest("hex");
    await expect(validateLiveEvidenceProducer(arbitraryFile, nonBenchSample)).rejects.toThrow(
      `producer generator path for npm run demo:spatial-analytics:live-evidence must be ${nonBenchGeneratorPath}`,
    );

    const wrongPathAndDigest = structuredClone(nonBenchEvidence);
    wrongPathAndDigest.artifacts[0].path = "package.json";
    wrongPathAndDigest.artifacts[0].sha256 = "0".repeat(64);
    await expect(validateLiveEvidenceProducer(wrongPathAndDigest, nonBenchSample)).rejects.toThrow(
      `producer generator path for npm run demo:spatial-analytics:live-evidence must be ${nonBenchGeneratorPath}`,
    );

    const otherReviewedGenerator = structuredClone(nonBenchEvidence);
    otherReviewedGenerator.artifacts[0].path = "scripts/overture-live-evidence.mjs";
    otherReviewedGenerator.artifacts[0].sha256 = createHash("sha256")
      .update(await readFile("scripts/overture-live-evidence.mjs"))
      .digest("hex");
    await expect(validateLiveEvidenceProducer(otherReviewedGenerator, nonBenchSample)).rejects.toThrow(
      `producer generator path for npm run demo:spatial-analytics:live-evidence must be ${nonBenchGeneratorPath}`,
    );

    const ambiguousCommand = structuredClone(evidence);
    const ambiguousSample = structuredClone(sample);
    ambiguousSample.evidence.live.commands.push("npm run demo:spatial-analytics:live-evidence");
    await expect(validateLiveEvidenceProducer(ambiguousCommand, ambiguousSample)).rejects.toThrow(
      "executed live evidence requires exactly one reviewed producer command",
    );

    evidence.sdk.gitCommit = "e9ccbdb6e443f9abd3c97026d31e135f39bc0bc0";
    await expect(validateLiveEvidenceProducer(evidence, sample)).resolves.toBeUndefined();

    const missingRevision = structuredClone(evidence);
    missingRevision.sdk.gitCommit = null;
    expect(() => validateEvidenceEnvelope(missingRevision)).toThrow(
      "executed live evidence requires a full reported source revision",
    );
    const emptyRevision = structuredClone(evidence);
    emptyRevision.sdk.gitCommit = "";
    expect(() => validateEvidenceEnvelope(emptyRevision)).toThrow(
      "evidence sdk.gitCommit must be null or a full reported source revision",
    );
    const missingProducer = structuredClone(evidence);
    missingProducer.artifacts = [];
    expect(() => validateEvidenceEnvelope(missingProducer)).toThrow(
      "executed live evidence requires a producer-generator artifact",
    );

    evidence.artifacts[0].sha256 = "0".repeat(64);
    await expect(validateLiveEvidenceProducer(evidence, sample)).rejects.toThrow("producer generator digest drift");
    evidence.artifacts[0].sha256 = createHash("sha256")
      .update(await readFile(evidence.artifacts[0].path))
      .digest("hex");
    evidence.semantics.operation = "unsupported-old-journey";
    await expect(validateLiveEvidenceProducer(evidence, sample)).rejects.toThrow(
      "producer generator does not support this journey",
    );
  });

  // PR #786 review: cog.contractPath/contractSha256 previously recorded the
  // pinned STAC/COG contract's digest without the validator ever opening the
  // file to check it, so a swapped or tampered contract would still pass.
  it("rejects a tampered or missing pinned COG contract behind its recorded digest", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const sample = catalog.samples.find((candidate: { id: string }) => candidate.id === "imagery-cog-quickstart");
    const evidence = await readJson(sample.evidence.live.evidencePath);
    expect(evidence.cog.contractPath).toBe("test/fixtures/cog/public-earth-search-sentinel-2.json");
    expect(evidence.cog.contractSha256).toBe(
      createHash("sha256")
        .update(await readFile(evidence.cog.contractPath))
        .digest("hex"),
    );
    await expect(validateLiveEvidenceProducer(evidence, sample)).resolves.toBeUndefined();

    const digestDrift = structuredClone(evidence);
    digestDrift.cog.contractSha256 = "0".repeat(64);
    await expect(validateLiveEvidenceProducer(digestDrift, sample)).rejects.toThrow("pinned COG contract digest drift");
    // The same drift is a no-op at PR time, before the trunk reseal that
    // would bind it, mirroring the adjacent producer-generator digest check.
    await expect(validateLiveEvidenceProducer(digestDrift, sample, { relaxed: true })).resolves.toBeUndefined();

    const swappedContent = structuredClone(evidence);
    swappedContent.cog.contractPath = "package.json";
    swappedContent.cog.contractSha256 = createHash("sha256")
      .update(await readFile("package.json"))
      .digest("hex");
    await expect(validateLiveEvidenceProducer(swappedContent, sample)).resolves.toBeUndefined();

    const missingContract = structuredClone(evidence);
    missingContract.cog.contractPath = "test/fixtures/cog/does-not-exist.json";
    await expect(validateLiveEvidenceProducer(missingContract, sample)).rejects.toThrow(
      "pinned COG contract test/fixtures/cog/does-not-exist.json is missing",
    );

    const escapingContract = structuredClone(evidence);
    escapingContract.cog.contractPath = "../outside.json";
    await expect(validateLiveEvidenceProducer(escapingContract, sample)).rejects.toThrow(
      "cog.contractPath must stay inside the repository",
    );
  });

  it("binds browser artifacts to build inputs, peers, SHA-256, and SRI", async () => {
    const manifest = await buildBrowserArtifactManifest({
      artifacts: [{ path: "test/fixtures/sample-contract/browser.js", entrypoint: "fixture" }],
      gitCommit: "1111111111111111111111111111111111111111",
    });

    expect(manifest.files[0]).toMatchObject({
      entrypoint: "fixture",
      integrity: expect.stringMatching(/^sha256-/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(manifest.build.inputs.length).toBeGreaterThan(250);
    expect(manifest.compatibility.peers).toHaveProperty("maplibre-gl");
    await expect(verifyBrowserArtifactManifest(manifest)).resolves.toBeUndefined();

    manifest.files[0].sha256 = "0".repeat(64);
    await expect(verifyBrowserArtifactManifest(manifest)).rejects.toThrow("SHA-256 drift");
  });
});
