import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCertificationDenominator,
  COUNTING_TIER,
  evaluateRendererRequirement,
  mapLibreNativeBindings,
  DENOMINATOR_PATH,
  DENOMINATOR_SCHEMA_PATH,
  digestBytes,
  evaluateCertificationRun,
  loadCertificationDenominatorInputs,
  SUPPORT_MANIFEST_PATH,
  validateCertificationDenominatorSchema,
} from "../../scripts/certification-denominator.mjs";
import { evaluateCertificationDenominator } from "../../scripts/verify-certification-denominator.mjs";

// honua-io/honua-sdk-js#39 AC1: "the denominator and active capability/profile
// digests are frozen before execution". Everything downstream of that criterion
// counts against config/certification-denominator.v1.json, so the artifact has
// to be generated from the manifests rather than written by hand, and the ways
// it can quietly stop being true have to fail rather than pass:
//
//   - a `supported` row that exists in a manifest and not in the denominator
//     would never be certified, and the run would still report 100%;
//   - a beta/experimental/facade-required/deprecated row counted as a supported
//     pass inflates the numerator with work #39 explicitly does not accept;
//   - a manifest that changes after the freeze silently redefines the target;
//   - an environment skip that satisfies a supported row is the difference
//     between "executed from installed bytes" and "we did not run it".
//
// Each of these is driven with a fixture below, because a gate that only
// describes its failure modes is not a gate.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const inputs = loadCertificationDenominatorInputs();
const frozenText = fs.readFileSync(path.join(ROOT, DENOMINATOR_PATH), "utf8");
const frozen = JSON.parse(frozenText);
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, DENOMINATOR_SCHEMA_PATH), "utf8"));

/** Deep-clone the real inputs so a fixture can change one manifest fact in isolation. */
function cloneInputs() {
  return {
    supportManifest: structuredClone(inputs.supportManifest),
    protocolCertification: structuredClone(inputs.protocolCertification),
    sdkCoverage: structuredClone(inputs.sdkCoverage),
    coverageCrosswalk: structuredClone(inputs.coverageCrosswalk),
    capabilityCrosswalk: structuredClone(inputs.capabilityCrosswalk),
    releaseArtifacts: structuredClone(inputs.releaseArtifacts),
    adminMcpCoverage: structuredClone(inputs.adminMcpCoverage),
    appPlatformQualification: structuredClone(inputs.appPlatformQualification),
    journey: structuredClone(inputs.journey),
    mapPackageSchema: structuredClone(inputs.mapPackageSchema),
    sourceBridgeSource: inputs.sourceBridgeSource,
    inputDigests: structuredClone(inputs.inputDigests),
  };
}

/**
 * Re-digest one input the way loadCertificationDenominatorInputs would after the
 * file on disk changed. Without this a fixture would change a manifest's meaning
 * while leaving the digest that the freeze was taken against, which is not the
 * situation the gate is being asked about.
 */
function redigest(copy, relativePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const entry = copy.inputDigests.find((input) => input.path === relativePath);
  assert.ok(entry, `${relativePath} is not a declared denominator input`);
  entry.bytes = Buffer.byteLength(text, "utf8");
  entry.sha256 = digestBytes(text);
}

/** Evaluate the real frozen artifact against mutated inputs. */
function withInputs(mutate) {
  const copy = cloneInputs();
  mutate(copy);
  return evaluateCertificationDenominator({ frozen, frozenText, inputs: copy }).errors;
}

/** Evaluate a mutated frozen artifact against the real inputs. */
function withFrozen(mutate) {
  const copy = structuredClone(frozen);
  mutate(copy);
  return evaluateCertificationDenominator({ frozen: copy, frozenText: null, inputs }).errors;
}

function rowById(denominator, id) {
  const row = denominator.rows.find((entry) => entry.id === id);
  assert.ok(row, `no denominator row "${id}"`);
  return row;
}

function firstRow(denominator, predicate, label) {
  const row = denominator.rows.find(predicate);
  assert.ok(row, `no denominator row matching ${label}`);
  return row;
}

/** A full, clean certification run: every counting row passed from installed bytes. */
function passingResults(denominator) {
  return denominator.rows
    .filter((row) => row.counts)
    .map((row) => ({ rowId: row.id, status: "passed", countedAsSupported: true }));
}

test("the frozen denominator satisfies its own schema", async () => {
  assert.deepEqual(await validateCertificationDenominatorSchema(frozen, schema), []);
});

test("the frozen denominator still describes the manifests it was generated from", () => {
  const { errors } = evaluateCertificationDenominator({ frozen, frozenText, inputs });
  assert.deepEqual(errors, []);
});

test("every denominator row names the manifest row it was derived from", () => {
  // The hard constraint on this artifact: it is generated, never hand-authored.
  // A row with no source pointer is a row somebody typed.
  for (const row of frozen.rows) {
    assert.ok(row.source?.path && row.source?.pointer, `row "${row.id}" has no manifest source`);
    assert.ok(
      frozen.inputs.some((input) => input.path === row.source.path),
      `row "${row.id}" cites ${row.source.path}, which is not a digested denominator input`,
    );
  }
});

test("only supported rows count, and every other tier stays visible", () => {
  const nonCounting = frozen.rows.filter((row) => !row.counts);
  assert.ok(nonCounting.length > 0, "expected the denominator to retain non-counting rows");
  for (const tier of ["beta", "experimental", "facade-required", "deprecated"]) {
    assert.ok(frozen.summary.byTier[tier] > 0, `no ${tier} rows survived into the denominator`);
    assert.ok(
      frozen.rows.filter((row) => row.tier === tier).every((row) => row.counts === false),
      `a ${tier} row counts toward the supported denominator`,
    );
  }
  for (const row of frozen.rows.filter((row) => row.counts)) {
    assert.equal(row.tier, COUNTING_TIER, `counting row "${row.id}" is not ${COUNTING_TIER}`);
    assert.equal(row.environmentSkipAllowed, false, `counting row "${row.id}" permits an environment skip`);
  }
});

test("tiers are copied from the support manifest, never promoted", () => {
  const statuses = new Map((inputs.supportManifest.supportClaims ?? []).map((claim) => [claim.id, claim.status]));
  for (const row of frozen.rows.filter((entry) => entry.family === "sdk-operation")) {
    assert.equal(row.tier, statuses.get(row.subject), `sdk-operation row "${row.id}" drifted from its claim status`);
  }
  // The case that makes the rule concrete: ogc-tiles ships beta for 2026.1, and
  // its protocol-adapter operationClaims say `supported`. The row keeps the
  // status its own manifest entry carries and is capped by the beta claim, so
  // no reading of the manifest turns OGC Tiles into a supported pass.
  assert.equal(rowById(frozen, "sdk-operation:ogc-tiles-standalone:tiles").tier, "beta");
  const adapterRow = rowById(frozen, "protocol-operation:ogc-tiles:tiles");
  assert.equal(adapterRow.tier, "supported");
  assert.equal(adapterRow.cappedBy?.tier, "beta");
  assert.equal(adapterRow.counts, false);
});

test("a claim naming a protocol the protocol table does not list is still tiered", () => {
  // ogc-processes has two supportClaims and no `protocols` entry. Reading only
  // the protocol table would leave process.ogc-api-processes with no
  // contributor and quietly demote every OGC Processes certification row to
  // `unmapped`, where it could never count.
  const claims = new Map((inputs.supportManifest.supportClaims ?? []).map((claim) => [claim.id, claim]));
  assert.equal(claims.get("ogc-processes-discovery-standalone").protocol, "ogc-processes");
  assert.ok(
    !(inputs.supportManifest.protocols ?? []).some((protocol) => protocol.id === "ogc-processes"),
    "ogc-processes is now in the protocol table; this test's premise needs revisiting",
  );
  assert.equal(frozen.profiles.capability["process.ogc-api-processes"].tier, COUNTING_TIER);
  assert.equal(rowById(frozen, "protocol-certification:ogc-processes:landing").tier, COUNTING_TIER);
});

test("the denominator enumerates the open-endpoint protocol rows 2026.1 retains", () => {
  // #39 names these surfaces by hand; assert them by hand so a manifest edit
  // that quietly narrows the certification is a test failure.
  for (const surface of [
    "featureserver",
    "mapserver",
    "imageserver",
    "gpserver",
    "ogc-features",
    "wfs",
    "wms",
    "wmts",
    "stac",
    "odata",
  ]) {
    const rows = frozen.rows.filter((row) => row.family === "protocol-certification" && row.subject === surface);
    assert.ok(rows.length > 0, `no protocol-certification rows for ${surface}`);
    assert.ok(
      rows.every((row) => row.counts),
      `${surface} rows are not counting rows in the frozen denominator`,
    );
  }
});

test("the denominator carries the terminal journey, its admin projections and a renderer row", () => {
  const journeyRows = frozen.rows.filter((row) => row.family === "terminal-journey");
  assert.equal(
    journeyRows.length,
    inputs.journey.stages.reduce((total, stage) => total + stage.actions.length, 0),
  );
  const projected = journeyRows.filter((row) => row.adminProjection !== null);
  assert.ok(projected.length > 0, "no journey action resolved to a generated Admin REST projection");
  for (const row of projected) {
    assert.match(row.adminProjection.path, /^\//u);
  }
  assert.ok(
    frozen.rows.some((row) => row.renderer === true && row.counts),
    "no counting MapLibre rendering row",
  );
});

test("the renderer rows are bound to the protocols the portable map artifact can carry", () => {
  // "Representative MapLibre rendering from the portable map artifact" only
  // means something while the denominator and schemas/honua-map-package.v1.json
  // agree on which protocols a portable map can bind a source to.
  const schemaProtocols = new Set(frozen.portableMapArtifact.sourceProtocols);
  assert.ok(schemaProtocols.size > 0, "the map-package schema declares no source protocols");
  // A protocol row belongs to the portable map artifact by either route: the
  // artifact binds a source to it directly, or the artifact binds a source to
  // something that renders through it (src/runtime/source-bridge.ts).
  const rendersFor = new Set(Object.keys(frozen.portableMapArtifact.rendererBindings));
  for (const row of frozen.rows.filter((entry) => entry.family === "protocol-operation")) {
    assert.equal(
      row.portableMapArtifact,
      schemaProtocols.has(row.subject) || rendersFor.has(row.subject),
      `row "${row.id}" disagrees with the portable map artifact about ${row.subject}`,
    );
  }
  assert.ok(frozen.summary.portableMapArtifact > 0);

  // And the guard: a schema whose source bindings this gate can no longer read
  // must fail rather than quietly untag every row.
  const blind = cloneInputs();
  blind.mapPackageSchema = { $id: blind.mapPackageSchema.$id, title: blind.mapPackageSchema.title, $defs: {} };
  assert.ok(
    buildCertificationDenominator(blind).errors.some((error) => error.includes("declares no source bindings")),
    "an unreadable map-package schema must fail",
  );
});

test("representative MapLibre rendering is proven FROM the portable map artifact, not beside it", () => {
  // The conjunction #39 actually requires. Tagging renderer rows and portable
  // rows independently is not it: if no row carries both, a run can pass an
  // unrelated renderer row plus an unrelated portable row and never render a
  // portable map. This asserts the intersection is non-empty and counting.
  const combined = frozen.rows.filter((row) => row.renderer === true && row.portableMapArtifact === true);
  assert.ok(combined.length > 0, "no row is both a renderer row and bound to the portable map artifact");
  assert.equal(frozen.summary.rendererFromPortableMapArtifact, combined.length);
  for (const row of combined) {
    assert.ok(row.counts, `combined row "${row.id}" does not count`);
    assert.ok(
      row.portableMapArtifactBindings.length > 0,
      `combined row "${row.id}" names no portable map artifact source binding`,
    );
    for (const binding of row.portableMapArtifactBindings) {
      assert.ok(
        frozen.portableMapArtifact.sourceProtocols.includes(binding),
        `row "${row.id}" claims binding "${binding}", which the map-package schema does not declare`,
      );
    }
  }
});

test("the renderer-to-portable-artifact join is read out of source-bridge.ts", () => {
  // Derived, not restated: toMapLibreNativeSource IS the translation from a
  // portable map artifact source binding to a MapLibre pipeline.
  const derived = mapLibreNativeBindings(inputs.sourceBridgeSource);
  assert.deepEqual(Object.fromEntries([...derived].sort()), frozen.portableMapArtifact.rendererBindings);
  assert.deepEqual(derived.get("maplibre-vector"), ["ogc-tiles", "vector-tile"]);
  assert.deepEqual(derived.get("maplibre-raster"), ["ogc-maps", "raster-tile"]);

  // And the guard: a source file this gate can no longer read must fail loudly
  // rather than quietly emptying the intersection back to zero.
  assert.equal(mapLibreNativeBindings("// rewritten\n").size, 0);
  const blind = cloneInputs();
  blind.sourceBridgeSource = "// rewritten\n";
  const blindErrors = buildCertificationDenominator(blind).errors;
  assert.ok(
    blindErrors.some((error) => error.includes(`traced to a MapLibre pipeline through`)),
    `an unreadable source-bridge must fail loudly: ${blindErrors.join("\n")}`,
  );
  assert.ok(
    blindErrors.some((error) => error.includes("BOTH a renderer row and bound to the portable map artifact")),
    `an unreadable source-bridge must fail the conjunction invariant: ${blindErrors.join("\n")}`,
  );
});

test("satisfying renderer and portable separately does not satisfy the combined requirement", () => {
  // The exact pre-fix shape: the flags exist but no row carries both. Passing
  // one of each must NOT certify "MapLibre rendering from the portable map
  // artifact" -- nothing in that pair ever rendered a portable map.
  const split = structuredClone(frozen);
  for (const row of split.rows) {
    if (row.renderer === true && row.portableMapArtifact === true) row.portableMapArtifact = false;
  }
  assert.ok(
    split.rows.some((row) => row.renderer === true && row.counts),
    "fixture must still contain a counting renderer row",
  );
  assert.ok(
    split.rows.some((row) => row.portableMapArtifact === true && row.counts),
    "fixture must still contain a counting portable row",
  );
  assert.equal(
    split.rows.filter((row) => row.renderer === true && row.portableMapArtifact === true).length,
    0,
    "fixture must contain no combined row",
  );

  const errors = evaluateCertificationRun({ denominator: split, results: passingResults(split) });
  assert.ok(
    errors.some((error) => error.includes("does not satisfy the conjunction")),
    `a run passing renderer and portable rows separately was accepted: ${errors.join("\n")}`,
  );

  // A denominator with no combined row cannot certify the requirement at all,
  // however complete the rest of the run is.
  assert.ok(
    evaluateRendererRequirement({ denominator: split, results: passingResults(split) }).length > 0,
    "the renderer requirement must be unsatisfiable without a combined row",
  );
});

test("the one row proving portable-artifact rendering may not be skipped or failed", () => {
  const combined = frozen.rows.filter((row) => row.renderer === true && row.portableMapArtifact === true && row.counts);
  for (const status of ["skipped", "failed"]) {
    const results = passingResults(frozen).map((result) =>
      combined.some((row) => row.id === result.rowId) ? { rowId: result.rowId, status } : result,
    );
    const errors = evaluateRendererRequirement({ denominator: frozen, results });
    assert.ok(
      errors.some((error) => error.includes("passed")),
      `${status}: the renderer requirement was treated as satisfied`,
    );
  }
});

test("the frozen digests cover every manifest the denominator was derived from", () => {
  const digested = frozen.inputs.map((input) => input.path).sort();
  for (const required of [
    SUPPORT_MANIFEST_PATH,
    "config/protocol-certification.v1.json",
    "config/sdk-coverage.v1.json",
    "config/sdk-coverage-crosswalk.v1.json",
    "config/capability-crosswalk.v1.json",
    "config/release-artifacts.v1.json",
    "config/admin-mcp-coverage.v1.json",
    "config/app-platform-reference-qualification.v1.json",
    "mcp/release/zero-to-map/journey.v1.json",
    "schemas/honua-map-package.v1.json",
    "src/runtime/source-bridge.ts",
  ]) {
    assert.ok(digested.includes(required), `${required} is not digested into the freeze`);
  }
  for (const input of frozen.inputs) {
    const onDisk = digestBytes(fs.readFileSync(path.join(ROOT, input.path), "utf8"));
    assert.equal(input.sha256, onDisk, `${input.path} digest is stale`);
  }
});

// --- Negative controls -------------------------------------------------------

test("a supported row silently dropped from the denominator fails the gate", () => {
  const dropped = firstRow(frozen, (row) => row.family === "sdk-operation" && row.counts, "a counting SDK row");
  const errors = withFrozen((copy) => {
    copy.rows = copy.rows.filter((row) => row.id !== dropped.id);
  });
  assert.ok(
    errors.some((error) => error.includes(dropped.id) && error.includes("is absent from")),
    errors.join("\n"),
  );
});

test("a non-supported row promoted to a supported pass fails the gate", () => {
  const beta = firstRow(frozen, (row) => row.tier === "beta", "a beta row");
  const flipped = withFrozen((copy) => {
    const row = copy.rows.find((entry) => entry.id === beta.id);
    row.counts = true;
    row.environmentSkipAllowed = false;
  });
  assert.ok(
    flipped.some((error) => error.includes(beta.id) && error.includes(`only ${COUNTING_TIER} rows may count`)),
    flipped.join("\n"),
  );

  // The other way of promoting one: rewrite the tier itself. The manifest is
  // still the authority, so the drift comparison catches it.
  const retiered = withFrozen((copy) => {
    copy.rows.find((entry) => entry.id === beta.id).tier = COUNTING_TIER;
  });
  assert.ok(
    retiered.some((error) => error.includes(beta.id) && error.includes(`is tier "${COUNTING_TIER}"`)),
    retiered.join("\n"),
  );
});

test("a facade-required or experimental row promoted to counting fails the gate", () => {
  for (const tier of ["experimental", "facade-required", "deprecated"]) {
    const row = firstRow(frozen, (entry) => entry.tier === tier, `a ${tier} row`);
    const errors = withFrozen((copy) => {
      const target = copy.rows.find((entry) => entry.id === row.id);
      target.counts = true;
      target.environmentSkipAllowed = false;
    });
    assert.ok(
      errors.some((error) => error.includes(row.id) && error.includes(`only ${COUNTING_TIER} rows may count`)),
      `${tier}: ${errors.join("\n")}`,
    );
  }
});

test("an input manifest that changed without regeneration fails the gate", () => {
  // A new supported operation on an existing claim: the exact drift a
  // hand-maintained denominator absorbs silently.
  const errors = withInputs((copy) => {
    const claim = copy.supportManifest.supportClaims.find((entry) => entry.id === "wfs-standalone");
    assert.ok(claim, "wfs-standalone claim is missing from the support manifest");
    claim.operations = [...claim.operations, "queryAggregate"];
    redigest(copy, SUPPORT_MANIFEST_PATH, copy.supportManifest);
  });
  assert.ok(
    errors.some((error) => error.includes(SUPPORT_MANIFEST_PATH) && error.includes("was frozen against")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some(
      (error) => error.includes("sdk-operation:wfs-standalone:queryAggregate") && error.includes("is absent from"),
    ),
    errors.join("\n"),
  );
});

test("a journey step added after the freeze fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.journey.stages[0].actions.push({
      id: "install-verify-registry-identity",
      title: "Verify the installed package identity",
      kind: "cli",
      args: ["admin", "install", "verify"],
    });
    redigest(copy, "mcp/release/zero-to-map/journey.v1.json", copy.journey);
  });
  assert.ok(
    errors.some((error) => error.includes("terminal-journey:install:install-verify-registry-identity")),
    errors.join("\n"),
  );
});

test("a journey admin tool the Admin projection no longer publishes fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.adminMcpCoverage.projected = copy.adminMcpCoverage.projected.filter(
      (entry) => entry.toolName !== "honua_admin_layer_publish",
    );
    redigest(copy, "config/admin-mcp-coverage.v1.json", copy.adminMcpCoverage);
  });
  assert.ok(
    errors.some((error) => error.includes("honua_admin_layer_publish") && error.includes("does not project")),
    errors.join("\n"),
  );
});

test("a derivation that stops producing rows fails loudly instead of shrinking the denominator", () => {
  // The failure mode #1337's gate learned the hard way: a join that silently
  // matches nothing leaves a smaller artifact that still reports "no drift".
  const emptied = buildCertificationDenominator({
    ...cloneInputs(),
    protocolCertification: { ...structuredClone(inputs.protocolCertification), operations: [] },
  });
  assert.ok(
    emptied.errors.some((error) => error.includes('no "protocol-certification" rows')),
    emptied.errors.join("\n"),
  );

  const noRenderer = cloneInputs();
  for (const protocol of noRenderer.supportManifest.protocols) {
    for (const claim of protocol.operationClaims ?? []) {
      if (claim.environment === "client-only") claim.environment = "protocol-adapter";
    }
  }
  assert.ok(
    buildCertificationDenominator(noRenderer).errors.some((error) => error.includes("counting renderer row")),
    "an emptied renderer set must fail",
  );
});

// --- Counting policy for the run itself --------------------------------------

test("a clean run in which every supported row executed is accepted", () => {
  assert.deepEqual(evaluateCertificationRun({ denominator: frozen, results: passingResults(frozen) }), []);
});

test("an environment skip may not satisfy a supported row", () => {
  const target = firstRow(frozen, (row) => row.counts, "a counting row");
  const results = passingResults(frozen).map((result) =>
    result.rowId === target.id
      ? { rowId: result.rowId, status: "skipped", skipReason: "live-lane-disabled" }
      : result,
  );
  const errors = evaluateCertificationRun({ denominator: frozen, results });
  assert.deepEqual(errors, [
    `supported row "${target.id}" was satisfied by an environment skip (live-lane-disabled); a supported row may not pass through an environment skip`,
  ]);
});

test("a supported row with no result at all fails the run", () => {
  const target = firstRow(frozen, (row) => row.counts, "a counting row");
  const results = passingResults(frozen).filter((result) => result.rowId !== target.id);
  assert.deepEqual(evaluateCertificationRun({ denominator: frozen, results }), [
    `supported row "${target.id}" has no certification result; zero supported rows may be skipped`,
  ]);
});

test("a beta, experimental or facade-required result may not be counted as a supported pass", () => {
  for (const tier of ["beta", "experimental", "facade-required", "deprecated", "unmapped"]) {
    const row = firstRow(frozen, (entry) => entry.tier === tier, `a ${tier} row`);
    const errors = evaluateCertificationRun({
      denominator: frozen,
      results: [...passingResults(frozen), { rowId: row.id, status: "passed", countedAsSupported: true }],
    });
    assert.ok(
      errors.some((error) => error.includes(row.id) && error.includes(`is a ${tier} row and was counted`)),
      `${tier}: ${errors.join("\n")}`,
    );
  }
});

test("a non-counting row may be reported without being counted", () => {
  const row = firstRow(frozen, (entry) => !entry.counts, "a non-counting row");
  assert.deepEqual(
    evaluateCertificationRun({
      denominator: frozen,
      results: [...passingResults(frozen), { rowId: row.id, status: "skipped", skipReason: "beta row" }],
    }),
    [],
  );
});

test("a result for a row that is not in the denominator fails the run", () => {
  const errors = evaluateCertificationRun({
    denominator: frozen,
    results: [...passingResults(frozen), { rowId: "sdk-operation:invented:query", status: "passed" }],
  });
  assert.ok(
    errors.some((error) => error.includes("is not a denominator row")),
    errors.join("\n"),
  );
});

test("a supported row that failed from installed bytes fails the run", () => {
  const target = firstRow(frozen, (row) => row.counts, "a counting row");
  const results = passingResults(frozen).map((result) =>
    result.rowId === target.id ? { rowId: result.rowId, status: "failed" } : result,
  );
  assert.ok(
    evaluateCertificationRun({ denominator: frozen, results }).some(
      (error) => error.includes(target.id) && error.includes("did not pass from installed bytes"),
    ),
  );
});
