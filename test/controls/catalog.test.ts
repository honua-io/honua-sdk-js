import { describe, expect, test } from "vitest";

import {
  HONUA_COMPONENT_CATALOG,
  describeDeprecatedComponentImport,
  getCanonicalComponentCatalogEntry,
  getComponentCatalogEntriesForTag,
  getComponentCatalogEntry,
  listComponentCatalogEntries,
  listDeprecatedComponentImports,
} from "../../src/controls/catalog.js";
import * as controlsIndex from "../../src/controls/index.js";
import * as webComponentsIndex from "../../src/web-components/index.js";

/**
 * Verifies the consolidated component catalog (issue #679, REQ-001) is
 * internally consistent and agrees with what each kit's public entrypoint
 * actually exports — the "generated catalog and public exports agree on
 * every component" acceptance criterion.
 */
describe("HONUA_COMPONENT_CATALOG", () => {
  test("every entry has a unique id", () => {
    const ids = HONUA_COMPONENT_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every distinct tag has exactly one canonical entry", () => {
    const tags = new Set(HONUA_COMPONENT_CATALOG.map((entry) => entry.tag));
    for (const tag of tags) {
      const canonicalEntries = HONUA_COMPONENT_CATALOG.filter((entry) => entry.tag === tag && entry.canonical);
      expect(canonicalEntries, `tag "${tag}" must have exactly one canonical entry`).toHaveLength(1);
    }
  });

  test("collidesWithIds is symmetric and points at real, same-tag entries", () => {
    for (const entry of HONUA_COMPONENT_CATALOG) {
      for (const otherId of entry.collidesWithIds) {
        const other = getComponentCatalogEntry(otherId);
        expect(other, `"${entry.id}" names unknown collider "${otherId}"`).toBeDefined();
        expect(other?.tag).toBe(entry.tag);
        expect(other?.collidesWithIds).toContain(entry.id);
      }
    }
  });

  test("a tag is contested (>1 entry) iff every entry for it names the others in collidesWithIds", () => {
    const tags = new Set(HONUA_COMPONENT_CATALOG.map((entry) => entry.tag));
    for (const tag of tags) {
      const entries = getComponentCatalogEntriesForTag(tag);
      if (entries.length <= 1) {
        expect(entries[0]?.collidesWithIds ?? []).toHaveLength(0);
        continue;
      }
      for (const entry of entries) {
        const others = entries.filter((candidate) => candidate.id !== entry.id).map((candidate) => candidate.id);
        expect([...entry.collidesWithIds].sort()).toEqual([...others].sort());
      }
    }
  });

  test("honua-legend and honua-layer-list are the only contested tags, both canonically owned by web-components", () => {
    const contested = [...new Set(HONUA_COMPONENT_CATALOG.map((entry) => entry.tag))].filter(
      (tag) => getComponentCatalogEntriesForTag(tag).length > 1,
    );
    expect(contested.sort()).toEqual(["honua-layer-list", "honua-legend"].sort());
    for (const tag of contested) {
      expect(getCanonicalComponentCatalogEntry(tag)?.source).toBe("web-components");
    }
  });

  test("getComponentCatalogEntry / listComponentCatalogEntries / getCanonicalComponentCatalogEntry round-trip", () => {
    expect(getComponentCatalogEntry("web-components.map")?.tag).toBe("honua-map");
    expect(getComponentCatalogEntry("not-a-real-id")).toBeUndefined();
    expect(listComponentCatalogEntries("controls")).toHaveLength(4);
    expect(listComponentCatalogEntries("web-components")).toHaveLength(17);
    expect(listComponentCatalogEntries()).toHaveLength(HONUA_COMPONENT_CATALOG.length);
    expect(getCanonicalComponentCatalogEntry("honua-basemap-switcher")?.id).toBe("controls.basemap-switcher");
    expect(getCanonicalComponentCatalogEntry("honua-does-not-exist")).toBeUndefined();
  });

  test("the support tier vocabulary is used, with honua-feature-editor as the production-tier entry", () => {
    for (const entry of HONUA_COMPONENT_CATALOG) {
      expect(["survival-tier", "production-tier"]).toContain(entry.supportTier);
    }
    const production = HONUA_COMPONENT_CATALOG.filter((entry) => entry.supportTier === "production-tier");
    expect(production.map((entry) => entry.id)).toContain("web-components.feature-editor");
    // The survival-tier `honua-editor` stays alongside it, under its own tag.
    expect(getComponentCatalogEntry("web-components.editor")?.supportTier).toBe("survival-tier");
    expect(getComponentCatalogEntry("web-components.feature-editor")?.tag).toBe("honua-feature-editor");
  });

  test("every entry's className is exported (as a value) from its owning kit's public entrypoint", () => {
    for (const entry of HONUA_COMPONENT_CATALOG) {
      const owningModule = entry.source === "controls" ? controlsIndex : webComponentsIndex;
      const exported = (owningModule as Record<string, unknown>)[entry.className];
      expect(typeof exported, `${entry.id}: "${entry.className}" not exported as a value from ${entry.source}`).toBe(
        "function",
      );
    }
  });
});

describe("deprecated component import diagnostics", () => {
  test("names a canonical replacement for the deprecated subpaths", () => {
    expect(describeDeprecatedComponentImport("@honua/sdk-js/controls")?.canonicalReplacement).toBe(
      "@honua/app-platform/controls",
    );
    expect(describeDeprecatedComponentImport("@honua/sdk-js/web-components")?.canonicalReplacement).toBe(
      "@honua/app-platform/web-components",
    );
  });

  test("names the canonical registrant for both contested-tag catalog ids", () => {
    expect(describeDeprecatedComponentImport("controls.legend")?.canonicalReplacement).toBe("web-components.legend");
    expect(describeDeprecatedComponentImport("controls.layer-list")?.canonicalReplacement).toBe(
      "web-components.layer-list",
    );
  });

  test("returns undefined for an unrecorded specifier", () => {
    expect(describeDeprecatedComponentImport("@honua/sdk-js/not-a-real-subpath")).toBeUndefined();
  });

  test("listDeprecatedComponentImports enumerates every recorded alias", () => {
    const specifiers = listDeprecatedComponentImports().map((alias) => alias.specifier);
    expect(specifiers).toEqual(
      expect.arrayContaining([
        "@honua/sdk-js/controls",
        "@honua/sdk-js/web-components",
        "controls.legend",
        "controls.layer-list",
      ]),
    );
  });
});
