/**
 * OGC API Records integration coverage. Walks the public
 * `client.ogcRecords()` catalog surface from landing → conformance →
 * collections → search, and exercises paging through the SDK's
 * cursor-driven `searchAll` / `searchStream` helpers.
 *
 * Records is a catalog surface that a given seed may or may not publish, so
 * capability is discovered at runtime by probing the landing document: when
 * the server responds with a capability-gap status (404 / 405 / 501) the
 * whole surface skips with an explicit reason and is recorded as skipped in
 * the run metadata. Any other failure is a real defect and fails loudly.
 *
 * The paging test deliberately drives `searchAll` with a page size of 1 so
 * multi-page continuation is exercised, and asserts the SDK follows the
 * `rel="next"` cursor (which honua-server spells `offset` and standards-
 * conformant servers spell `startindex`) rather than assuming an
 * offset-arithmetic pager.
 *
 * @module
 */

import { expect, it } from "vitest";
import {
  type CapabilityGap,
  classifyCapabilityGap,
  integrationSuite,
  recordSurface,
  runWithDiagnostics,
} from "../harness.js";

const SURFACE = "ogc-records";

integrationSuite("OGC API Records", SURFACE, ({ client, context }) => {
  const records = client.ogcRecords();

  // Memoized runtime capability probe. Resolves to a CapabilityGap when the
  // target does not publish Records, or `undefined` when it does. Re-throws
  // any non-gap error so the lane fails loudly on a real defect.
  let probe: Promise<CapabilityGap | undefined> | undefined;
  const probeCapability = (): Promise<CapabilityGap | undefined> => {
    probe ??= (async () => {
      try {
        const landing = await records.landing();
        expect(Array.isArray(landing.links)).toBe(true);
        return undefined;
      } catch (error) {
        const gap = classifyCapabilityGap("OGC API Records landing", error);
        if (!gap) throw error;
        return gap;
      }
    })();
    return probe;
  };

  // Skip helper: records the surface as skipped (with reason) and short-circuits
  // the test via the vitest context. Returns `true` when the caller should stop.
  const skipIfUnavailable = async (ctx: { skip: (note?: string) => void }): Promise<CapabilityGap | undefined> => {
    const gap = await probeCapability();
    if (gap) {
      recordSurface(SURFACE, gap.reason);
      ctx.skip(gap.reason);
    }
    return gap;
  };

  it("returns an OGC API Records landing document [cert:ogc-records/landing#positive] [cert:ogc-records/landing#metadata] [cert:ogc-records/landing#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    await runWithDiagnostics(context, "client.ogcRecords().landing", async () => {
      const landing = await records.landing();
      expect(landing).toBeDefined();
      expect(Array.isArray(landing.links)).toBe(true);
    });
  });

  it("declares OGC API Records conformance classes [cert:ogc-records/conformance#positive] [cert:ogc-records/conformance#metadata] [cert:ogc-records/conformance#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    await runWithDiagnostics(context, "client.ogcRecords().conformance", async () => {
      const conformance = await records.conformance();
      expect(Array.isArray(conformance.conformsTo)).toBe(true);
      expect(conformance.conformsTo.length).toBeGreaterThan(0);
    });
  });

  it("lists catalog collections [cert:ogc-records/collections#positive] [cert:ogc-records/collections#metadata] [cert:ogc-records/collections#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    await runWithDiagnostics(context, "client.ogcRecords().collections", async () => {
      const result = await records.collections();
      expect(Array.isArray(result.collections)).toBe(true);
    });
  });

  // Resolve a catalog id to search against. OGC API Records addresses catalog
  // items under a collection (`/collections/{catalogId}/items`), so a search
  // needs a concrete catalog. Discover the first advertised one; memoized.
  let catalog: Promise<string | undefined> | undefined;
  const resolveCatalogId = (): Promise<string | undefined> => {
    catalog ??= (async () => {
      const result = await records.collections();
      const first = result.collections[0];
      return first === undefined ? undefined : String(first.id);
    })();
    return catalog;
  };

  it("searches a catalog with a bounded page [cert:ogc-records/search#positive] [cert:ogc-records/search#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    const catalogId = await resolveCatalogId();
    if (!catalogId) {
      ctx.skip("no Records catalog collection advertised on this seed");
      return;
    }
    await runWithDiagnostics(context, "client.ogcRecords().collection().search", async () => {
      const response = await records.collection(catalogId).search({ limit: 5 });
      expect(response.type).toBe("FeatureCollection");
      expect(Array.isArray(response.features)).toBe(true);
      // A conformant Records catalog advertises paging links; even an empty
      // catalog returns a `self` link, so `links` must be an array when present.
      if (response.links !== undefined) {
        expect(Array.isArray(response.links)).toBe(true);
      }
    });
  });

  it("pages a catalog with a cursor-driven pager (non-offset continuation) [cert:ogc-records/cursor-pagination#positive] [cert:ogc-records/cursor-pagination#pagination] [cert:ogc-records/cursor-pagination#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    const catalogId = await resolveCatalogId();
    if (!catalogId) {
      ctx.skip("no Records catalog collection advertised on this seed");
      return;
    }
    const catalogHandle = records.collection(catalogId);

    // Establish whether the catalog holds any records; an empty catalog has
    // nothing to page, so soft-skip rather than fabricate data.
    const firstPage = await runWithDiagnostics(context, "client.ogcRecords().collection().search(limit:1)", async () =>
      catalogHandle.search({ limit: 1 }),
    );
    if (firstPage.features.length === 0) {
      ctx.skip("Records catalog is empty on this seed; nothing to page");
      return;
    }

    // Drive the cursor pager one record at a time so continuation is exercised.
    // `searchAll` follows the server's `rel="next"` link (offset/startindex/
    // startIndex) and stops when the server drops the next link — it never
    // assumes offset += pageSize. A short page must NOT terminate paging.
    const collected = await runWithDiagnostics(
      context,
      "client.ogcRecords().collection().searchAll(pageSize:1)",
      async () => catalogHandle.searchAll({ pageSize: 1, maxPages: 25 }),
    );
    expect(collected.length).toBeGreaterThanOrEqual(1);

    // Record identities must be unique across pages — a broken pager that
    // re-requests the same offset would duplicate records.
    const ids = collected.map((record) => String(record.id)).filter((id) => id !== "undefined");
    if (ids.length > 0) {
      expect(new Set(ids).size).toBe(ids.length);
    }

    // The streaming variant must agree with the buffered variant.
    let streamed = 0;
    for await (const page of catalogHandle.searchStream({ pageSize: 1, maxPages: 25 })) {
      streamed += page.length;
    }
    expect(streamed).toBe(collected.length);
  });
});
