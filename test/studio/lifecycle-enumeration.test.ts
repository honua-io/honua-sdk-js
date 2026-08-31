/**
 * Contract tests for the Studio content-item and draft enumeration endpoints
 * added by `honua-server#3003` (`GET /api/v1/studio/content-items`,
 * `GET /api/v1/studio/package-drafts`).
 *
 * Every expectation is driven by a fixture under
 * `test/fixtures/studio-lifecycle/` derived from the delivered server
 * contract, using the same `fetchImpl` capture harness as
 * `./lifecycle-client.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HonuaClient } from "../../src/index.js";
import {
  HONUA_STUDIO_LIST_MAX_LIMIT,
  type HonuaStudioError,
  type HonuaStudioLifecycleClient,
  createHonuaStudioLifecycleClient,
  isHonuaStudioError,
  isStudioListExhausted,
} from "../../src/studio/index.js";
import type { StudioContentItemListResponse, StudioPackageDraftListResponse } from "../../src/studio/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/studio-lifecycle");

interface EnumerationFixture {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
  };
  readonly response: { readonly status: number; readonly body?: unknown };
}

function fixture(name: string): EnumerationFixture {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8")) as EnumerationFixture;
}

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

/**
 * Serve `contracts` in order, one per physical request. A test that issues
 * more requests than the sequence has pages fails loudly rather than silently
 * replaying the last page — which is exactly the bug a page-cap or
 * cursor-stall test is meant to catch.
 */
function clientForSequence(contracts: readonly EnumerationFixture[]): {
  client: HonuaStudioLifecycleClient;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const client = createHonuaStudioLifecycleClient({
    client: new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ method: init?.method ?? "GET", url, headers: new Headers(init?.headers) });
        const contract = contracts[requests.length - 1];
        if (!contract) throw new Error(`Unexpected request #${requests.length} to ${url.pathname}${url.search}`);
        return new Response(contract.response.body === undefined ? null : JSON.stringify(contract.response.body), {
          status: contract.response.status,
        });
      },
    }),
  });
  return { client, requests };
}

function clientFor(contract: EnumerationFixture): {
  client: HonuaStudioLifecycleClient;
  requests: CapturedRequest[];
} {
  return clientForSequence([contract]);
}

/** The query the fixture says this request carries, as a plain record. */
function queryOf(request: CapturedRequest): Record<string, string> {
  return Object.fromEntries(request.url.searchParams.entries());
}

function dataOf<T>(contract: EnumerationFixture): T {
  return (contract.response.body as { data: T }).data;
}

describe("Studio content-item enumeration (GET /content-items)", () => {
  it("sends the documented filters and surfaces rows with their joined publication badge", async () => {
    const contract = fixture("content-item-list-page-1.v1.json");
    const { client, requests } = clientFor(contract);

    const page = await client.contentItems.list({ family: "map", state: "published", limit: 2 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(queryOf(requests[0] as CapturedRequest)).toEqual(contract.request.query);

    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      itemId: "b2a6e6a0-9b8e-4b2f-9a3a-6a6d9c8e6f31",
      packageKey: "parcels-overview",
      family: "map",
      state: "published",
      ownerId: "actor-alice",
    });
    // REQ-004: the badge is the *route's* lifecycle, independent of the item
    // state — the second row is `published` in Studio but suspended on the wire.
    expect(page.items[0]?.publication).toMatchObject({ lifecycle: "active", activeRevision: 2 });
    expect(page.items[1]?.publication).toMatchObject({ lifecycle: "suspended", activeRevision: 5 });
    expect(isStudioListExhausted(page)).toBe(false);
  });

  it("sends the canonical scalar family, state, ownerId, and search parameters", async () => {
    const contract = fixture("content-item-list-page-1.v1.json");
    const { client, requests } = clientFor(contract);

    await client.contentItems.list({ family: "dashboard", state: "current", ownerId: "actor-alice", search: "ops" });

    expect(queryOf(requests[0] as CapturedRequest)).toEqual({
      family: "dashboard",
      state: "current",
      ownerId: "actor-alice",
      search: "ops",
    });
  });

  it("pages a cursor walk to completion, replaying nextCursor verbatim", async () => {
    const first = fixture("content-item-list-page-1.v1.json");
    const second = fixture("content-item-list-page-2.v1.json");
    const { client, requests } = clientForSequence([first, second]);

    const pages: StudioContentItemListResponse[] = [];
    for await (const page of client.contentItems.listAll({ family: "map", state: "published", limit: 2 })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
    expect(requests).toHaveLength(2);
    // Page 1 carries no cursor; page 2 replays page 1's `nextCursor` byte for byte.
    expect(queryOf(requests[0] as CapturedRequest).cursor).toBeUndefined();
    expect(queryOf(requests[1] as CapturedRequest)).toEqual(second.request.query);
    expect(queryOf(requests[1] as CapturedRequest).cursor).toBe(
      dataOf<StudioContentItemListResponse>(first).nextCursor,
    );
    // The final page's `nextCursor: null` ends the walk.
    expect(pages[1]?.nextCursor).toBeNull();
    expect(isStudioListExhausted(pages[1] as StudioContentItemListResponse)).toBe(true);
  });

  it("collects every page into one result with the server-side total", async () => {
    const { client } = clientForSequence([
      fixture("content-item-list-page-1.v1.json"),
      fixture("content-item-list-page-2.v1.json"),
    ]);

    const collected = await client.contentItems.collect({ family: "map", state: "published", limit: 2 });

    expect(collected.pages).toBe(2);
    expect(collected.items).toHaveLength(3);
    expect(collected.total).toBe(3);
    expect(collected.truncated).toBe(false);
    expect(collected.nextCursor).toBeUndefined();
    expect(collected.items.map((item) => item.packageKey)).toEqual([
      "parcels-overview",
      "zoning-overview",
      "hydrants-overview",
    ]);
  });

  it("handles an empty page without a second request", async () => {
    const contract = fixture("content-item-list-empty.v1.json");
    const { client, requests } = clientForSequence([contract]);

    const collected = await client.contentItems.collect({ family: "report" });

    expect(requests).toHaveLength(1);
    expect(collected.items).toEqual([]);
    expect(collected.total).toBe(0);
    expect(collected.pages).toBe(1);
    expect(collected.truncated).toBe(false);
    // The server omits a null `nextCursor` entirely; absent must read as exhausted.
    expect(dataOf<StudioContentItemListResponse>(contract)).not.toHaveProperty("nextCursor");
  });

  it("stops at the page cap and hands back a resume cursor instead of truncating silently", async () => {
    const first = fixture("content-item-list-page-1.v1.json");
    // Only one page is served: a walk that ignored `maxPages` would request a
    // second and blow up in the harness.
    const { client, requests } = clientForSequence([first]);

    const collected = await client.contentItems.collect(
      { family: "map", state: "published", limit: 2 },
      { maxPages: 1 },
    );

    expect(requests).toHaveLength(1);
    expect(collected.pages).toBe(1);
    expect(collected.items).toHaveLength(2);
    expect(collected.truncated).toBe(true);
    expect(collected.nextCursor).toBe(dataOf<StudioContentItemListResponse>(first).nextCursor);
  });

  it("rejects a maxPages that is not a positive integer", async () => {
    const { client } = clientForSequence([]);

    await expect(client.contentItems.collect({}, { maxPages: 0 })).rejects.toThrow(TypeError);
    await expect(client.contentItems.collect({}, { maxPages: 1.5 })).rejects.toThrow(/maxPages/);
  });

  it("cancels a walk mid-flight, issuing no further page requests", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled the content browser");
    const { client, requests } = clientForSequence([fixture("content-item-list-page-1.v1.json")]);

    const walk = async (): Promise<number> => {
      let seen = 0;
      for await (const _page of client.contentItems.listAll({ limit: 2 }, { signal: controller.signal })) {
        seen += 1;
        // The first page arrived; cancel before the walk asks for the second.
        controller.abort(reason);
      }
      return seen;
    };

    await expect(walk()).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
  });

  it("refuses to page forever when the server returns the cursor it was queried with", async () => {
    const first = fixture("content-item-list-page-1.v1.json");
    const stalled = fixture("content-item-list-stalled-cursor.v1.json");
    const { client, requests } = clientForSequence([first, stalled]);

    const failure = await client.contentItems.collect({ limit: 2 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    expect((failure as HonuaStudioError).code).toBe("internal");
    expect((failure as HonuaStudioError).message).toContain("stalled");
    expect(requests).toHaveLength(2);
  });

  it("replays an identical cursored request idempotently", async () => {
    const contract = fixture("content-item-list-page-2.v1.json");
    const { client, requests } = clientForSequence([contract, contract]);
    const filters = {
      family: "map",
      state: "published",
      limit: 2,
      cursor: contract.request.query?.cursor as string,
    } as const;

    const first = await client.contentItems.list(filters);
    const second = await client.contentItems.list(filters);

    expect(second).toEqual(first);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.toString()).toBe(requests[0]?.url.toString());
    expect(queryOf(requests[0] as CapturedRequest)).toEqual(contract.request.query);
  });

  it("surfaces the server's owner scoping verbatim rather than the requested owner", async () => {
    const contract = fixture("content-item-list-owner-scoped.v1.json");
    const { client, requests } = clientFor(contract);

    const page = await client.contentItems.list({ ownerId: "actor-mallory" });

    // The SDK sends what it is asked to send...
    expect(queryOf(requests[0] as CapturedRequest)).toEqual({ ownerId: "actor-mallory" });
    // ...and reports what the server actually scoped the listing to. The client
    // never re-labels rows with the requested owner.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.ownerId).toBe("actor-alice");
  });

  it("throws forbidden when the caller's identity cannot be resolved for a scoped listing", async () => {
    const contract = fixture("content-item-list-forbidden.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.contentItems.list().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    const error = failure as HonuaStudioError;
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("forbidden");
    expect(error.problem?.type).toBe("https://honua.io/problems/studio");
    expect((error.problem as { code?: string } | undefined)?.code).toBe("studio_authorization/authentication_required");
  });

  it("throws validation for an unknown state filter value", async () => {
    const contract = fixture("content-item-list-invalid-state.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.contentItems.list({ state: "archived" } as never).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as HonuaStudioError).statusCode).toBe(400);
    expect((failure as HonuaStudioError).code).toBe("validation");
    expect((failure as HonuaStudioError).message).toContain("unknown value 'archived'");
  });

  it("rejects a limit the server would silently clamp or replace", async () => {
    const { client } = clientForSequence([]);

    await expect(client.contentItems.list({ limit: 0 })).rejects.toThrow(TypeError);
    await expect(client.contentItems.list({ limit: HONUA_STUDIO_LIST_MAX_LIMIT + 1 })).rejects.toThrow(
      new RegExp(String(HONUA_STUDIO_LIST_MAX_LIMIT)),
    );
  });
});

describe("Studio draft enumeration (GET /package-drafts)", () => {
  it("pages full draft rows to completion and carries no publication badge", async () => {
    const first = fixture("draft-list-page-1.v1.json");
    const second = fixture("draft-list-page-2.v1.json");
    const { client, requests } = clientForSequence([first, second]);

    const collected = await client.drafts.collect({ family: "query", search: "parcels", limit: 1 });

    expect(requests).toHaveLength(2);
    expect(queryOf(requests[0] as CapturedRequest)).toEqual(first.request.query);
    expect(queryOf(requests[1] as CapturedRequest)).toEqual(second.request.query);
    expect(collected.pages).toBe(2);
    expect(collected.total).toBe(2);
    expect(collected.truncated).toBe(false);
    expect(collected.items).toHaveLength(2);
    // Rows are the same shape `GET /package-drafts/{draftId}` returns.
    expect(collected.items[0]).toMatchObject({ draftId: "5e1c7a94-2d68-4b03-9c5f-8a72e04d1b96", generation: 3 });
    expect(collected.items[0]?.envelope.body).toEqual({ where: "status = 'active'" });
    for (const item of collected.items) expect(item).not.toHaveProperty("publication");
  });

  it("returns a single page unpaged when the caller wants one page", async () => {
    const contract = fixture("draft-list-page-1.v1.json");
    const { client, requests } = clientFor(contract);

    const page: StudioPackageDraftListResponse = await client.drafts.list({
      family: "query",
      search: "parcels",
      limit: 1,
    });

    expect(requests).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(isStudioListExhausted(page)).toBe(false);
  });

  it("throws validation for an unknown family filter value", async () => {
    const contract = fixture("draft-list-invalid-family.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.drafts.list({ family: "chart" } as never).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as HonuaStudioError).statusCode).toBe(400);
    expect((failure as HonuaStudioError).code).toBe("validation");
    expect((failure as HonuaStudioError).message).toContain("unknown value 'chart'");
  });

  it("reports not-found — never an empty list — when the deployment predates the enumeration route", async () => {
    const contract = fixture("draft-list-not-deployed.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.drafts.list().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    expect((failure as HonuaStudioError).statusCode).toBe(404);
    // Classified from the status alone: an unmatched route carries no Studio
    // problem document to read a code out of.
    expect((failure as HonuaStudioError).code).toBe("not-found");
    expect(contract.response.body).toBeUndefined();
  });
});
