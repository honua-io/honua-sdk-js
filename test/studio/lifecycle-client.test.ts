import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HonuaClient } from "../../src/index.js";
import {
  HONUA_STUDIO_LIFECYCLE_BASE_PATH,
  type HonuaStudioError,
  HonuaStudioLifecycleClient,
  createHonuaStudioLifecycleClient,
  isHonuaStudioError,
  isHonuaStudioGenerationConflict,
} from "../../src/studio/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/studio-lifecycle");

interface LifecycleFixture {
  readonly request: { readonly method: string; readonly path: string; readonly body?: unknown };
  readonly response: { readonly status: number; readonly body?: unknown };
}

function fixture(name: string): LifecycleFixture {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8")) as LifecycleFixture;
}

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
  readonly headers: Headers;
}

function clientFor(contract: LifecycleFixture): { client: HonuaStudioLifecycleClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const client = createHonuaStudioLifecycleClient({
    client: new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
        requests.push({ method: init?.method ?? "GET", url, body, headers });
        return new Response(contract.response.body === undefined ? null : JSON.stringify(contract.response.body), {
          status: contract.response.status,
        });
      },
    }),
  });
  return { client, requests };
}

describe("HonuaStudioLifecycleClient", () => {
  it("exports the base path constant and factory", () => {
    expect(HONUA_STUDIO_LIFECYCLE_BASE_PATH).toBe("/api/v1/studio");
    expect(createHonuaStudioLifecycleClient).toBeTypeOf("function");
    expect(HonuaStudioLifecycleClient).toBeTypeOf("function");
  });

  it("discovers package families", async () => {
    const contract = fixture("package-families.v1.json");
    const { client, requests } = clientFor(contract);

    const result = await client.packageFamilies.list();

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(result.families).toHaveLength(3);
    expect(result.families[0]).toMatchObject({ family: "query", supportLevel: "limited", durable: true });
    expect(result.families.find((f) => f.family === "gp")).toMatchObject({
      durable: false,
      persistenceMode: "in-memory",
    });
  });

  it("creates a draft, sending the packageKey/workspaceId/envelope request body", async () => {
    const contract = fixture("draft-create.v1.json");
    const { client, requests } = clientFor(contract);

    const draft = await client.drafts.create({
      packageKey: "parcels-query",
      workspaceId: "workspace-ops",
      envelope: (contract.request.body as { envelope: unknown }).envelope as never,
    });

    expect(requests[0]).toMatchObject({ method: "POST", body: contract.request.body });
    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(draft).toMatchObject({ draftId: "draft-parcels-1", family: "query", generation: 1 });
    expect(draft.envelope.body).toEqual({ where: "1=1" });
  });

  it("retrieves a draft by id", async () => {
    const contract = fixture("draft-get.v1.json");
    const { client, requests } = clientFor(contract);

    const draft = await client.drafts.get("draft-parcels-1");

    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(draft.draftId).toBe("draft-parcels-1");
    expect(draft.generation).toBe(1);
  });

  it("replaces a draft, sending the last-seen generation and bumping it on success", async () => {
    const contract = fixture("draft-replace.v1.json");
    const { client, requests } = clientFor(contract);

    const draft = await client.drafts.replace("draft-parcels-1", contract.request.body as never);

    expect(requests[0]).toMatchObject({ method: "PUT", body: contract.request.body });
    expect((contract.request.body as { generation: number }).generation).toBe(1);
    expect(draft.generation).toBe(2);
  });

  it("throws a distinct generation-conflict error on a stale PUT", async () => {
    const contract = fixture("draft-replace-generation-conflict.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.drafts.replace("draft-parcels-1", contract.request.body as never).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    expect(isHonuaStudioGenerationConflict(failure)).toBe(true);
    const error = failure as HonuaStudioError;
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("generation-conflict");
    expect(error.problem?.type).toBe("https://honua.io/problems/studio");
    expect(error.message).toContain("generation 1 is stale");
  });

  it("detects an HonuaHttpError-shaped rejection structurally, even with a foreign prototype (split-package dual-module hazard)", async () => {
    // Simulates HonuaStudioLifecycleClient running inside the generated
    // `@honua/app-platform/studio` split package while wired to a
    // `HonuaClient` built from a *different* copy of `@honua/sdk-js`'s
    // `core/errors.js` module (the caller's `@honua/sdk` peer). The
    // rejection below carries every own property a real `HonuaHttpError`
    // instance carries but is deliberately NOT an instance of this
    // package's `HonuaHttpError` class — `error instanceof HonuaHttpError`
    // would return `false` for it, which is exactly the dual-package hazard
    // detection must not depend on.
    class ForeignHonuaHttpError extends Error {
      public readonly kind = "honua.sdk.error.v1";
      public readonly sdkCode = "core.http.rejected";
      public readonly domain = "core";
      public readonly category = "protocol";
      public readonly retryable = false;
      public readonly context = Object.freeze({});
      public readonly statusCode = 409;
      public readonly body = {
        type: "https://honua.io/problems/studio",
        title: "Draft generation conflict",
        status: 409,
        detail: 'Draft "draft-parcels-1" generation 1 is stale; the current generation is 2.',
        code: "studio.draft.generation-conflict",
      };

      public constructor() {
        super('HTTP 409: Draft "draft-parcels-1" generation 1 is stale; the current generation is 2.');
        this.name = "HonuaHttpError";
      }
    }

    const fakeClient = {
      pipelineFetch: async () => {
        throw new ForeignHonuaHttpError();
      },
    } as unknown as HonuaClient;
    const client = createHonuaStudioLifecycleClient({ client: fakeClient });

    const failure = await client.drafts
      .replace("draft-parcels-1", {
        packageKey: "parcels-query",
        generation: 1,
        envelope: { family: "query", schemaVersion: "1.0", format: "studio_query_package.v1", body: {} },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Sanity: this really is the cross-realm failure mode under test — the
    // thrown value does not carry this package's own HonuaStudioError shape
    // until `toStudioError` converts it below.
    expect(failure).not.toBeInstanceOf(ForeignHonuaHttpError);

    expect(isHonuaStudioError(failure)).toBe(true);
    expect(isHonuaStudioGenerationConflict(failure)).toBe(true);
    const error = failure as HonuaStudioError;
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("generation-conflict");
    expect(error.problem?.code).toBe("studio.draft.generation-conflict");
    expect(error.message).toContain("generation 1 is stale");
  });

  it("deletes a draft and resolves void from the no-payload ApiResponse envelope", async () => {
    const contract = fixture("draft-delete.v1.json");
    const { client, requests } = clientFor(contract);

    const result = await client.drafts.delete("draft-parcels-1");

    expect(requests[0]).toMatchObject({ method: "DELETE" });
    expect(result).toBeUndefined();
  });

  it("validates a draft and persists diagnostics", async () => {
    const contract = fixture("draft-validate.v1.json");
    const { client, requests } = clientFor(contract);

    const summary = await client.drafts.validate("draft-parcels-1");

    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(summary.status).toBe("warning");
    expect(summary.diagnostics).toHaveLength(1);
    expect(summary.diagnostics?.[0]).toMatchObject({ code: "query.missing-order-by", severity: "warning" });
  });

  it("returns a synchronous preview plan for an inline-preview family", async () => {
    const contract = fixture("draft-preview-plan-sync.v1.json");
    const { client } = clientFor(contract);

    const plan = await client.drafts.previewPlan("draft-parcels-1");

    expect(plan).toEqual({
      requiresJob: false,
      synchronous: true,
      steps: ["validate-envelope", "prepare-inline-preview"],
    });
  });

  it("returns a job-backed preview plan for a background-preview family", async () => {
    const contract = fixture("draft-preview-plan-job.v1.json");
    const { client } = clientFor(contract);

    const plan = await client.drafts.previewPlan("draft-buffer-gp-1");

    expect(plan).toEqual({
      requiresJob: true,
      synchronous: false,
      steps: ["validate-envelope", "plan-background-preview-job"],
    });
  });

  it("saves a draft as an immutable content version", async () => {
    const contract = fixture("content-version-create.v1.json");
    const { client, requests } = clientFor(contract);

    const version = await client.drafts.createContentVersion("draft-parcels-1");

    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(version).toMatchObject({ versionId: "version-parcels-1", versionNumber: 1, family: "query" });
    expect(version.contentHash).toMatch(/^sha256:/);
  });

  it("lists immutable content versions for an item", async () => {
    const contract = fixture("content-version-list.v1.json");
    const { client, requests } = clientFor(contract);

    const list = await client.contentVersions.list("item-parcels-1");

    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(list.itemId).toBe("item-parcels-1");
    expect(list.versions).toHaveLength(1);
  });

  it("returns an empty versions array for an item with no versions", async () => {
    const { client } = clientFor({
      request: { method: "GET", path: "/api/v1/studio/content-items/item-empty/versions" },
      response: {
        status: 200,
        body: { success: true, data: { itemId: "item-empty", versions: [] }, timestamp: "2026-07-01T00:00:00Z" },
      },
    });

    const list = await client.contentVersions.list("item-empty");

    expect(list).toEqual({ itemId: "item-empty", versions: [] });
  });

  it("retrieves one immutable content version", async () => {
    const contract = fixture("content-version-get.v1.json");
    const { client, requests } = clientFor(contract);

    const version = await client.contentVersions.get("item-parcels-1", "version-parcels-1");

    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(version.versionId).toBe("version-parcels-1");
  });

  it("throws not-found for a missing or cross-item version", async () => {
    const contract = fixture("content-version-not-found.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.contentVersions.get("item-parcels-1", "version-missing").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    expect((failure as HonuaStudioError).code).toBe("not-found");
    expect((failure as HonuaStudioError).statusCode).toBe(404);
  });

  it("compares two immutable versions", async () => {
    const contract = fixture("version-comparison.v1.json");
    const { client, requests } = clientFor(contract);

    const comparison = await client.contentVersions.compare("item-parcels-1", contract.request.body as never);

    expect(requests[0]).toMatchObject({ method: "POST", body: contract.request.body });
    expect(comparison.contentHashChanged).toBe(true);
    expect(comparison.dependencies?.added).toHaveLength(1);
    expect(comparison.validation?.compare?.status).toBe("warning");
  });

  it("reopens an immutable version into a new mutable draft", async () => {
    const contract = fixture("reopen.v1.json");
    const { client, requests } = clientFor(contract);

    const draft = await client.contentVersions.reopen("item-parcels-1", "version-parcels-1");

    expect(requests[0]?.url.pathname).toBe(contract.request.path);
    expect(draft.baseVersionId).toBe("version-parcels-1");
    expect(draft.draftId).toBe("draft-parcels-2");
  });

  it("creates a publication request that is accepted under the legacy synchronous behaviour", async () => {
    const contract = fixture("publish-request-legacy-accepted.v1.json");
    const { client, requests } = clientFor(contract);

    const request = await client.publicationRequests.create(
      "item-parcels-1",
      "version-parcels-1",
      contract.request.body as never,
    );

    expect(requests[0]).toMatchObject({ method: "POST", body: contract.request.body });
    expect(request.status).toBe("accepted");
  });

  it("creates a legacy publication request that is rejected for an invalid version without a body override", async () => {
    const contract = fixture("publish-request-legacy-rejected.v1.json");
    const { client, requests } = clientFor(contract);

    const request = await client.publicationRequests.create("item-parcels-1", "version-parcels-3");

    expect(requests[0]?.body).toEqual({});
    expect(request.status).toBe("rejected");
  });

  it("throws validation for an invalid publication intent override", async () => {
    const contract = fixture("publish-request-invalid-intent.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.publicationRequests
      .create("item-parcels-1", "version-parcels-1", contract.request.body as never)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(isHonuaStudioError(failure)).toBe(true);
    const error = failure as HonuaStudioError;
    expect(error.code).toBe("validation");
    expect(error.statusCode).toBe(400);
    expect(error.problem?.errors).toEqual({ "intent.route": ["Route must be an absolute path."] });
  });

  it("creates a rollback request and returns the resulting pointers", async () => {
    const contract = fixture("rollback-request.v1.json");
    const { client, requests } = clientFor(contract);

    const rollback = await client.rollbackRequests.create("item-parcels-1", contract.request.body as never);

    expect(requests[0]).toMatchObject({ method: "POST", body: contract.request.body });
    expect(rollback.pointer).toBe("both");
    expect(rollback.pointers).toEqual({
      itemId: "item-parcels-1",
      currentVersionId: "version-parcels-1",
      publishedVersionId: "version-parcels-1",
    });
  });

  it("classifies a caught internal failure as code: internal", async () => {
    const contract = fixture("internal-error.v1.json");
    const { client } = clientFor(contract);

    const failure = await client.drafts.validate("draft-parcels-1").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isHonuaStudioError(failure)).toBe(true);
    const error = failure as HonuaStudioError;
    expect(error.code).toBe("internal");
    expect(error.statusCode).toBe(500);
    expect(error.name).toBe("HonuaStudioError");
  });

  it("reaches an unmapped endpoint through the raw() escape hatch", async () => {
    const { client, requests } = clientFor({
      request: { method: "GET", path: "/api/v1/studio/package-drafts" },
      response: {
        status: 200,
        body: { success: true, data: { drafts: [] }, timestamp: "2026-07-01T00:00:00Z" },
      },
    });

    const result = await client.raw<{ drafts: unknown[] }>({ path: "/package-drafts" });

    expect(requests[0]?.url.pathname).toBe("/api/v1/studio/package-drafts");
    expect(result).toEqual({ drafts: [] });
  });

  it("supports a custom base path", async () => {
    const requests: CapturedRequest[] = [];
    const scoped = createHonuaStudioLifecycleClient({
      client: new HonuaClient({
        baseUrl: "https://example.test",
        fetchFn: async (input, init) => {
          const url = new URL(String(input));
          requests.push({ method: init?.method ?? "GET", url, body: undefined, headers: new Headers(init?.headers) });
          return new Response(
            JSON.stringify({ success: true, data: { families: [] }, timestamp: "2026-07-01T00:00:00Z" }),
            { status: 200 },
          );
        },
      }),
      basePath: "/tenant-a/studio",
    });

    await scoped.packageFamilies.list();

    expect(requests[0]?.url.pathname).toBe("/tenant-a/studio/package-families");
  });
});
