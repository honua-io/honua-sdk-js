import { describe, expect, it, vi } from "vitest";
import { DatasetImportSubmissionClient } from "../src/control-plane/dataset-import/submission-client.js";
import type {
  DatasetImportAuthorityDescriptor,
  DatasetImportSubmissionReceipt,
} from "../src/control-plane/dataset-import/types.js";

const reference = { taskId: "original-task", revision: 1, contentHash: "a".repeat(64) };
const options = { baseUrl: "https://honua.example", workspaceId: "original-workspace", targetId: "original-target" };
const reviewed: DatasetImportAuthorityDescriptor = {
  taskId: reference.taskId,
  taskRevision: reference.revision,
  taskContentHash: reference.contentHash,
  executorActorId: "actual-agent",
  initiatingHumanActorId: "original-human",
  originatingTurnId: "original-turn",
  originalTurnHash: "b".repeat(64),
  authorityRevision: 2,
  authorityFingerprint: "c".repeat(64),
  policyContextFingerprint: "d".repeat(64),
  uploadAdmissionDeadline: "2026-10-19T00:00:00Z",
};
const prepared = (): DatasetImportSubmissionReceipt => ({
  taskId: reference.taskId,
  taskRevision: reference.revision,
  taskContentHash: reference.contentHash,
  state: "prepared",
  operationId: "e".repeat(32),
  authorityRevision: 2,
  authorityFingerprint: reviewed.authorityFingerprint,
  policyContextFingerprint: reviewed.policyContextFingerprint,
  acceptBefore: reviewed.uploadAdmissionDeadline,
});
const accepted = (): DatasetImportSubmissionReceipt => ({
  ...prepared(),
  state: "accepted",
  job: {
    jobId: "e".repeat(32),
    leaseId: "actual-lease",
    status: "queued",
    createdAt: "2026-10-18T00:00:00Z",
    updatedAt: "2026-10-18T00:00:00Z",
  },
});

describe("canonical task-bound submission client", () => {
  it("represents human preparation awaiting actual agent separately from accepted job", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(prepared()))
      .mockResolvedValueOnce(Response.json(accepted()));
    const client = new DatasetImportSubmissionClient({ ...options, fetch: fetcher });
    const human = await client.submit(reference, reviewed);
    expect(human.state).toBe("prepared");
    expect(human.job).toBeUndefined();
    const agent = await client.submit(reference, reviewed);
    expect(agent.state).toBe("accepted");
    expect(agent.job?.jobId).toBe(human.operationId);
    expect(fetcher.mock.calls[0][0]).toContain("/original-task/versions/1/submission");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      taskContentHash: reference.contentHash,
      authorityRevision: 2,
      authorityFingerprint: reviewed.authorityFingerprint,
      policyContextFingerprint: reviewed.policyContextFingerprint,
    });
  });

  it("recovers unknown POST outcome with GET of original task and never automatically dispatches", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("reply lost"))
      .mockResolvedValueOnce(Response.json(prepared()));
    const client = new DatasetImportSubmissionClient({ ...options, fetch: fetcher });
    await expect(client.submit(reference, reviewed)).rejects.toThrow("reply lost");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await client.read(reference))?.state).toBe("prepared");
    expect(fetcher.mock.calls[1][1].method).toBe("GET");
    expect(fetcher.mock.calls[1][1].body).toBeUndefined();
    expect(fetcher.mock.calls[1][0]).toContain(`?contentHash=${reference.contentHash}`);
  });

  it("pins reviewed task and authority before fresh authentication resolves", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(prepared()));
    const client = new DatasetImportSubmissionClient({
      ...options,
      fetch: fetcher,
      headers: async () => {
        await wait;
        return { Authorization: "fresh", "X-Honua-Turn": "moving-turn" };
      },
      originatingTurnId: "original-turn",
    });
    const mutable = { ...reviewed };
    const mutableReference = { ...reference };
    const pending = client.submit(mutableReference, mutable);
    mutable.authorityRevision = 99;
    mutableReference.taskId = "later-task";
    release();
    expect((await pending).authorityRevision).toBe(2);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(init?.body as string).authorityRevision).toBe(2);
    expect(new Headers(init?.headers).get("X-Honua-Turn")).toBe("original-turn");
  });

  it.each([
    { taskId: "another-task" },
    { taskRevision: 2 },
    { taskContentHash: "b".repeat(64) },
    { operationId: `${"e".repeat(32)}\n` },
    { authorityRevision: 0 },
    { authorityFingerprint: `${"c".repeat(64)}\n` },
    { policyContextFingerprint: "changed" },
    { acceptBefore: "invalid" },
    { state: "accepted" },
    { job: accepted().job },
  ])("refuses malformed or retargeted submission receipt %j", async (changes) => {
    const client = new DatasetImportSubmissionClient({
      ...options,
      fetch: vi.fn(async () => Response.json({ ...prepared(), ...changes })),
    });
    await expect(client.submit(reference, reviewed)).rejects.toThrow();
  });

  it.each([
    { authorityRevision: 3 },
    { authorityFingerprint: "a".repeat(64) },
    { policyContextFingerprint: "b".repeat(64) },
    { acceptBefore: "2026-10-20T00:00:00Z" },
    { operationId: "f".repeat(32) },
    { state: "not-prepared", operationId: null },
  ])("known original preparation cannot reconcile to another binding %j", async (changes) => {
    const client = new DatasetImportSubmissionClient({
      ...options,
      fetch: vi.fn(async () => Response.json({ ...prepared(), ...changes })),
    });
    await expect(client.reconcile(reference, prepared())).rejects.toThrow();
  });

  it("retains absent receipt as unknown without recreating or dispatching", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    const client = new DatasetImportSubmissionClient({ ...options, fetch: fetcher });
    expect(await client.reconcile(reference, prepared())).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns actual successful physical output and preserves terminal receipt on reconciliation", async () => {
    const result: DatasetImportSubmissionReceipt = {
      ...accepted(),
      job: {
        ...accepted().job!,
        status: "succeeded",
        completedAt: "2026-10-18T00:01:00Z",
        updatedAt: "2026-10-18T00:01:00Z",
        output: { schema: "actual_schema", physicalTableName: "actual_output", featureCount: 3, detectedSrid: 4326 },
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(
        Response.json({ ...result, job: { ...result.job, output: { ...result.job!.output, featureCount: 4 } } }),
      );
    const client = new DatasetImportSubmissionClient({ ...options, fetch: fetcher });
    expect((await client.read(reference))?.job?.output?.physicalTableName).toBe("actual_output");
    await expect(client.reconcile(reference, result)).rejects.toThrow();
  });

  it("observes pending commit decisions by the original accepted job without dispatch or inferred completion", async () => {
    const pending: DatasetImportSubmissionReceipt = {
      ...accepted(),
      job: { ...accepted().job!, outcomePending: true },
    };
    const confirmed: DatasetImportSubmissionReceipt = {
      ...accepted(),
      job: { ...accepted().job!, outcomePending: false },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(pending))
      .mockResolvedValueOnce(Response.json(confirmed));
    const client = new DatasetImportSubmissionClient({ ...options, fetch: fetcher });
    const observed = await client.read(reference);
    expect(observed?.job?.outcomePending).toBe(true);
    expect(observed?.job?.status).toBe("queued");
    expect(observed?.job?.output).toBeUndefined();
    expect((await client.reconcile(reference, observed!))?.job?.outcomePending).toBe(false);
    expect(fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });

  it.each([null, "true", {}, 1])("rejects nonboolean pending metadata (%j)", async (outcomePending) => {
    const client = new DatasetImportSubmissionClient({
      ...options,
      fetch: vi.fn(async () => Response.json({ ...accepted(), job: { ...accepted().job, outcomePending } })),
    });
    await expect(client.read(reference)).rejects.toThrow();
  });

  it.each(["succeeded", "failed", "cancelled"])("rejects terminal job mislabeled as pending (%s)", async (status) => {
    const client = new DatasetImportSubmissionClient({
      ...options,
      fetch: vi.fn(async () =>
        Response.json({ ...accepted(), job: { ...accepted().job, status, outcomePending: true } }),
      ),
    });
    await expect(client.read(reference)).rejects.toThrow();
  });

  it("allows same-job nonterminal requeue after worker lease loss and rejects premature output", async () => {
    const original: DatasetImportSubmissionReceipt = { ...accepted(), job: { ...accepted().job!, status: "running" } };
    const resumed: DatasetImportSubmissionReceipt = {
      ...original,
      job: { ...original.job!, updatedAt: "2026-10-18T00:02:00Z" },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(accepted()))
      .mockResolvedValueOnce(Response.json(resumed));
    const client = new DatasetImportSubmissionClient({ ...options, fetch: fetcher });
    const requeued = await client.reconcile(reference, original);
    expect(requeued?.job?.status).toBe("queued");
    const running = await client.reconcile(reference, requeued!);
    expect(running?.job?.status).toBe("running");
    expect(running?.job?.jobId).toBe(original.job!.jobId);
    expect(fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
    const malformed: DatasetImportSubmissionReceipt = {
      ...accepted(),
      job: { ...accepted().job!, output: { schema: "public", physicalTableName: "guessed", featureCount: 1 } },
    };
    const other = new DatasetImportSubmissionClient({ ...options, fetch: vi.fn(async () => Response.json(malformed)) });
    await expect(other.read(reference)).rejects.toThrow();
  });
});
