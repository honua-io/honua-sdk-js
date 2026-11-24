import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/main.js";

// Fields of demo.honua.io maui-parcels/1 (FeatureServer layer metadata, November 2026).
// A help example that filters on any other field returns HTTP 400 to a new user.
const DEMO_PARCEL_FIELDS = new Set(["id", "tmk_txt", "zone", "taxacres", "gisacres", "qpub_link"]);

afterEach(() => {
  vi.restoreAllMocks();
});

async function helpText(): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  expect(await run([])).toBe(0);
  return lines.join("");
}

describe("CLI help examples", () => {
  it("filter only on fields the demo parcel layer has", async () => {
    const wheres = [...(await helpText()).matchAll(/honua query maui-parcels\/1 --where "([^"]+)"/g)].map((m) => m[1]);
    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) {
      const identifiers = where.replace(/'[^']*'/g, "").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      const fields = identifiers.filter((word) => !/^(AND|OR|NOT|LIKE|IN|IS|NULL)$/i.test(word));
      expect(fields.filter((field) => !DEMO_PARCEL_FIELDS.has(field))).toEqual([]);
    }
  });
});
