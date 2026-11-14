import type { HonuaClient } from "../core/client.js";
import { HonuaCapabilityNotSupportedError, HonuaGrpcError } from "../core/errors.js";
import type { AttachmentDescriptor } from "../gen/geospatial/v1/attachment_types_pb.js";
import type {
  AttachmentAdd,
  AttachmentApi,
  AttachmentDelete,
  AttachmentDownloadUrl,
  AttachmentEditOutcome,
  AttachmentInfo,
  AttachmentUpdate,
  Capability,
  FeatureId,
  SourceDescriptor,
} from "./types.js";

function integerId(value: FeatureId): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new RangeError("Attachment IDs must be exact integers.");
  const id = BigInt(value);
  if (id <= 0n || id > 9223372036854775807n) throw new RangeError("Attachment ID is outside positive int64.");
  return id;
}

const GLOBAL_ID = /^\{?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\}?$/i;

function parentIdentity(value: FeatureId) {
  // GeoServices global IDs are usually brace-wrapped; the wire carries the bare UUID.
  const globalId = typeof value === "string" ? GLOBAL_ID.exec(value.trim())?.[1] : undefined;
  if (globalId) return { case: "globalId" as const, value: globalId };
  if (typeof value === "string" && !/^\d+$/.test(value.trim()))
    throw new TypeError("Attachment parent IDs must be object IDs or global ID UUIDs.");
  return { case: "objectId" as const, value: integerId(value) };
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((least, value) => (value < least ? value : least));
}

function attachmentInfo(value: AttachmentDescriptor, parentId: FeatureId): AttachmentInfo {
  const size = Number(value.sizeBytes);
  if (!Number.isSafeInteger(size)) throw new RangeError("Attachment size exceeds the canonical numeric range.");
  return { id: value.attachmentId.toString(), parentId, name: value.name, contentType: value.contentType, size };
}

async function digest(content: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", content));
}

interface NativeAttachmentSource {
  client: HonuaClient;
  descriptor: SourceDescriptor;
  caps: ReadonlySet<Capability>;
  serviceId: string;
  layerId: number;
}

type Attachments = HonuaClient["attachments"];
type UploadMetadata = Parameters<Attachments["beginUpload"]>[0]["upload"];
type UploadSession = NonNullable<Awaited<ReturnType<Attachments["beginUpload"]>>["session"]>;
type CallSignal = { signal?: AbortSignal };

interface ChunkedUpload {
  upload: UploadMetadata;
  content: Uint8Array<ArrayBuffer>;
  layerMaxChunkBytes: bigint;
  options: CallSignal;
}

/** Bytes for the next chunk, clamped in bigint so INT64_MAX-style sentinels never pass through Number(). */
function nextChunkEnd(session: UploadSession, total: bigint, layerMaxChunkBytes: bigint): bigint {
  // Zero means "not advertised": fall back to the layer limit before rejecting.
  const sessionMax = session.maxChunkBytes > 0n ? session.maxChunkBytes : layerMaxChunkBytes;
  if (session.nextOffsetBytes < 0n || sessionMax <= 0n) throw new Error("Native upload returned invalid chunk bounds.");
  const limits = [sessionMax, total - session.nextOffsetBytes];
  if (layerMaxChunkBytes > 0n) limits.push(layerMaxChunkBytes);
  return session.nextOffsetBytes + minBigInt(...limits);
}

function uploadMetadata(request: AttachmentAdd | AttachmentUpdate, attachment: Blob, content: Uint8Array<ArrayBuffer>) {
  return {
    name:
      request.name ?? ("name" in attachment && typeof attachment.name === "string" ? attachment.name : "attachment"),
    contentType: request.contentType ?? (attachment.type || "application/octet-stream"),
    sizeBytes: BigInt(content.length),
    idempotencyKey: request.idempotencyKey ?? globalThis.crypto.randomUUID(),
    ...("attachmentId" in request ? { replaceAttachmentId: integerId(request.attachmentId) } : {}),
  };
}

class NativeAttachmentApi implements AttachmentApi {
  private readonly client: HonuaClient;
  private readonly source: NativeAttachmentSource;

  public constructor(source: NativeAttachmentSource) {
    this.source = source;
    this.client = source.client;
  }

  public readonly list = async (parentId: FeatureId, options?: CallSignal): Promise<AttachmentInfo[]> => {
    this.ensure();
    const items: AttachmentInfo[] = [];
    const tokens = new Set<string>();
    let pageToken = "";
    do {
      const request = { parent: this.parent(parentId), pageSize: 100, pageToken };
      const page = await this.client.attachments.list(request, options);
      items.push(...page.attachments.map((item) => attachmentInfo(item, parentId)));
      pageToken = page.nextPageToken;
      if (pageToken && tokens.has(pageToken)) throw new Error("Attachment pagination did not advance.");
      tokens.add(pageToken);
    } while (pageToken);
    return items;
  };

  public readonly query: AttachmentApi["query"] = async (request) => {
    this.ensure();
    if (request?.where)
      throw new TypeError("Native attachment queries require explicit parent IDs; filter text is unsupported.");
    if (!request?.parentIds?.length) throw new TypeError("Native attachment queries require explicit parent IDs.");
    return Promise.all(
      request.parentIds.map(async (parentId) => ({ parentId, attachments: await this.list(parentId, request) })),
    );
  };

  public readonly add = (request: AttachmentAdd): Promise<AttachmentEditOutcome> => this.upload(request);

  public readonly update = (request: AttachmentUpdate): Promise<AttachmentEditOutcome> => this.upload(request);

  public readonly downloadUrl = async (
    parentId: FeatureId,
    attachmentId: FeatureId,
    options?: CallSignal,
  ): Promise<AttachmentDownloadUrl> => {
    this.ensure();
    const request = { parent: this.parent(parentId), attachmentId: integerId(attachmentId) };
    const response = await this.client.attachments.downloadUrl(request, options);
    if (!response.url || !response.attachment) throw new Error("Native download returned no signed URL.");
    return {
      url: response.url,
      expiresAt: new Date(Number(response.expiresAtUtcMs)),
      attachment: attachmentInfo(response.attachment, parentId),
    };
  };

  public readonly delete: AttachmentApi["delete"] = async (request) => {
    this.ensure();
    const key = request.idempotencyKey ?? globalThis.crypto.randomUUID();
    const ids = request.attachmentIds.map(integerId);
    const outcomes: AttachmentEditOutcome[] = [];
    // One outcome per row, like the REST adapter: a failed row does not hide earlier deletes.
    for (const attachmentId of ids) outcomes.push(await this.deleteOne(request, attachmentId, key));
    return outcomes;
  };

  private async deleteOne(
    request: AttachmentDelete,
    attachmentId: bigint,
    key: string,
  ): Promise<AttachmentEditOutcome> {
    const parentId = request.parentId;
    const call = { parent: this.parent(parentId), attachmentId, idempotencyKey: `${key}:${attachmentId}` };
    try {
      const result = await this.client.attachments.delete(call, { signal: request.signal });
      return { parentId, attachmentId: result.attachmentId.toString(), success: true };
    } catch (error) {
      if (request.signal?.aborted || !(error instanceof HonuaGrpcError)) throw error;
      const failure = { code: error.code, description: error.message };
      return { parentId, attachmentId: attachmentId.toString(), success: false, error: failure };
    }
  }

  private async upload(request: AttachmentAdd | AttachmentUpdate): Promise<AttachmentEditOutcome> {
    this.ensure();
    request.signal?.throwIfAborted();
    if (typeof request.attachment === "string") throw new TypeError("Native attachments require a Blob or File.");
    const content = new Uint8Array(await request.attachment.arrayBuffer());
    const metadata = uploadMetadata(request, request.attachment, content);
    const upload = { parent: this.parent(request.parentId), ...metadata, sha256: await digest(content) };
    const options = { signal: request.signal };
    const limits = await this.uploadLimits(request.signal);
    // Zero means "not advertised", never "unlimited": a zero file limit defers the size
    // check to the server, and a zero unary limit sends every upload through a session.
    if (limits.maxFileBytes > 0n && upload.sizeBytes > limits.maxFileBytes)
      throw new RangeError("Attachment exceeds the layer file limit.");
    const unary = limits.maxUnaryUploadBytes > 0n && upload.sizeBytes <= limits.maxUnaryUploadBytes;
    const attachment = unary
      ? (await this.client.attachments.upload({ upload, content }, options)).attachment
      : await this.uploadChunks({ upload, content, layerMaxChunkBytes: limits.maxChunkBytes, options });
    if (!attachment) throw new Error("Native upload returned no committed attachment.");
    return { parentId: request.parentId, attachmentId: attachment.attachmentId.toString(), success: true };
  }

  private async uploadLimits(signal: AbortSignal | undefined) {
    const { serviceId, layerId, descriptor } = this.source;
    const description = await this.client.describeLayer({ serviceId, layerId, signal });
    const limits = description.layer?.attachmentLimits;
    if (!limits) throw new HonuaCapabilityNotSupportedError("attachments", descriptor.protocol, descriptor.id);
    return limits;
  }

  private async uploadChunks(chunked: ChunkedUpload) {
    // An identical retry (same idempotency key) returns the existing session at its
    // committed offset, so transient failures leave the session open for resumption.
    const begun = await this.client.attachments.beginUpload({ upload: chunked.upload }, chunked.options);
    const session = begun.session;
    if (!session) throw new Error("Native upload returned no session.");
    let completed: UploadSession;
    try {
      completed = await this.sendChunks(session, chunked);
    } catch (error) {
      // Only cancellation (including AbortSignal.timeout) discards staging; the server also expires sessions.
      if (chunked.options.signal?.aborted) {
        await this.client.attachments.abortUpload({ sessionId: session.sessionId }).catch(() => undefined);
      }
      throw error;
    }
    // Never abort once commit is sent: it may have landed even if the response is lost.
    const commit = { sessionId: completed.sessionId };
    return (await this.client.attachments.commitUpload(commit, chunked.options)).attachment;
  }

  private async sendChunks(first: UploadSession, chunked: ChunkedUpload): Promise<UploadSession> {
    const { content, layerMaxChunkBytes, options } = chunked;
    const total = BigInt(content.length);
    let session = first;
    while (session.nextOffsetBytes < total) {
      const offset = session.nextOffsetBytes;
      const chunk = content.slice(Number(offset), Number(nextChunkEnd(session, total, layerMaxChunkBytes)));
      const request = {
        sessionId: session.sessionId,
        offsetBytes: offset,
        content: chunk,
        sha256: await digest(chunk),
      };
      const next = (await this.client.attachments.uploadChunk(request, options)).session;
      if (!next || next.sessionId !== session.sessionId || next.nextOffsetBytes !== offset + BigInt(chunk.length))
        throw new Error("Native upload returned an invalid next offset.");
      session = next;
    }
    if (session.nextOffsetBytes !== total) throw new Error("Native upload offset exceeds content length.");
    return session;
  }

  private parent(id: FeatureId) {
    return { serviceId: this.source.serviceId, layerId: this.source.layerId, identity: parentIdentity(id) };
  }

  private ensure(): void {
    const { caps, descriptor } = this.source;
    if (!caps.has("attachments"))
      throw new HonuaCapabilityNotSupportedError("attachments", descriptor.protocol, descriptor.id);
  }
}

export function nativeAttachmentApi(source: NativeAttachmentSource): AttachmentApi {
  return new NativeAttachmentApi(source);
}
