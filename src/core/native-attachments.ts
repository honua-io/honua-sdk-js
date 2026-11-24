import type { CallOptions, Client } from "@connectrpc/connect";
import type { FeatureService } from "../gen/geospatial/v1/feature_service_pb.js";

type NativeClient = Client<typeof FeatureService>;
type Invoke = <T>(call: (client: NativeClient) => Promise<T>, options?: CallOptions) => Promise<T>;
type Request<Method extends keyof NativeClient> = Parameters<NativeClient[Method]>[0];

export function createNativeAttachments(invoke: Invoke) {
  return Object.freeze({
    list: (request: Request<"listAttachments">, options?: CallOptions) =>
      invoke((client) => client.listAttachments(request, options), options),
    downloadUrl: (request: Request<"getAttachmentUrl">, options?: CallOptions) =>
      invoke((client) => client.getAttachmentUrl(request, options), options),
    upload: (request: Request<"uploadAttachment">, options?: CallOptions) =>
      invoke((client) => client.uploadAttachment(request, options), options),
    beginUpload: (request: Request<"beginAttachmentUpload">, options?: CallOptions) =>
      invoke((client) => client.beginAttachmentUpload(request, options), options),
    uploadChunk: (request: Request<"uploadAttachmentChunk">, options?: CallOptions) =>
      invoke((client) => client.uploadAttachmentChunk(request, options), options),
    commitUpload: (request: Request<"commitAttachmentUpload">, options?: CallOptions) =>
      invoke((client) => client.commitAttachmentUpload(request, options), options),
    abortUpload: (request: Request<"abortAttachmentUpload">, options?: CallOptions) =>
      invoke((client) => client.abortAttachmentUpload(request, options), options),
    delete: (request: Request<"deleteAttachment">, options?: CallOptions) =>
      invoke((client) => client.deleteAttachment(request, options), options),
  });
}

export type HonuaNativeAttachments = ReturnType<typeof createNativeAttachments>;
