import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DatasetImportUploadReceipt } from "../src/control-plane/dataset-import/types.js";
import { DatasetImportUploadClient } from "../src/control-plane/dataset-import/upload-client.js";

const hash = "a".repeat(64);
const reference = { taskId: "original-task", revision: 1, contentHash: hash };
const options = { baseUrl: "https://honua.example", workspaceId: "original-workspace", targetId: "original-target" };
const receipt = (changes: Partial<DatasetImportUploadReceipt> = {}): DatasetImportUploadReceipt => ({
  taskId: reference.taskId,
  taskRevision: 1,
  taskContentHash: hash,
  uploadId: "b".repeat(32),
  version: 1,
  state: "receiving",
  acceptedBytes: 0,
  totalBytes: 3,
  chunkBytes: 4 * 1024 * 1024,
  chunkCount: 0,
  expiresAt: "2026-10-19T00:00:00Z",
  ...changes,
});
const digest = createHash("sha256").update("abc").digest("hex");

describe("canonical task-bound upload client", () => {
  it("keeps unknown create outcome and recovers original task with GET, without another create", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json(receipt()));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    await expect(client.create(reference)).rejects.toThrow("connection lost");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client.read(reference)).toEqual(receipt());
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toContain(`/dataset-import-tasks/original-task/versions/1/upload?contentHash=${hash}`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("returns absent/unsupported capability without creating a transfer", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher as typeof fetch });
    expect(await client.capabilities(reference)).toBeNull();
    expect(await client.read(reference)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { chunkBytes: 4 * 1024 * 1024, maximumFileBytes: 1024 ** 4, importAcceptanceSupported: false },
    { chunkBytes: 8 * 1024 * 1024, maximumFileBytes: 1024, importAcceptanceSupported: false },
    { chunkBytes: 4 * 1024 * 1024, maximumFileBytes: 1024, importAcceptanceSupported: true },
  ])("refuses unsupported or overstated transfer capabilities (%j)", async (capability) => {
    const client = new DatasetImportUploadClient({ ...options, fetch: vi.fn(async () => Response.json(capability)) });
    await expect(client.capabilities(reference)).rejects.toThrow("capability contract");
  });

  it("hashes exact bounded next bytes and pins range/session before authentication", async () => {
    let release!: (headers: HeadersInit) => void;
    const authentication = new Promise<HeadersInit>((resolve) => {
      release = resolve;
    });
    const next = receipt({ version: 2, acceptedBytes: 3, chunkCount: 1 });
    const fetcher = vi.fn(async () => Response.json(next));
    const client = new DatasetImportUploadClient({
      ...options,
      fetch: fetcher as typeof fetch,
      originatingTurnId: "original-turn",
      headers: () => authentication,
    });
    const mutable = { ...reference };
    const original = { ...receipt() };
    const appending = client.appendChunk(mutable, original, new Blob(["abc"]));
    mutable.taskId = "later-task";
    original.uploadId = "c".repeat(32);
    original.version = 99;
    original.acceptedBytes = 3;
    release({ Authorization: "Bearer fresh", "X-Honua-Turn": "later-turn" });
    expect(await appending).toEqual(next);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(
      `/original-task/versions/1/upload/chunks?contentHash=${hash}&expectedVersion=1&offset=0&sha256=${digest}`,
    );
    expect(init.method).toBe("PUT");
    expect(await (init.body as Blob).text()).toBe("abc");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
    expect(headers.get("X-Honua-Turn")).toBe("original-turn");
    expect(headers.get("Authorization")).toBe("Bearer fresh");
  });

  it("does not resend an uncertain chunk before reading its actual accepted range", async () => {
    const next = receipt({ version: 2, acceptedBytes: 3, chunkCount: 1 });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("chunk reply lost"))
      .mockResolvedValueOnce(Response.json(next));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    await expect(client.appendChunk(reference, receipt(), new Blob(["abc"]))).rejects.toThrow("chunk reply lost");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client.read(reference)).toEqual(next);
    expect(fetcher.mock.calls[1][1].method).toBe("GET");
  });

  it("serializes seal/source CAS before awaits and keeps retention separate from import acceptance", async () => {
    const sealed = receipt({ version: 3, state: "sealed", acceptedBytes: 3, chunkCount: 1, contentSha256: digest });
    const retained = { ...sealed, version: 4, sourceRetention: { bytes: 3, sha256: digest, expiresAt: null } };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(sealed)).mockResolvedValueOnce(Response.json(retained));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    const original = { ...receipt({ version: 2, acceptedBytes: 3, chunkCount: 1 }) };
    const sealing = client.seal(reference, original);
    original.version = 999;
    expect(await sealing).toEqual(sealed);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ taskContentHash: hash, expectedVersion: 2 });
    expect(await client.retainSource(reference, sealed)).toEqual(retained);
    expect(fetcher.mock.calls[1][0]).toContain("/upload/source");
    expect(retained).not.toHaveProperty("jobId");
  });

  it("sends cancellation against the original version without a body or replacement session", async () => {
    const cancelled = receipt({ version: 2, state: "cancelled" });
    const fetcher = vi.fn(async () => Response.json(cancelled));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher as typeof fetch });
    expect(await client.cancel(reference, receipt())).toEqual(cancelled);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`?contentHash=${hash}&expectedVersion=1`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it.each([
    { taskId: "foreign" },
    { uploadId: "invalid" },
    { taskContentHash: "c".repeat(64) },
    { acceptedBytes: 2, chunkCount: 1 },
    { state: "sealed", contentSha256: hash },
    { sourceRetention: { bytes: 3, sha256: hash } },
  ])("rejects a noncanonical or foreign receipt before mutation (%j)", async (change) => {
    const fetcher = vi.fn();
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    await expect(client.seal(reference, receipt(change as Partial<DatasetImportUploadReceipt>))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses an incomplete next chunk and cancellation without reading or sending bytes", async () => {
    const fetcher = vi.fn();
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    await expect(client.appendChunk(reference, receipt(), new Blob(["ab"]))).rejects.toThrow("Exactly one");
    const controller = new AbortController();
    controller.abort();
    await expect(client.appendChunk(reference, receipt(), new Blob(["abc"]), controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["append", "seal", "source", "cancel"] as const)(
    "pins all immutable session fields on %s responses",
    async (action) => {
      for (const change of [
        { totalBytes: 6 },
        { chunkBytes: 2 * 1024 * 1024 },
        { expiresAt: "2026-10-20T00:00:00Z" },
      ]) {
        const original =
          action === "seal" || action === "source"
            ? receipt({
                version: 2,
                acceptedBytes: 3,
                chunkCount: 1,
                ...(action === "source" ? { state: "sealed", contentSha256: digest } : {}),
              })
            : receipt();
        const next =
          action === "cancel"
            ? receipt({ version: 2, state: "cancelled", ...change })
            : receipt({
                version: 3,
                acceptedBytes: change.totalBytes ?? 3,
                chunkCount: 1,
                ...(action === "append" ? {} : { state: "sealed", contentSha256: digest }),
                ...change,
              });
        const fetcher = vi.fn(async () => Response.json(next));
        const client = new DatasetImportUploadClient({ ...options, fetch: fetcher as typeof fetch });
        const mutate =
          action === "append"
            ? client.appendChunk(reference, original, new Blob(["abc"]))
            : action === "seal"
              ? client.seal(reference, original)
              : action === "source"
                ? client.retainSource(reference, original)
                : client.cancel(reference, original);
        await expect(mutate).rejects.toThrow("immutable task/session binding");
        expect(fetcher).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("captures original session fields before authentication and later caller mutation", async () => {
    let release!: (headers: HeadersInit) => void;
    const authentication = new Promise<HeadersInit>((resolve) => {
      release = resolve;
    });
    const original = { ...receipt() };
    const client = new DatasetImportUploadClient({
      ...options,
      headers: () => authentication,
      fetch: vi.fn(async () => Response.json(receipt({ version: 2, state: "cancelled" }))),
    });
    const cancelling = client.cancel(reference, original);
    original.totalBytes = 6;
    original.chunkBytes = 2 * 1024 * 1024;
    original.expiresAt = "2026-10-20T00:00:00Z";
    release({});
    expect(await cancelling).toEqual(receipt({ version: 2, state: "cancelled" }));
  });

  it("reconciles known uncertain sessions with GET and refuses changed admission deadline", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(receipt({ version: 2, acceptedBytes: 3, chunkCount: 1 })))
      .mockResolvedValueOnce(Response.json(receipt({ expiresAt: "2026-10-20T00:00:00Z" })))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    expect((await client.reconcile(reference, receipt()))?.acceptedBytes).toBe(3);
    await expect(client.reconcile(reference, receipt())).rejects.toThrow("immutable task/session binding");
    expect(await client.reconcile(reference, receipt())).toBeNull();
    expect(fetcher.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });

  it("never replaces an original retained source receipt or regresses terminal state", async () => {
    const original = receipt({
      version: 4,
      state: "sealed",
      acceptedBytes: 3,
      chunkCount: 1,
      contentSha256: digest,
      sourceRetention: { bytes: 3, sha256: digest, expiresAt: "2026-10-19T00:00:00Z" },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ...original,
          version: 5,
          sourceRetention: { ...original.sourceRetention, expiresAt: "2026-10-20T00:00:00Z" },
        }),
      )
      .mockResolvedValueOnce(Response.json(receipt({ version: 5, acceptedBytes: 3, chunkCount: 1 })));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    await expect(client.retainSource(reference, original)).rejects.toThrow("original retained source");
    await expect(client.reconcile(reference, original)).rejects.toThrow("immutable task/session binding");
  });

  it("requires unchanged projected state for the same CAS version and fixed bytes after cancellation", async () => {
    const receiving = receipt();
    const complete = receipt({ version: 2, acceptedBytes: 3, chunkCount: 1 });
    const sealed = { ...complete, state: "sealed" as const, contentSha256: digest };
    const cancelled = receipt({ version: 4, state: "cancelled" });
    for (const [original, returned] of [
      [receiving, { ...receiving, acceptedBytes: 3, chunkCount: 1 }],
      [receiving, { ...receiving, state: "cancelled" }],
      [complete, sealed],
      [sealed, { ...sealed, sourceRetention: { bytes: 3, sha256: digest, expiresAt: null } }],
      [cancelled, { ...cancelled, version: 5, acceptedBytes: 3, chunkCount: 1 }],
    ] as const) {
      const client = new DatasetImportUploadClient({ ...options, fetch: vi.fn(async () => Response.json(returned)) });
      await expect(client.reconcile(reference, original)).rejects.toThrow("immutable task/session binding");
    }
  });

  it("allows identical same-version terminal reads and a later-version new source receipt", async () => {
    const sealed = receipt({ version: 3, state: "sealed", acceptedBytes: 3, chunkCount: 1, contentSha256: digest });
    const retained = { ...sealed, version: 4, sourceRetention: { bytes: 3, sha256: digest } };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ...retained, sourceRetention: { ...retained.sourceRetention, expiresAt: null } }),
      )
      .mockResolvedValueOnce(Response.json(retained));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    expect(await client.reconcile(reference, retained)).toEqual({
      ...retained,
      sourceRetention: { ...retained.sourceRetention, expiresAt: null },
    });
    expect(await client.reconcile(reference, sealed)).toEqual(retained);
  });

  it("rejects another session returned after a mutation instead of overwriting the original", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(receipt({ uploadId: "c".repeat(32), version: 2, state: "cancelled" })),
    );
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher as typeof fetch });
    await expect(client.cancel(reference, receipt())).rejects.toThrow("immutable task/session binding");
  });
});
