import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(path.resolve("examples/coverages-wcs-basic/src/styles.css"), "utf8");

describe("Coverage and WCS sample", () => {
  it("keeps its font presentation local to the published bundle", () => {
    expect(styles).not.toMatch(/@import\s/iu);
    expect(styles).not.toMatch(/url\(\s*["']?https?:\/\//iu);
    expect(styles).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/iu);
    expect(styles).toContain('font-family: "Avenir Next", Avenir, Futura, "Century Gothic", sans-serif;');
    expect(styles).toContain('"SFMono-Regular", Consolas, "Liberation Mono", monospace');
  });
});
