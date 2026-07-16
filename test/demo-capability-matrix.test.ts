import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const allowedStatuses = new Set(["demoed", "tested-only", "blocked", "not-in-scope"]);

const requiredCapabilities = [
  "Service discovery",
  "Metadata",
  "FeatureServer",
  "MapServer",
  "ImageServer",
  "Geometry Service",
  "GP/OGC Processes",
  "OGC Features",
  "OGC Tiles",
  "OGC Maps",
  "WFS",
  "WMS",
  "WMTS",
  "STAC",
  "OData",
  "MCP",
  "Migration",
  "Auth/interceptors",
  "Retries/timeouts",
  "Attachments",
  "Related records",
  "Edits",
  "Style/runtime",
  "Generated app preview runtime",
  "Studio package contracts",
  "Webmap conversion",
  "Geocoding",
  "Telemetry/diagnostics",
  "Metadata caching",
  "Realtime/live data",
  "Warehouse analytics sources",
  "Unified operational workspace",
  "Materialized outputs",
  "Indexed spatial aggregation",
  "Uncached ad hoc spatial requests",
] as const;

type MatrixRow = {
  capability: string;
  sampleApps: string;
  fixtures: string;
  smokeCommands: string;
  status: string;
  notes: string;
};

function readMatrixDoc(): string {
  return fs.readFileSync(path.join(process.cwd(), "docs", "demo-capability-matrix.md"), "utf8");
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseMatrixRows(markdown: string): MatrixRow[] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("| Capability | Sample app(s) |"));
  if (headerIndex === -1) {
    throw new Error("demo capability matrix table header was not found");
  }

  const rows: MatrixRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) {
      break;
    }

    const cells = splitMarkdownRow(line);
    if (cells.length !== 6) {
      throw new Error(`expected 6 cells in matrix row: ${line}`);
    }

    rows.push({
      capability: cells[0],
      sampleApps: cells[1],
      fixtures: cells[2],
      smokeCommands: cells[3],
      status: cells[4],
      notes: cells[5],
    });
  }
  return rows;
}

describe("demo capability matrix", () => {
  it("lists every issue #70 required capability", () => {
    const rows = parseMatrixRows(readMatrixDoc());
    const capabilities = new Set(rows.map((row) => row.capability));

    expect(rows).toHaveLength(requiredCapabilities.length);
    for (const capability of requiredCapabilities) {
      expect(capabilities.has(capability), `missing capability: ${capability}`).toBe(true);
    }
  });

  it("uses only allowed statuses and keeps coverage fields populated", () => {
    const rows = parseMatrixRows(readMatrixDoc());

    for (const row of rows) {
      expect(allowedStatuses.has(row.status), `${row.capability} has invalid status ${row.status}`).toBe(true);
      expect(row.sampleApps.length, `${row.capability} needs sample app notes`).toBeGreaterThan(0);
      expect(row.fixtures.length, `${row.capability} needs fixture/test notes`).toBeGreaterThan(0);
      expect(row.smokeCommands.length, `${row.capability} needs smoke command notes`).toBeGreaterThan(0);
      expect(row.notes.length, `${row.capability} needs gap/follow-up notes`).toBeGreaterThan(0);
    }
  });

  it("documents cache, realtime, materialized, and uncached ad hoc behavior", () => {
    const rows = parseMatrixRows(readMatrixDoc());
    const rowByCapability = new Map(rows.map((row) => [row.capability, row]));

    expect(rowByCapability.get("Metadata caching")?.notes).toContain("Cache note:");
    expect(rowByCapability.get("Realtime/live data")?.notes).toContain("Realtime note:");
    expect(rowByCapability.get("Materialized outputs")?.notes).toContain("Materialized note:");
    expect(rowByCapability.get("Uncached ad hoc spatial requests")?.notes).toContain("Ad-hoc note:");
  });

  it("keeps blocked and weak coverage tied to follow-up issues", () => {
    const rows = parseMatrixRows(readMatrixDoc());
    const weakRows = rows.filter((row) => row.status === "blocked" || /weak|follow-up|blocked/i.test(row.notes));

    expect(weakRows.length).toBeGreaterThan(0);
    for (const row of weakRows) {
      expect(row.notes, `${row.capability} should reference a follow-up issue`).toMatch(
        /#(?:55|56|57|58|59|60|62|63|64|65|66|70|73|74|128|550)\b/,
      );
    }
  });
});
