import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { HONUA_COMPONENT_CATALOG } from "../../src/controls/catalog.js";
import {
  HONUA_COMPONENT_QUALIFICATION_DATA_VERSION,
  HONUA_COMPONENT_QUALIFICATION_GATES,
  HONUA_COMPONENT_QUALIFICATION_STATUSES,
  describeComponentQualificationGate,
  getComponentQualification,
  isComponentProductionQualified,
  listComponentQualifications,
  summarizeComponentQualification,
} from "../../src/controls/qualification.js";

/**
 * The production qualification matrix (issue #683, REQ-004/REQ-005/NFR-001).
 *
 * These tests guard the *properties* that make the matrix trustworthy — dense
 * coverage of the catalog, a closed status vocabulary, evidence that exists on
 * disk, notes attached to every claim that removes work, and agreement between
 * a component's gates and the support tier the catalog declares for it.
 *
 * `scripts/component-qualification.mjs check` enforces the same invariants over
 * the generated manifest in CI. Duplicating them here means the source of truth
 * is guarded even when the generator has not been run, and that a contributor
 * editing `src/controls/qualification.ts` gets the failure from `npm test`
 * rather than from a later CI step.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("qualification gate definitions", () => {
  it("declares a stable, non-empty, duplicate-free gate list", () => {
    const ids = HONUA_COMPONENT_QUALIFICATION_GATES.map((gate) => gate.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(HONUA_COMPONENT_QUALIFICATION_DATA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("covers both requirement groups", () => {
    const requirements = new Set(HONUA_COMPONENT_QUALIFICATION_GATES.map((gate) => gate.requirement));
    expect([...requirements].sort()).toEqual(["NFR-001", "REQ-004", "REQ-005"]);
  });

  it("gives every gate a substantive criterion rather than a restated title", () => {
    for (const gate of HONUA_COMPONENT_QUALIFICATION_GATES) {
      expect(gate.criterion.length, gate.id).toBeGreaterThanOrEqual(40);
      expect(describeComponentQualificationGate(gate.id)).toBe(gate);
    }
    expect(
      describeComponentQualificationGate("not-a-gate" as (typeof HONUA_COMPONENT_QUALIFICATION_GATES)[number]["id"]),
    ).toBeUndefined();
  });
});

describe("matrix covers the component catalog exactly", () => {
  it("has one row per catalog entry and no orphans", () => {
    const rows = listComponentQualifications();
    expect(rows.map((row) => row.id)).toEqual(HONUA_COMPONENT_CATALOG.map((entry) => entry.id));
  });

  it("is dense: every row has one cell per gate, in gate order", () => {
    const gateIds = HONUA_COMPONENT_QUALIFICATION_GATES.map((gate) => gate.id);
    for (const row of listComponentQualifications()) {
      expect(
        row.gates.map((cell) => cell.gate),
        row.id,
      ).toEqual(gateIds);
    }
  });

  it("returns undefined for an id that is not in the catalog", () => {
    expect(getComponentQualification("web-components.does-not-exist")).toBeUndefined();
    expect(isComponentProductionQualified("web-components.does-not-exist")).toBe(false);
  });
});

describe("every cell is honest", () => {
  const rows = listComponentQualifications();

  it("uses only the declared status vocabulary", () => {
    for (const row of rows) {
      for (const cell of row.gates) {
        expect(HONUA_COMPONENT_QUALIFICATION_STATUSES, `${row.id}/${cell.gate}`).toContain(cell.status);
      }
    }
  });

  it("backs every 'passing' cell with evidence files that exist", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const row of rows) {
      for (const cell of row.gates) {
        if (cell.status !== "passing") continue;
        expect(cell.evidence.length, `${row.id}/${cell.gate}`).toBeGreaterThan(0);
        for (const evidence of cell.evidence) {
          checked += 1;
          if (!fs.existsSync(path.join(REPO_ROOT, evidence))) missing.push(`${row.id}/${cell.gate} -> ${evidence}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  it("never cites evidence for a cell that is not passing", () => {
    for (const row of rows) {
      for (const cell of row.gates) {
        if (cell.status === "passing") continue;
        expect(cell.evidence, `${row.id}/${cell.gate}`).toEqual([]);
      }
    }
  });

  it("requires a note for 'failing' and 'not-applicable'", () => {
    for (const row of rows) {
      for (const cell of row.gates) {
        if (cell.status !== "failing" && cell.status !== "not-applicable") continue;
        expect(cell.note?.length ?? 0, `${row.id}/${cell.gate}`).toBeGreaterThanOrEqual(20);
      }
    }
  });
});

describe("support tier cannot drift ahead of the evidence", () => {
  it("agrees with the catalog's declared tier in both directions", () => {
    for (const entry of HONUA_COMPONENT_CATALOG) {
      expect(entry.supportTier === "production-tier", entry.id).toBe(isComponentProductionQualified(entry.id));
    }
  });

  it("treats a gate that is neither passing nor not-applicable as blocking", () => {
    for (const row of listComponentQualifications()) {
      const blocked = row.gates.some((cell) => cell.status === "pending" || cell.status === "failing");
      expect(isComponentProductionQualified(row.id), row.id).toBe(!blocked);
    }
  });

  it("records the seed honestly: no component is production-qualified yet", () => {
    // Seeded from what the suite actually asserts today (issue #683). This is
    // asserted so that the day a component genuinely clears every gate, this
    // test fails and forces its catalog supportTier to be promoted with it.
    expect(HONUA_COMPONENT_CATALOG.filter((entry) => isComponentProductionQualified(entry.id))).toEqual([]);
  });
});

describe("summaries", () => {
  it("counts one row's cells and the whole matrix consistently", () => {
    const gateCount = HONUA_COMPONENT_QUALIFICATION_GATES.length;
    const rows = listComponentQualifications();

    const single = summarizeComponentQualification(rows[0].id);
    expect(single.passing + single.failing + single.pending + single.notApplicable).toBe(gateCount);

    const overall = summarizeComponentQualification();
    expect(overall.passing + overall.failing + overall.pending + overall.notApplicable).toBe(rows.length * gateCount);
    expect(overall.passing).toBeGreaterThan(0);
  });

  it("lists the gates still blocking production tier", () => {
    const overall = summarizeComponentQualification();
    expect(overall.blocking).toEqual([...overall.blocking].sort());
    expect(overall.blocking).toContain("localization");
    expect(overall.blocking).toContain("strict-csp");
    expect(overall.blocking).toContain("visual-regression");
  });
});

describe("generated manifest tracks the source of truth", () => {
  const manifestPath = path.join(REPO_ROOT, "config/component-qualification.v1.json");

  it("is committed and matches the catalog and gate list", () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      format: string;
      dataVersion: string;
      gates: { id: string }[];
      components: { id: string; productionQualified: boolean }[];
      summary: { cells: number; components: number; gates: number };
    };

    expect(manifest.format).toBe("honua.app-platform.component-qualification.v1");
    expect(manifest.dataVersion).toBe(HONUA_COMPONENT_QUALIFICATION_DATA_VERSION);
    expect(manifest.gates.map((gate) => gate.id)).toEqual(HONUA_COMPONENT_QUALIFICATION_GATES.map((gate) => gate.id));
    expect(manifest.components.map((component) => component.id)).toEqual(
      HONUA_COMPONENT_CATALOG.map((entry) => entry.id),
    );
    expect(manifest.summary.cells).toBe(manifest.summary.components * manifest.summary.gates);
    for (const component of manifest.components) {
      expect(component.productionQualified, component.id).toBe(isComponentProductionQualified(component.id));
    }
  });

  it("is reflected in the generated docs table", () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, "docs/web-components.md"), "utf8");
    expect(doc).toContain("<!-- component-qualification:start -->");
    expect(doc).toContain("<!-- component-qualification:end -->");
    for (const entry of HONUA_COMPONENT_CATALOG) {
      expect(doc, entry.id).toContain(`\`${entry.tag}\` (${entry.source})`);
    }
  });
});
