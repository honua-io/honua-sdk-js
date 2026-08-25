import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildAppPlatformReferenceQualification } from "../../scripts/app-platform-reference-qualification.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
const inputs = () => ({
  evidence: readJson("config/app-platform-reference-evidence.v1.json"),
  maturity: readJson("config/component-qualification.v1.json"),
  bundleBudgets: readJson("bundle-budgets.json"),
});
const build = (value, now = "2026-08-15T00:00:00.000Z") =>
  buildAppPlatformReferenceQualification(value, {
    now: Date.parse(now),
    fileExists: (relative) => fs.existsSync(path.join(ROOT, relative)),
    readText: (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8"),
  });

test("derives supported component rows from maturity metadata and reviewed evidence", () => {
  const result = build(inputs());
  assert.deepEqual(result.failures, []);
  assert.equal(result.matrix.packageMode, "packed");
  assert.equal(result.matrix.zeroEgress, true);
  assert.deepEqual(result.matrix.journey, ["connect", "map", "inspect", "filter", "edit", "table", "export"]);
  assert.equal(result.matrix.summary.supportedComponents, 2);
  assert.equal(result.matrix.summary.componentsWithBrowserEvidence, 2);
  const inspection = result.matrix.components.find((component) => component.id === "web-components.feature-inspection");
  const editor = result.matrix.components.find((component) => component.id === "web-components.feature-editor");
  assert.ok(inspection.qualifiedGates.includes("browser-functional"));
  assert.ok(inspection.openGates.includes("reference.automated-axe"));
  assert.ok(inspection.openGates.includes("reference.manual-screen-reader"));
  assert.ok(editor.openGates.includes("reference.browser-functional"));
  assert.ok(editor.openGates.includes("reference.automated-axe"));
  assert.ok(editor.openGates.includes("reference.manual-screen-reader"));
  assert.ok(!editor.qualifiedGates.includes("browser-functional"));
  assert.equal(result.matrix.budgets.find((budget) => budget.id === "retained-heap").status, "open");
  assert.equal(result.matrix.summary.openBudgetGates, 1);
});

test("rejects budget evidence that turns an open measurement gap into a passing-looking citation", () => {
  const value = inputs();
  value.evidence.budgets.find((budget) => budget.id === "retained-heap").evidence = [
    "test/playwright/web-components-memory-leak.spec.mjs",
  ];
  const result = build(value);
  assert.ok(result.failures.some((failure) => failure.includes("must not cite evidence as if it passed")));
});

test("does not infer passing reference gates from generic evidence file presence", () => {
  const value = inputs();
  delete value.evidence.components[0].gateEvidence["browser-functional"];
  const result = build(value);
  const inspection = result.matrix.components.find((component) => component.id === "web-components.feature-inspection");
  assert.ok(inspection.openGates.includes("reference.browser-functional"));
});

test("rejects empty and unknown explicit reference-gate claims", () => {
  const value = inputs();
  value.evidence.components[0].gateEvidence["memory-leak"] = [];
  value.evidence.components[0].gateEvidence["made-up-gate"] = ["test/feature-inspection.test.ts"];
  const result = build(value);
  assert.ok(result.failures.some((failure) => failure.includes("unknown reference gate")));
  assert.ok(result.failures.some((failure) => failure.includes("memory-leak has no evidence")));
});

test("rejects stale evidence rather than preserving a previously passing projection", () => {
  const result = build(inputs(), "2026-11-13T00:00:00.000Z");
  assert.ok(result.failures.includes("reference qualification evidence is stale"));
});

test("rejects maturity contradictions and missing supported-component evidence", () => {
  const value = inputs();
  value.evidence.components[0].maturity = "survival-tier";
  value.evidence.components.pop();
  const result = build(value);
  assert.ok(result.failures.some((failure) => failure.includes("maturity contradicts")));
  assert.ok(result.failures.some((failure) => failure.includes("has no reference evidence")));
});

test("rejects missing files, source-only packed imports, and bundle-budget drift", () => {
  const value = inputs();
  value.evidence.components[0].unit = ["test/does-not-exist.test.ts"];
  value.evidence.budgets.find((budget) => budget.id === "bundle-gzip").limit += 1;
  const result = buildAppPlatformReferenceQualification(value, {
    now: Date.parse("2026-08-15T00:00:00.000Z"),
    fileExists: (relative) => relative !== "test/does-not-exist.test.ts",
    readText: () => 'import "../src/web-components/index.js";',
  });
  assert.ok(result.failures.some((failure) => failure.includes("does not exist")));
  assert.ok(result.failures.some((failure) => failure.includes("source-only")));
  assert.ok(result.failures.some((failure) => failure.includes("bundle budget contradicts")));
});
