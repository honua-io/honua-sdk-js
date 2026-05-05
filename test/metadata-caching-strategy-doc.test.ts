import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const requiredMetadataTypes = [
  "Service lists",
  "Layer descriptors",
  "Fields",
  "Domains",
  "Capabilities",
  "Relationships",
  "Renderers",
  "Legends",
  "Tile matrix sets",
  "STAC collection metadata",
  "OGC process descriptions",
] as const;

const requiredKeyInputs = [
  "tenantId",
  "projectId",
  "Auth scope fingerprint",
  "Normalized source URL",
  "Protocol/adapter id",
  "Service, layer, table, collection, tileset, style, entity set, or process id",
  "CRS, tile matrix set, output format, legend format, language/locale, and profile/media type",
  "ETag",
  "Last-Modified",
] as const;

const requiredInvalidationTriggers = [
  "Source refresh completes",
  "Import job completes",
  "Migration job completes",
  "Feature edits complete",
  "Schema changes",
  "Admin actions",
] as const;

const requiredSections = [
  "## Default Metadata Set",
  "## Cache Keys",
  "## TTL And Revalidation Policy",
  "## Invalidation Triggers",
  "## SDK And MCP Cache-State Visibility",
  "## Feature, Query, And Result Caching",
  "## Realtime Incident Dashboard Constraints",
  "## Recommended Follow-Up Tickets",
] as const;

function readStrategyDoc(): string {
  return fs.readFileSync(path.join(process.cwd(), "docs", "metadata-caching-strategy.md"), "utf8");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

describe("metadata caching strategy doc", () => {
  it("keeps the required policy sections", () => {
    const doc = readStrategyDoc();

    for (const section of requiredSections) {
      expect(doc, `missing section: ${section}`).toContain(section);
    }
  });

  it("names every metadata type cached by default", () => {
    const doc = readStrategyDoc();

    for (const metadataType of requiredMetadataTypes) {
      expect(doc, `missing default metadata type: ${metadataType}`).toContain(metadataType);
    }
  });

  it("documents required key dimensions and invalidation triggers", () => {
    const doc = readStrategyDoc();
    const normalizedDoc = normalizeWhitespace(doc);

    for (const keyInput of requiredKeyInputs) {
      expect(normalizedDoc, `missing cache-key input: ${keyInput}`).toContain(keyInput);
    }

    for (const trigger of requiredInvalidationTriggers) {
      expect(doc, `missing invalidation trigger: ${trigger}`).toContain(trigger);
    }
  });

  it("keeps TTLs, cache-state visibility, materialization, and realtime safety traceable", () => {
    const doc = readStrategyDoc();
    const normalizedDoc = normalizeWhitespace(doc);

    expect(doc).toContain("| Metadata category | Default fresh TTL | Stale-if-error window | Revalidation policy |");
    expect(doc).toMatch(/\b5 minutes\b/);
    expect(doc).toMatch(/\b15 minutes\b/);
    expect(doc).toMatch(/\b30 minutes\b/);
    expect(doc).toMatch(/\b24 hours\b/);

    for (const status of ["hit", "miss", "stale", "refreshed", "bypass"] as const) {
      expect(doc, `missing cache status: ${status}`).toContain(`"${status}"`);
    }

    expect(normalizedDoc).toContain("feature, query, and result caching is opt-in materialization only");
    expect(doc).toContain("must not show stale spatial feature state");
    expect(doc).toContain("The incident operations dashboard is realtime by default");
  });
});
