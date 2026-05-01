import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWebMap, validateHonuaStyle } from "../src/index.js";
import type { WebMapJson } from "../src/webmap/types.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "webmap-json");

function loadFixtureDirs(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

describe("WebMap JSON parser — golden fixture suite", () => {
  const fixtureDirs = loadFixtureDirs();

  it("has at least 20 golden fixtures", () => {
    expect(fixtureDirs.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtureDirs)("%s", (fixtureName) => {
    const dir = join(FIXTURES_DIR, fixtureName);
    const inputPath = join(dir, "input.json");
    const expectedPath = join(dir, "expected.json");

    expect(existsSync(inputPath), `Missing input.json in ${fixtureName}`).toBe(true);
    expect(existsSync(expectedPath), `Missing expected.json in ${fixtureName}`).toBe(true);

    const input: WebMapJson = JSON.parse(readFileSync(inputPath, "utf-8"));
    const expected = JSON.parse(readFileSync(expectedPath, "utf-8"));

    const result = parseWebMap(input);

    // Compare style
    expect(result.style).toEqual(expected.style);

    // Compare warnings (if specified in expected)
    if (expected.warnings !== undefined) {
      expect(result.warnings).toEqual(expected.warnings);
    }

    // Compare bookmarks (if specified)
    if (expected.bookmarks !== undefined) {
      expect(result.bookmarks).toEqual(expected.bookmarks);
    }

    // Compare popups (if specified)
    if (expected.popups !== undefined) {
      expect(result.popups).toEqual(expected.popups);
    }

    // Validate that the produced style is structurally valid
    const validationErrors = validateHonuaStyle(result.style);
    expect(validationErrors).toEqual([]);
  });
});
