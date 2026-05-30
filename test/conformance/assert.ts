/**
 * Pure conformance assertion: compare a live protocol-neutral `Result`
 * against the `ExpectedQueryResult` derived from a golden fixture and return
 * a list of drift findings (empty = conformant).
 *
 * Kept pure (no vitest, no transport) so it is exercised three ways:
 *   1. the live feature-service suite asserts the findings are empty;
 *   2. the negative test feeds a mutated golden and asserts findings are
 *      non-empty (proving a field/type/shape change is caught);
 *   3. unit-level coverage can call it directly.
 *
 * @module
 */

import type { Result } from "@honua/sdk-js/contract";
import type { ExpectedQueryResult } from "./mapping.js";

/** One conformance finding: a way the live result drifted from the golden. */
export interface DriftFinding {
  kind: "missing-field" | "field-type" | "missing-attribute" | "geometry" | "transfer-limit" | "total-count";
  message: string;
}

/**
 * Compare a live feature-query `Result` to the golden-derived expectations.
 * Returns every drift finding so a single run reports all problems at once.
 */
export function findQueryResultDrift(expected: ExpectedQueryResult, actual: Result): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const actualFields = actual.fields ?? [];
  const actualFieldByName = new Map(actualFields.map((field) => [field.name, field]));

  for (const want of expected.fields) {
    const got = actualFieldByName.get(want.name);
    if (!got) {
      findings.push({
        kind: "missing-field",
        message: `field "${want.name}" present in golden but absent from live response fields [${actualFields
          .map((f) => f.name)
          .join(", ")}]`,
      });
      continue;
    }
    if (got.type !== want.esriType) {
      findings.push({
        kind: "field-type",
        message: `field "${want.name}" type drift: golden expects ${want.esriType} but live returned ${got.type}`,
      });
    }
  }

  const features = actual.features ?? [];
  if (expected.attributeNames.length > 0) {
    if (features.length === 0) {
      findings.push({
        kind: "missing-attribute",
        message: `golden has ${expected.attributeNames.length} attribute(s) but live response returned zero features`,
      });
    } else {
      const first = features[0];
      const attrs = (first?.attributes ?? {}) as Record<string, unknown>;
      for (const name of expected.attributeNames) {
        if (!(name in attrs)) {
          findings.push({
            kind: "missing-attribute",
            message: `attribute "${name}" present in golden feature but absent from live feature attributes [${Object.keys(
              attrs,
            ).join(", ")}]`,
          });
        }
      }
    }
  }

  if (expected.expectsGeometry && features.length > 0) {
    const missingGeometry = features.find((feature) => feature.geometry == null);
    if (missingGeometry) {
      findings.push({
        kind: "geometry",
        message: "golden carries geometry on every feature but a live feature returned null/absent geometry",
      });
    }
  }

  if (actual.exceededTransferLimit !== expected.exceededTransferLimit) {
    findings.push({
      kind: "transfer-limit",
      message: `exceededTransferLimit drift: golden expects ${expected.exceededTransferLimit} but live returned ${actual.exceededTransferLimit}`,
    });
  }

  if (
    expected.totalCount !== undefined &&
    actual.totalCount !== undefined &&
    actual.totalCount !== expected.totalCount
  ) {
    findings.push({
      kind: "total-count",
      message: `totalCount drift: golden expects ${expected.totalCount} but live returned ${actual.totalCount}`,
    });
  }

  return findings;
}

/** Render drift findings as a single human-readable block for a failure message. */
export function formatDriftFindings(workflow: string, findings: readonly DriftFinding[]): string {
  const lines = [`[conformance:${workflow}] ${findings.length} drift finding(s) vs golden contract:`];
  for (const finding of findings) {
    lines.push(`  - (${finding.kind}) ${finding.message}`);
  }
  return lines.join("\n");
}
