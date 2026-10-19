import { describe, expect, it, vi } from "vitest";
import { DatasetImportTaskClient } from "../src/control-plane/dataset-import/client.js";
import type { CreateDatasetImportTask } from "../src/control-plane/dataset-import/types.js";
const hash = "a".repeat(64);
const reference = {
  taskId: "import-task-original",
  revision: 1,
  contentHash: hash,
};
const task = {
  ...reference,
  workspaceId: "workspace-original",
  targetId: "target-original",
};
const options = {
  baseUrl: "https://honua.example/deployment",
  workspaceId: "workspace-original",
  targetId: "target-original",
};
const createRequest = (): CreateDatasetImportTask => ({
  intentId: "original-intent",
  viewId: "original-view",
  contextRevision: 7,
  destination: { schema: "public", table: "roads" },
  source: {
    kind: "browser-file",
    fileName: "roads.geojson",
    totalBytes: 9000000000,
    expectedSha256: hash,
    browserSelectionId: "original-human-file",
  },
  options: { loadMode: 1, targetSrid: 4326 },
});

describe("canonical import task client", () => {
  it("pins scope and submitted fields before awaiting fresh authentication", async () => {
    let release!: (headers: HeadersInit) => void;
    const authentication = new Promise<HeadersInit>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async () => Response.json(task));
    const mutableOptions = {
      ...options,
      originatingTurnId: "original-turn",
      fetch: fetcher as typeof fetch,
      headers: () => authentication,
    };
    const client = new DatasetImportTaskClient(mutableOptions);
    const request = createRequest();
    const saving = client.createTask(request);
    mutableOptions.workspaceId = "later-workspace";
    mutableOptions.originatingTurnId = "later-turn";
    (request.destination as { table: string }).table = "later_table";
    (request.source as { browserSelectionId: string }).browserSelectionId = "later-human-file";
    release({
      Authorization: "Bearer refreshed",
      "X-Honua-Workspace": "injected",
      "X-Honua-Turn": "injected",
    });
    await saving;
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://honua.example/deployment/api/v1/agent/workspaces/workspace-original/dataset-import-tasks",
    );
    expect(JSON.parse(init.body as string).destination.table).toBe("roads");
    expect(JSON.parse(init.body as string).source.browserSelectionId).toBe("original-human-file");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer refreshed");
    expect(headers.get("X-Honua-Workspace")).toBe("workspace-original");
    expect(headers.get("X-Honua-Turn")).toBe("original-turn");
    expect(init.redirect).toBe("error");
  });

  it("keeps a lost create reply unknown and recovers original intent with GET only", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("reply lost"))
      .mockResolvedValueOnce(Response.json(task));
    const client = new DatasetImportTaskClient({ ...options, fetch: fetcher });
    await expect(client.createTask(createRequest())).rejects.toThrow("reply lost");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client.readIntent("original-intent")).toEqual(task);
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toContain("/dataset-import-task-intents/original-intent");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("returns null for unknown read without creating a task or renewal", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    const client = new DatasetImportTaskClient({
      ...options,
      fetch: fetcher as typeof fetch,
    });
    expect(await client.readIntent("original-intent")).toBeNull();
    expect(await client.readAuthority(reference)).toBeNull();
    expect(fetcher.mock.calls).toHaveLength(2);
  });

  it.each([{ workspaceId: "foreign" }, { targetId: "foreign" }, { contentHash: "b".repeat(64) }])(
    "rejects a response with a different immutable binding (%j)",
    async (changed) => {
      const client = new DatasetImportTaskClient({
        ...options,
        fetch: vi.fn(async () => Response.json({ ...task, ...changed })),
      });
      await expect(client.readTask(reference)).rejects.toThrow();
    },
  );

  it("pins descriptor lookup before delayed authentication and rejects a mismatched descriptor", async () => {
    let release!: (headers: HeadersInit) => void;
    const authentication = new Promise<HeadersInit>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async () =>
      Response.json({
        taskId: "foreign",
        taskRevision: 1,
        taskContentHash: hash,
        authorityRevision: 2,
      }),
    );
    const client = new DatasetImportTaskClient({
      ...options,
      headers: () => authentication,
      fetch: fetcher as typeof fetch,
    });
    const mutable = { ...reference };
    const reading = client.readAuthority(mutable);
    mutable.taskId = "later-task";
    release({});
    await expect(reading).rejects.toThrow("immutable task binding");
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toContain(
      `/import-task-original/versions/1/authority?contentHash=${hash}`,
    );
  });

  it("requires a complete authority descriptor instead of guessing missing preparation fields", async () => {
    const descriptor = {
      taskId: reference.taskId,
      taskRevision: reference.revision,
      taskContentHash: hash,
      executorActorId: "actual-executor",
      originatingTurnId: "original-turn",
      originalTurnHash: hash,
      authorityRevision: 4,
      authorityFingerprint: hash,
      policyContextFingerprint: hash,
      uploadAdmissionDeadline: "2026-10-19T00:00:00Z",
      preparedOperationId: "b".repeat(32),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(descriptor))
      .mockResolvedValueOnce(Response.json({ ...descriptor, authorityFingerprint: null }));
    const client = new DatasetImportTaskClient({ ...options, fetch: fetcher });
    expect(await client.readAuthority(reference)).toEqual(descriptor);
    await expect(client.readAuthority(reference)).rejects.toThrow("immutable task binding");
  });

  it("replays the same renewal without inferring a newer authority revision", async () => {
    const receipt = {
      renewalId: "original-renewal",
      previousAuthorityRevision: 4,
      authorityRevision: 5,
      authorityFingerprint: hash,
      renewedAt: "2026-10-18T00:00:00Z",
    };
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("lost renewal reply"))
      .mockResolvedValueOnce(Response.json(receipt));
    const client = new DatasetImportTaskClient({ ...options, fetch: fetcher });
    const request = {
      renewalId: receipt.renewalId,
      expectedAuthorityRevision: 4,
      taskContentHash: hash,
    };
    await expect(client.renewAuthority(reference, request)).rejects.toThrow("lost renewal reply");
    expect(await client.renewAuthority(reference, request)).toEqual(receipt);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  });

  it("removes turn headers supplied by authentication for explicit human requests", async () => {
    const fetcher = vi.fn(async () => Response.json(task));
    const client = new DatasetImportTaskClient({
      ...options,
      fetch: fetcher as typeof fetch,
      headers: () => ({
        "X-Honua-Turn": "agent-turn",
        "X-Honua-Workspace": "agent-workspace",
      }),
    });
    await client.readIntent("original-intent");
    const headers = new Headers((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.has("X-Honua-Turn")).toBe(false);
    expect(headers.has("X-Honua-Workspace")).toBe(false);
  });

  it.each([`${hash}\n`, "a".repeat(63), "A".repeat(64)])(
    "refuses noncanonical hash before network (%s)",
    async (contentHash) => {
      const fetcher = vi.fn();
      const client = new DatasetImportTaskClient({
        ...options,
        fetch: fetcher,
      });
      await expect(client.readAuthority({ ...reference, contentHash })).rejects.toThrow(TypeError);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
