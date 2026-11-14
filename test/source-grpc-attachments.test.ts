import { describe, expect, it, vi } from "vitest";
import { nativeAttachmentApi } from "../src/contract/native-attachments.js";
import type { SourceDescriptor } from "../src/contract/types.js";
import type { HonuaClient } from "../src/core/client.js";
import { HonuaGrpcError } from "../src/core/errors.js";

function fixture() {
  const attachment = { attachmentId: 9007199254740993n, name: "photo", contentType: "image/png", sizeBytes: 3n };
  const client = {
    describeLayer: vi
      .fn()
      .mockResolvedValue({ layer: { attachmentLimits: { maxUnaryUploadBytes: 1n, maxFileBytes: 100n } } }),
    attachments: {
      list: vi.fn().mockResolvedValue({ attachments: [attachment], nextPageToken: "" }),
      upload: vi.fn(),
      beginUpload: vi
        .fn()
        .mockResolvedValue({ session: { sessionId: "session", nextOffsetBytes: 1n, maxChunkBytes: 2n } }),
      uploadChunk: vi
        .fn()
        .mockResolvedValue({ session: { sessionId: "session", nextOffsetBytes: 3n, maxChunkBytes: 2n } }),
      commitUpload: vi.fn().mockResolvedValue({ attachment }),
      delete: vi.fn().mockResolvedValue({ attachmentId: attachment.attachmentId }),
      abortUpload: vi.fn().mockResolvedValue({}),
      downloadUrl: vi
        .fn()
        .mockResolvedValue({ url: "https://cdn.example/a?sig=1", expiresAtUtcMs: 1_700_000_000_000n, attachment }),
    },
  };
  const descriptor = { id: "photos", protocol: "grpc" } as SourceDescriptor;
  const api = nativeAttachmentApi({
    client: client as unknown as HonuaClient,
    descriptor,
    caps: new Set(["attachments"]),
    serviceId: "map",
    layerId: 7,
  });
  return { client, api, attachment };
}

describe("native Source.attachments", () => {
  it("preserves exact IDs and follows independent attachment continuation", async () => {
    const { client, api, attachment } = fixture();
    client.attachments.list.mockResolvedValueOnce({ attachments: [attachment], nextPageToken: "next" });
    const items = await api.list("9007199254740995");
    expect(items[0].id).toBe("9007199254740993");
    expect(client.attachments.list.mock.calls[1][0]).toMatchObject({
      parent: { serviceId: "map", layerId: 7, identity: { case: "objectId", value: 9007199254740995n } },
      pageToken: "next",
    });
  });
  it("resumes a replacement at the server offset and hashes the exact remaining chunk", async () => {
    const { client, api } = fixture();
    const outcome = await api.update({
      parentId: 17,
      attachmentId: "9007199254740993",
      attachment: new Blob([new Uint8Array([1, 2, 3])]),
      idempotencyKey: "retry",
      name: "photo",
    });
    expect(outcome.attachmentId).toBe("9007199254740993");
    expect(client.attachments.beginUpload.mock.calls[0][0].upload).toMatchObject({
      replaceAttachmentId: 9007199254740993n,
      idempotencyKey: "retry",
      sizeBytes: 3n,
    });
    const chunk = client.attachments.uploadChunk.mock.calls[0][0];
    expect(chunk.offsetBytes).toBe(1n);
    expect(chunk.content).toEqual(new Uint8Array([2, 3]));
    expect(chunk.sha256).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([2, 3]))));
    expect(client.attachments.upload).not.toHaveBeenCalled();
  });
});

describe("native Source.attachments query guards", () => {
  it("rejects nonadvancing pagination and unsupported queries", async () => {
    const { client, api } = fixture();
    client.attachments.list.mockResolvedValue({ attachments: [], nextPageToken: "stuck" });
    await expect(api.list(17)).rejects.toThrow("did not advance");
    await expect(api.query({ where: "1=1" })).rejects.toThrow("filter text");
    await expect(api.query()).rejects.toThrow("explicit parent IDs");
  });
});

describe("native Source.attachments chunk sessions", () => {
  it("does not commit a chunk response that skips bytes", async () => {
    const { client, api } = fixture();
    client.attachments.uploadChunk.mockResolvedValue({
      session: { sessionId: "session", nextOffsetBytes: 99n, maxChunkBytes: 2n },
    });
    await expect(api.add({ parentId: 17, attachment: new Blob([new Uint8Array([1, 2, 3])]) })).rejects.toThrow(
      "invalid next offset",
    );
    expect(client.attachments.commitUpload).not.toHaveBeenCalled();
    expect(client.attachments.abortUpload).not.toHaveBeenCalled();
  });
  it("keeps the session open after a transient chunk failure so a same-key retry resumes", async () => {
    const { client, api } = fixture();
    const failure = new Error("network");
    client.attachments.uploadChunk.mockRejectedValueOnce(failure);
    const request = { parentId: 17, attachment: new Blob([new Uint8Array([1, 2, 3])]), idempotencyKey: "k" };
    await expect(api.add(request)).rejects.toBe(failure);
    expect(client.attachments.abortUpload).not.toHaveBeenCalled();
    await expect(api.add(request)).resolves.toMatchObject({ success: true });
    expect(client.attachments.beginUpload.mock.calls[1][0].upload.idempotencyKey).toBe("k");
  });
});

describe("native Source.attachments cancellation", () => {
  it("aborts the session only on cancellation and rethrows the original error", async () => {
    const { client, api } = fixture();
    const controller = new AbortController();
    const failure = new Error("cancelled");
    client.attachments.uploadChunk.mockImplementation(async () => {
      controller.abort();
      throw failure;
    });
    client.attachments.abortUpload.mockRejectedValue(new Error("abort failed"));
    await expect(
      api.add({ parentId: 17, attachment: new Blob([new Uint8Array([1, 2, 3])]), signal: controller.signal }),
    ).rejects.toBe(failure);
    expect(client.attachments.abortUpload).toHaveBeenCalledWith({ sessionId: "session" });
  });
});

describe("native Source.attachments limits and commit", () => {
  it("never aborts a session whose commit was sent", async () => {
    const { client, api } = fixture();
    const controller = new AbortController();
    client.attachments.commitUpload.mockImplementation(async () => {
      controller.abort();
      throw new Error("lost response");
    });
    await expect(
      api.add({ parentId: 17, attachment: new Blob([new Uint8Array([1, 2, 3])]), signal: controller.signal }),
    ).rejects.toThrow("lost response");
    expect(client.attachments.abortUpload).not.toHaveBeenCalled();
  });
  it("uses a session when the unary limit is not advertised and clamps sentinel chunk sizes", async () => {
    const { client, api } = fixture();
    client.describeLayer.mockResolvedValue({
      layer: { attachmentLimits: { maxUnaryUploadBytes: 0n, maxFileBytes: 0n, maxChunkBytes: 0n } },
    });
    client.attachments.beginUpload.mockResolvedValue({
      session: { sessionId: "session", nextOffsetBytes: 0n, maxChunkBytes: 9223372036854775807n },
    });
    await expect(api.add({ parentId: 17, attachment: new Blob([new Uint8Array([1, 2, 3])]) })).resolves.toMatchObject({
      success: true,
    });
    expect(client.attachments.upload).not.toHaveBeenCalled();
    expect(client.attachments.uploadChunk.mock.calls[0][0].content).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("native Source.attachments identities, deletes and downloads", () => {
  it("addresses brace-wrapped global IDs and rejects other non-numeric parents", async () => {
    const { client, api } = fixture();
    await api.list("{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}");
    expect(client.attachments.list.mock.calls[0][0].parent.identity).toEqual({
      case: "globalId",
      value: "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0",
    });
    await expect(api.list("parcel-7")).rejects.toThrow(TypeError);
  });
  it("reports one delete outcome per row when a later row fails", async () => {
    const { client, api } = fixture();
    client.attachments.delete
      .mockResolvedValueOnce({ attachmentId: 1n })
      .mockRejectedValueOnce(new HonuaGrpcError(5, "attachment not found"));
    const outcomes = await api.delete({ parentId: 17, attachmentIds: [1, 2], idempotencyKey: "d" });
    expect(outcomes).toEqual([
      { parentId: 17, attachmentId: "1", success: true },
      { parentId: 17, attachmentId: "2", success: false, error: { code: 5, description: "attachment not found" } },
    ]);
    expect(client.attachments.delete.mock.calls[1][0].idempotencyKey).toBe("d:2");
  });
  it("returns a signed download URL with its expiry", async () => {
    const { client, api } = fixture();
    const signed = await api.downloadUrl?.(17, "9007199254740993");
    expect(signed).toMatchObject({
      url: "https://cdn.example/a?sig=1",
      attachment: { id: "9007199254740993", parentId: 17 },
    });
    expect(signed?.expiresAt.getTime()).toBe(1_700_000_000_000);
    expect(client.attachments.downloadUrl.mock.calls[0][0]).toMatchObject({
      attachmentId: 9007199254740993n,
      parent: { identity: { case: "objectId", value: 17n } },
    });
  });
});
