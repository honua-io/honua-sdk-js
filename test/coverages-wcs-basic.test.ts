import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sampleRoot = path.resolve("examples/coverages-wcs-basic");
const styles = readFileSync(path.join(sampleRoot, "src/styles.css"), "utf8");
const main = readFileSync(path.join(sampleRoot, "src/main.ts"), "utf8");
const fixtures = readFileSync(path.join(sampleRoot, "src/pinned-fixtures.ts"), "utf8");
const markup = readFileSync(path.join(sampleRoot, "index.html"), "utf8");
const readme = readFileSync(path.join(sampleRoot, "README.md"), "utf8");

describe("Coverage and WCS sample", () => {
  it("exercises both real clients, named bands, and the shared MapLibre handoff", () => {
    expect(main).toContain("createCoverageClient(client)");
    expect(main).toContain("createWcsClient(client");
    expect(main).toContain("coverages.collections({ signal })");
    expect(main).toContain("source.collection({ signal })");
    expect(main).toContain("source.domainSet({ signal })");
    expect(main).toContain("source.rangeType({ signal })");
    expect(main).toContain("properties: [selectedBand]");
    expect(main).toContain("rangeSubset: [selectedBand]");
    expect(main).toContain("coverageToMapLibreImage(coverage, bbox");
    expect(main).toContain("map.addSource(activeProjection.sourceId");
    expect(markup).toContain('id="map"');
    expect(markup).toContain('class="legend"');
    expect(markup).toContain('id="pixel-value"');
  });

  it("pins bounded raster, cancellation, degradation, and a closed transport boundary", () => {
    expect(main).toContain("scaleSize: { width: 320, height: 220 }");
    expect(main).toContain("const byteCeiling = 1024 * 1024");
    expect(main).toContain('controller.abort("Superseded fixture request")');
    expect(main).toContain('rangeSubset: ["not-a-band"]');
    expect(fixtures).toContain("if (url.origin !== FIXTURE_ORIGIN)");
    expect(fixtures).toContain("Pinned coverage fixture blocked an unexpected origin");
    expect(fixtures).toContain('wcsOperation === "GetCoverage"');
    expect(fixtures).toContain("abortableDelay(250, request.signal)");
    expect(fixtures).not.toMatch(/\bfetch\s*\(/u);
    expect(markup).toContain('id="cancel-proof"');
    expect(markup).toContain('id="degrade-proof"');
  });

  it("keeps its classification truthful and its font presentation local", () => {
    expect(styles).not.toMatch(/@import\s/iu);
    expect(styles).not.toMatch(/url\(\s*["']?https?:\/\//iu);
    expect(styles).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/iu);
    expect(styles).toContain('font-family: "Avenir Next", Avenir, Futura, "Century Gothic", sans-serif;');
    expect(styles).toContain('"SFMono-Regular", Consolas, "Liberation Mono", monospace');
    expect(readme).toContain("support remain **experimental**");
    expect(readme).toContain("There is no reviewed anonymous live canary");
    expect(readme).toContain("Issue #1115");
  });
});
