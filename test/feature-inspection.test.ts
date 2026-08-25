// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Query, Source } from "../src/contract/index.js";
import type { HonuaTypedFeature } from "../src/core/types.js";
import { sourceFeatureSelectionTarget } from "../src/exploration/index.js";
import {
  type HonuaFeatureInspectionAttachmentPageRequest,
  type HonuaFeatureInspectionElement,
  createHonuaFeatureInspection,
  defineHonuaFeatureInspection,
  sanitizeHonuaInspectionHref,
  sanitizeHonuaInspectionRichText,
} from "../src/web-components/feature-inspection.js";

interface Incident {
  OBJECTID: number;
  NAME: string;
  STATUS?: string;
  WEBSITE?: string;
}

function feature(id: number, name = `Incident ${id}`): HonuaTypedFeature<Incident> {
  return { attributes: { OBJECTID: id, NAME: name, STATUS: "open" } };
}

function source(
  overrides: {
    capabilities?: readonly ("query" | "attachments" | "queryRelated")[];
    query?: (request?: Query<Incident>) => Promise<{
      features: readonly HonuaTypedFeature<Incident>[];
      exceededTransferLimit: boolean;
    }>;
    attachmentCount?: number;
    relatedCount?: number;
  } = {},
): Source<Incident> {
  const query = vi.fn(
    overrides.query ??
      (async (request?: Query<Incident>) => ({
        features: [feature(request?.pagination?.limit === 1 ? 1 : 2)],
        exceededTransferLimit: false,
      })),
  );
  return {
    descriptor: {
      id: "incidents",
      protocol: "geoservices-feature-service",
      locator: { kind: "geoservices", url: "https://example.test/FeatureServer", layerId: 0 },
      capabilities: new Set(overrides.capabilities ?? ["query"]),
      schema: {
        primaryKey: "OBJECTID",
        fields: [
          { name: "OBJECTID", alias: "Object ID", type: "esriFieldTypeOID" },
          { name: "NAME", alias: "Name", type: "esriFieldTypeString" },
          { name: "STATUS", alias: "Status", type: "esriFieldTypeString" },
          { name: "WEBSITE", alias: "Website", type: "esriFieldTypeString" },
        ],
      },
    },
    capabilities: new Set(overrides.capabilities ?? ["query"]),
    query,
    queryAll: query,
    queryAggregate: vi.fn(),
    queryExtent: vi.fn(),
    stream: vi.fn(),
    queryObjectIds: vi.fn(),
    applyEdits: vi.fn(),
    queryRelated: vi.fn(async ({ relationshipId, sourceIds, signal }) => {
      signal?.throwIfAborted();
      return {
        groups: [
          {
            sourceId: sourceIds[0] ?? 0,
            features: Array.from({ length: overrides.relatedCount ?? 0 }, (_, index) => ({
              attributes: { OBJECTID: index + 100, NAME: `Related ${relationshipId}-${index}` },
            })),
          },
        ],
      };
    }),
    attachments: {
      query: vi.fn(),
      list: vi.fn(async (parentId, options) => {
        options?.signal?.throwIfAborted();
        return Array.from({ length: overrides.attachmentCount ?? 0 }, (_, index) => ({
          id: index + 1,
          parentId,
          name: `photo-${index + 1}.jpg`,
          size: 100 + index,
        }));
      }),
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    protocol: vi.fn(),
    adapter: vi.fn(),
  } as unknown as Source<Incident>;
}

describe("feature inspection workflow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("uses one source-qualified details contract for map, table, and search selection", async () => {
    const incidents = source();
    const selections: unknown[] = [];
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      sourceIds: ["incidents"],
      searchFields: ["NAME"],
      presentation: { titleField: "NAME", fields: ["NAME", "STATUS"] },
      selection: { setSelection: (targets, options) => selections.push({ targets, origin: options.origin }) },
    });
    const target = sourceFeatureSelectionTarget("incidents", 1);

    const map = await inspection.openFromMapClick([{ target }]);
    const table = await inspection.openFromTableRow({ target });
    await inspection.search("Incident");
    const search = await inspection.openSearchResult(0);

    expect(map.feature?.target).toEqual(target);
    expect(table.feature?.target).toEqual(target);
    expect(search.feature?.target).toEqual(sourceFeatureSelectionTarget("incidents", 2));
    expect(selections).toEqual([
      { targets: [target], origin: "map" },
      { targets: [target], origin: "table" },
      { targets: [sourceFeatureSelectionTarget("incidents", 2)], origin: "search" },
    ]);
  });

  it("requests only identity and configured presentation fields", async () => {
    const incidents = source({ capabilities: ["query"] });
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      presentation: {
        titleField: "NAME",
        fields: ["STATUS"],
        links: [{ label: "Website", hrefField: "WEBSITE" }],
      },
    });

    const snapshot = await inspection.openFromTableRow({ target: sourceFeatureSelectionTarget("incidents", 1) });

    expect(incidents.query).toHaveBeenCalledWith(
      expect.objectContaining({
        outFields: ["OBJECTID", "NAME", "STATUS", "WEBSITE"],
        returnGeometry: false,
        pagination: { limit: 1 },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(snapshot.status).toBe("ready");
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain("attachments-unsupported");
  });

  it("pages and bounds overlapping results, attachments, and relationships", async () => {
    const incidents = source({ capabilities: ["query", "attachments", "queryRelated"] });
    const loadAttachmentPage = vi.fn(async ({ target, offset, limit, signal }) => {
      signal.throwIfAborted();
      const all = Array.from({ length: 7 }, (_, index) => ({
        id: index + 1,
        parentId: target.id,
        name: `photo-${index + 1}.jpg`,
        size: 100 + index,
      }));
      return { items: all.slice(offset, offset + limit), total: all.length };
    });
    const loadRelationshipPage = vi.fn(async ({ relationship, offset, limit, signal }) => {
      signal.throwIfAborted();
      const all = Array.from({ length: 8 }, (_, index) => ({
        attributes: { OBJECTID: index + 100, NAME: `Related ${relationship.id}-${index}` },
      }));
      return { items: all.slice(offset, offset + limit), total: all.length, fields: [] };
    });
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      relationships: [{ id: 3, label: "Units", outFields: ["OBJECTID", "NAME"] }],
      loadAttachmentPage,
      loadRelationshipPage,
      attachmentHref: (attachment) => `https://files.example.test/${String(attachment.id)}`,
      budgets: { pageSize: 2, maxPages: 2, maxOverlappingResults: 2 },
    });

    const snapshot = await inspection.openFromMapClick([
      { target: sourceFeatureSelectionTarget("incidents", 1) },
      { target: sourceFeatureSelectionTarget("incidents", 2) },
      { target: sourceFeatureSelectionTarget("incidents", 3) },
    ]);

    expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "result-limit")).toBe(true);
    expect(snapshot.attachments).toMatchObject({ total: 7, limit: 2, truncated: true, hasNext: true });
    expect(snapshot.attachments?.items).toHaveLength(2);
    expect(snapshot.relationships[0]?.page).toMatchObject({ total: 8, limit: 2, truncated: true, hasNext: true });

    const secondAttachments = inspection.setAttachmentPage(1).attachments;
    const secondRelationships = inspection.setRelationshipPage(3, 1).relationships[0]?.page;
    expect(secondAttachments?.offset).toBe(2);
    expect(secondAttachments?.items.map((item) => item.id)).toEqual([3, 4]);
    expect(secondRelationships?.offset).toBe(2);
    expect(secondRelationships?.items).toHaveLength(2);
    expect(loadAttachmentPage).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, limit: 4, signal: expect.any(AbortSignal) }),
    );
    expect(loadRelationshipPage).toHaveBeenCalledWith(
      expect.objectContaining({
        relationship: { id: 3, label: "Units", outFields: ["OBJECTID", "NAME"] },
        offset: 0,
        limit: 4,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(incidents.attachments.list).not.toHaveBeenCalled();
    expect(incidents.queryRelated).not.toHaveBeenCalled();
  });

  it("fails attachment and relationship subfeatures closed when no bounded upstream loader exists", async () => {
    const incidents = source({ capabilities: ["query", "attachments", "queryRelated"] });
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      relationships: [{ id: 3, label: "Units" }],
    });

    const snapshot = await inspection.openFromTableRow({ target: sourceFeatureSelectionTarget("incidents", 1) });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["attachments-unbounded", "relationships-unbounded"]),
    );
    expect(incidents.attachments.list).not.toHaveBeenCalled();
    expect(incidents.queryRelated).not.toHaveBeenCalled();
  });

  it("propagates cancellation into bounded collection loaders", async () => {
    const incidents = source({ capabilities: ["query", "attachments"] });
    const signals: AbortSignal[] = [];
    const loadAttachmentPage = vi.fn(({ target, signal }: HonuaFeatureInspectionAttachmentPageRequest<Incident>) => {
      signals.push(signal);
      if (target.id === 2) return Promise.resolve({ items: [], total: 0 });
      return new Promise<{ items: []; total: number }>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      loadAttachmentPage,
    });
    const first = inspection.openFromMapClick([
      { target: sourceFeatureSelectionTarget("incidents", 1), feature: feature(1), authoritative: true },
    ]);

    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = inspection.openFromTableRow({
      target: sourceFeatureSelectionTarget("incidents", 2),
      feature: feature(2),
      authoritative: true,
    });

    expect(signals[0]?.aborted).toBe(true);
    await expect(second).resolves.toMatchObject({ status: "ready", feature: { target: { id: 2 } } });
    const superseded = await first;
    expect(superseded.feature?.target.id).not.toBe(1);
    expect(inspection.snapshot()).toMatchObject({ status: "ready", feature: { target: { id: 2 } } });
  });

  it("aborts superseded detail work and ignores its late completion", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<
      (value: { features: readonly HonuaTypedFeature<Incident>[]; exceededTransferLimit: false }) => void
    > = [];
    const incidents = source({
      capabilities: ["query"],
      query: (request) => {
        if (request?.signal) signals.push(request.signal);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    });
    const inspection = createHonuaFeatureInspection<Incident>({ resolveSource: () => incidents });

    const first = inspection.openFromMapClick([{ target: sourceFeatureSelectionTarget("incidents", 1) }]);
    const second = inspection.openFromTableRow({ target: sourceFeatureSelectionTarget("incidents", 2) });
    expect(signals[0]?.aborted).toBe(true);
    resolvers[1]?.({ features: [feature(2)], exceededTransferLimit: false });
    await second;
    resolvers[0]?.({ features: [feature(1)], exceededTransferLimit: false });
    await first;

    expect(inspection.snapshot().feature?.target.id).toBe(2);
    expect(inspection.snapshot().origin).toBe("table");
  });

  it("fails closed with actionable diagnostics when query, attachments, or relationships are unsupported", async () => {
    const noQuery = source({ capabilities: [] });
    const unsupported = createHonuaFeatureInspection<Incident>({ resolveSource: () => noQuery });
    const result = await unsupported.open({ target: sourceFeatureSelectionTarget("incidents", 1) });
    expect(result.status).toBe("unsupported");
    expect(result.diagnostics[0]).toMatchObject({ code: "query-unsupported", capability: "query" });
    expect(result.diagnostics[0]?.message).toContain("Choose a source");

    const queryOnly = source({ capabilities: ["query"] });
    const sections = createHonuaFeatureInspection<Incident>({
      resolveSource: () => queryOnly,
      relationships: [{ id: 4 }],
    });
    const details = await sections.open({ target: sourceFeatureSelectionTarget("incidents", 1) });
    expect(details.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "attachments-unsupported",
      "relationships-unsupported",
    ]);
  });

  it("sanitizes popup content and links without leaking cross-origin credentials", async () => {
    expect(
      sanitizeHonuaInspectionRichText(
        '<p>Hello <strong>map</strong></p><script>globalThis.pwned=true</script><img src=x onerror="pwn()">',
      ),
    ).toBe("Hello map");
    expect(sanitizeHonuaInspectionHref("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeHonuaInspectionHref("https://token:secret@files.example.test/photo.jpg")).toBeUndefined();
    expect(
      sanitizeHonuaInspectionHref("/photo.jpg#private", {
        baseHref: "https://app.example.test/map",
        allowedOrigins: ["https://app.example.test"],
      }),
    ).toBe("https://app.example.test/photo.jpg");
    expect(
      sanitizeHonuaInspectionHref("https://other.example.test/photo.jpg", {
        allowedOrigins: ["https://app.example.test"],
      }),
    ).toBeUndefined();

    const incidents = source({ capabilities: ["query"] });
    vi.mocked(incidents.query).mockResolvedValue({
      features: [
        {
          attributes: {
            OBJECTID: 1,
            NAME: "<img src=x onerror=alert(1)>",
            STATUS: "open",
            WEBSITE: "javascript:alert(document.cookie)",
          },
        },
      ],
      exceededTransferLimit: false,
    });
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      presentation: {
        titleField: "NAME",
        description: "<b>{STATUS}</b><script>bad()</script>",
        fields: ["NAME"],
        links: [{ label: "Website", hrefField: "WEBSITE" }],
        arcadeExpressions: ["$feature.NAME"],
      },
    });
    const snapshot = await inspection.open({ target: sourceFeatureSelectionTarget("incidents", 1) });
    expect(snapshot.feature?.description).toBe("open");
    expect(snapshot.feature?.links).toEqual([]);
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain("popup-arcade-unsupported");
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain("unsafe-link");
  });

  it("uses separate bounded search caching and emits server-search diagnostics", async () => {
    let now = 100;
    const incidents = source({ capabilities: ["query"] });
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      sourceIds: ["incidents"],
      searchFields: ["NAME"],
      searchTtlMs: 10,
      now: () => now,
    });

    await inspection.search("fire");
    await inspection.search("fire");
    expect(incidents.query).toHaveBeenCalledTimes(1);
    now = 111;
    await inspection.search("fire");
    expect(incidents.query).toHaveBeenCalledTimes(2);

    const unsupported = createHonuaFeatureInspection<Incident>({
      resolveSource: () => source({ capabilities: [] }),
      sourceIds: ["incidents"],
      searchFields: ["NAME"],
    });
    const search = await unsupported.search("fire");
    expect(search.status).toBe("unsupported");
    expect(search.diagnostics[0]).toMatchObject({ code: "search-unsupported", sourceId: "incidents" });
  });

  it("patches safe realtime fields, marks ambiguous updates stale, and transitions deletes explicitly", async () => {
    const incidents = source({ capabilities: ["query"] });
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      presentation: { titleField: "NAME", fields: ["NAME", "STATUS"] },
    });
    const target = sourceFeatureSelectionTarget("incidents", 1);
    await inspection.open({ target });

    const patched = inspection.applyRealtime({
      kind: "upsert",
      target,
      completeness: "patch",
      changedFields: ["STATUS"],
      attributes: { STATUS: "closed" },
    });
    expect(patched.status).toBe("ready");
    expect(patched.feature?.fields.find((field) => field.name === "STATUS")?.text).toBe("closed");

    const stale = inspection.applyRealtime({
      kind: "upsert",
      target,
      completeness: "patch",
      attributes: { NAME: "Maybe stale" },
    });
    expect(stale.status).toBe("stale");
    expect(stale.staleReason).toContain("Refresh");

    const deleted = inspection.applyRealtime({ kind: "delete", target });
    expect(deleted.status).toBe("deleted");
    expect(deleted.feature).toBeUndefined();
  });

  it("renders an accessible keyboard-dismissible presentation with credential-free external links", async () => {
    const incidents = source({ capabilities: ["query"] });
    vi.mocked(incidents.query).mockResolvedValue({
      features: [{ attributes: { OBJECTID: 1, NAME: "Safe <name>", WEBSITE: "https://files.example.test/item" } }],
      exceededTransferLimit: false,
    });
    const inspection = createHonuaFeatureInspection<Incident>({
      resolveSource: () => incidents,
      presentation: { titleField: "NAME", links: [{ label: "Open", hrefField: "WEBSITE" }] },
    });
    defineHonuaFeatureInspection();
    const opener = document.createElement("button");
    opener.textContent = "Map feature";
    document.body.append(opener);
    opener.focus();
    const element = document.createElement("honua-feature-inspection") as HonuaFeatureInspectionElement<Incident>;
    element.inspection = inspection;
    document.body.append(element);

    await inspection.openFromMapClick([{ target: sourceFeatureSelectionTarget("incidents", 1) }]);
    const root = element.shadowRoot;
    expect(root?.querySelector("[role='search']")).not.toBeNull();
    expect(root?.querySelector("[role='status']")?.getAttribute("aria-live")).toBe("polite");
    expect(root?.querySelector("h2")?.textContent).toBe("Safe <name>");
    const link = root?.querySelector("a");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("href")).toBe("https://files.example.test/item");
    expect(root?.innerHTML).not.toContain("token:");

    root?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(inspection.snapshot().status).toBe("idle");
    expect(document.activeElement).toBe(opener);
  });
});
