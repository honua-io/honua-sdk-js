import { type DescMessage, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { HonuaClient } from "../src/core/client.js";
import {
  AbortAttachmentUploadRequestSchema,
  AbortAttachmentUploadResponseSchema,
  BeginAttachmentUploadRequestSchema,
  BeginAttachmentUploadResponseSchema,
  CommitAttachmentUploadRequestSchema,
  CommitAttachmentUploadResponseSchema,
  DeleteAttachmentRequestSchema,
  DeleteAttachmentResponseSchema,
  GetAttachmentUrlRequestSchema,
  GetAttachmentUrlResponseSchema,
  ListAttachmentsRequestSchema,
  ListAttachmentsResponseSchema,
  UploadAttachmentChunkRequestSchema,
  UploadAttachmentChunkResponseSchema,
  UploadAttachmentRequestSchema,
  UploadAttachmentResponseSchema,
} from "../src/gen/geospatial/v1/attachment_types_pb.js";

const parent = { serviceId: "parcels", layerId: 7, identity: { case: "objectId" as const, value: 9007199254740993n } };
const descriptor = {
  attachmentId: 9007199254740995n,
  sizeBytes: 9007199254740997n,
  name: "photo.png",
  keywords: ["survey"],
  sha256: new Uint8Array(32),
};
const upload = {
  parent,
  name: "photo.png",
  contentType: "image/png",
  sizeBytes: 2n,
  sha256: new Uint8Array(32),
  idempotencyKey: "upload-key",
  replaceAttachmentId: descriptor.attachmentId,
};
const session = {
  sessionId: "session",
  nextOffsetBytes: 9007199254740999n,
  maxChunkBytes: 1048576n,
  expiresAtUtcMs: 1800000000000n,
};

import { wireResponse as response } from "./helpers/grpc-wire.js";

type UnaryOperation = {
  method: keyof HonuaClient["attachments"];
  rpc: string;
  requestSchema: DescMessage;
  responseSchema: DescMessage;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
};

const operations: readonly UnaryOperation[] = [
  {
    method: "list",
    rpc: "ListAttachments",
    requestSchema: ListAttachmentsRequestSchema,
    responseSchema: ListAttachmentsResponseSchema,
    request: { parent, pageSize: 2, pageToken: "cursor", keywords: ["survey"] },
    result: { attachments: [descriptor], nextPageToken: "next" },
  },
  {
    method: "downloadUrl",
    rpc: "GetAttachmentUrl",
    requestSchema: GetAttachmentUrlRequestSchema,
    responseSchema: GetAttachmentUrlResponseSchema,
    request: { parent, attachmentId: descriptor.attachmentId },
    result: {
      attachment: descriptor,
      url: "https://download.example.test/file?grant=short",
      expiresAtUtcMs: 1800000000000n,
    },
  },
  {
    method: "upload",
    rpc: "UploadAttachment",
    requestSchema: UploadAttachmentRequestSchema,
    responseSchema: UploadAttachmentResponseSchema,
    request: { upload, content: new Uint8Array([1, 2]) },
    result: { attachment: descriptor },
  },
  {
    method: "beginUpload",
    rpc: "BeginAttachmentUpload",
    requestSchema: BeginAttachmentUploadRequestSchema,
    responseSchema: BeginAttachmentUploadResponseSchema,
    request: { upload },
    result: { session },
  },
  {
    method: "uploadChunk",
    rpc: "UploadAttachmentChunk",
    requestSchema: UploadAttachmentChunkRequestSchema,
    responseSchema: UploadAttachmentChunkResponseSchema,
    request: {
      sessionId: session.sessionId,
      offsetBytes: session.nextOffsetBytes,
      content: new Uint8Array([1, 2]),
      sha256: new Uint8Array(32),
    },
    result: { session },
  },
  {
    method: "commitUpload",
    rpc: "CommitAttachmentUpload",
    requestSchema: CommitAttachmentUploadRequestSchema,
    responseSchema: CommitAttachmentUploadResponseSchema,
    request: { sessionId: session.sessionId },
    result: { attachment: descriptor },
  },
  {
    method: "abortUpload",
    rpc: "AbortAttachmentUpload",
    requestSchema: AbortAttachmentUploadRequestSchema,
    responseSchema: AbortAttachmentUploadResponseSchema,
    request: { sessionId: session.sessionId },
    result: {},
  },
  {
    method: "delete",
    rpc: "DeleteAttachment",
    requestSchema: DeleteAttachmentRequestSchema,
    responseSchema: DeleteAttachmentResponseSchema,
    request: { parent, attachmentId: descriptor.attachmentId, idempotencyKey: "delete-key" },
    result: { attachmentId: descriptor.attachmentId },
  },
];

describe("native attachment unary transport", () => {
  for (const operation of operations) {
    it(`encodes ${operation.rpc} without REST and preserves exact values`, async () => {
      let calls = 0;
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        transport: "grpc-web",
        apiKey: "key",
        fetchFn: async (input, init) => {
          calls++;
          expect(String(input)).toBe(`https://example.test/geospatial.v1.FeatureService/${operation.rpc}`);
          expect(new Headers(init?.headers).get("x-api-key")).toBe("key");
          const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
          expect(bytes[0]).toBe(0);
          const schema = operation.requestSchema;
          expect(fromBinary(schema, bytes.subarray(5))).toMatchObject(operation.request);
          return response(toBinary(operation.responseSchema, create(operation.responseSchema, operation.result)));
        },
      });
      const invoke = client.attachments[operation.method] as (request: unknown) => Promise<unknown>;
      expect(await invoke(operation.request)).toMatchObject(operation.result);
      expect(calls).toBe(1);
    });
  }
  it("rejects REST clients before fetching", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () => {
        throw new Error("unexpected fetch");
      },
    });
    await expect(client.attachments.list({ parent })).rejects.toThrow("grpc-web");
  });
});

describe("native attachment unary transport failures", () => {
  it("propagates server failure rather than returning an empty list", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: async () =>
        new Response(null, {
          headers: { "content-type": "application/grpc-web+proto", "grpc-status": "7", "grpc-message": "denied" },
        }),
    });
    await expect(client.attachments.list({ parent })).rejects.toThrow();
  });
  it("passes cancellation to the unary transport", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: async () => {
        calls++;
        throw new Error("unexpected fetch");
      },
    });
    await expect(client.attachments.list({ parent }, { signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
