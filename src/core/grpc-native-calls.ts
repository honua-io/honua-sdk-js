import type { Client } from "@connectrpc/connect";
import type { FeatureService } from "../gen/geospatial/v1/feature_service_pb.js";
import { HonuaGrpcError } from "./errors.js";
import type {
  ApplyServiceEditsRequest,
  HonuaApplyServiceEditsResponse,
  HonuaRelatedRecordsResponse,
  QueryRelatedRecordsRequest,
} from "./types.js";

type GrpcAdapterModule = typeof import("./grpc-adapter.js");
type FeatureClient = Client<typeof FeatureService>;

/**
 * FeatureService methods the gRPC retry interceptor may replay. Only reads: every write
 * (edits, service edits, attachment uploads and deletes) runs once, retried only by the
 * caller with an idempotency key, so a lost response can never duplicate rows.
 */
export const REPLAY_SAFE_GRPC_METHODS: ReadonlySet<string> = new Set([
  "DescribeService",
  "DescribeLayer",
  "QueryFeatures",
  "QueryRelatedRecords",
  "ListAttachments",
  "GetAttachmentUrl",
]);

/** Upper bound on QueryRelatedRecords continuation pages for one call. */
export const MAX_RELATED_RECORD_PAGES = 1000;

/** QueryRelatedRecords over gRPC-Web, following page tokens; no REST fallback. */
export async function queryRelatedRecordsOverGrpc(
  adapter: GrpcAdapterModule,
  client: FeatureClient,
  request: QueryRelatedRecordsRequest,
): Promise<HonuaRelatedRecordsResponse> {
  const page = async (pageToken: string) => {
    try {
      return await client.queryRelatedRecords(
        adapter.toProtoRelatedRequest(request, pageToken),
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (error) {
      throw adapter.wrapConnectError(error);
    }
  };
  const pages = [await page("")];
  const seen = new Set<string>();
  let next = pages[0]?.nextPageToken ?? "";
  while (next) {
    if (pages.length >= MAX_RELATED_RECORD_PAGES || seen.has(next)) {
      // A repeated or endless continuation token is a server protocol violation (INTERNAL).
      throw new HonuaGrpcError(
        13,
        `QueryRelatedRecords did not finish within ${MAX_RELATED_RECORD_PAGES} distinct pages.`,
      );
    }
    seen.add(next);
    const response = await page(next);
    pages.push(response);
    next = response.nextPageToken;
  }
  return adapter.fromProtoRelatedPages(pages);
}

/** ApplyServiceEdits over gRPC-Web; no REST fallback and never replayed automatically. */
export async function applyServiceEditsOverGrpc(
  adapter: GrpcAdapterModule,
  client: FeatureClient,
  request: ApplyServiceEditsRequest,
): Promise<HonuaApplyServiceEditsResponse> {
  const protoRequest = adapter.toProtoApplyServiceEditsRequest(request);
  try {
    const response = await client.applyServiceEdits(
      protoRequest,
      request.signal ? { signal: request.signal } : undefined,
    );
    return adapter.fromProtoApplyServiceEditsResponse(response, protoRequest);
  } catch (error) {
    throw adapter.wrapConnectError(error);
  }
}
