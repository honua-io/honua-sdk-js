import type {
  OfflineRegionFetchHandler,
  OfflineRegionFetchHandlerOptions,
  OfflineRegionResourceRead,
} from "./types.js";

/**
 * Creates a storage-backed fetch handler for service workers and fetch-event
 * integrations. The host owns URL matching; the SDK only turns a matched,
 * credential-free resource identity into a response.
 *
 * A miss, unsupported method, or expired region returns `undefined`, allowing
 * the host to continue its normal network fallback. Storage failures are
 * propagated so a host can distinguish them from an ordinary cache miss.
 */
export function createOfflineRegionFetchHandler(options: OfflineRegionFetchHandlerOptions): OfflineRegionFetchHandler {
  if (!options.store) throw new TypeError("An offline region store is required.");
  if (typeof options.regionId !== "string" || options.regionId.length === 0)
    throw new TypeError("regionId must be non-empty.");
  if (typeof options.match !== "function") throw new TypeError("A request matcher is required.");

  const now = options.now ?? (() => new Date());
  return async (request) => {
    if (!(request instanceof Request)) throw new TypeError("request must be a Request.");
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    const resourceId = await options.match(request);
    if (resourceId === undefined) return undefined;
    if (typeof resourceId !== "string" || resourceId.length === 0)
      throw new TypeError("The request matcher returned an invalid resource ID.");

    const read = await options.store.readResource(options.regionId, resourceId);
    if (!read || isExpired(read, now())) return undefined;
    return toResponse(read, request.method === "HEAD");
  };
}

function toResponse(read: OfflineRegionResourceRead, head: boolean): Response {
  const headers = new Headers({
    "content-length": String(read.bytes.byteLength),
    "x-honua-offline-region": read.regionId,
    "x-honua-offline-state": read.manifest.source.observation.state,
    "x-honua-offline-observed-at": read.manifest.source.observation.observedAt,
  });
  setHeaderIfValid(headers, "x-honua-offline-source-version", read.resource.sourceVersion);
  setHeaderIfValid(headers, "x-honua-offline-schema-version", read.resource.schemaVersion);
  setHeaderIfValid(headers, "x-honua-offline-plan-version", read.resource.planVersion);
  if (read.resource.contentType) headers.set("content-type", read.resource.contentType);
  if (read.manifest.expiresAt) headers.set("x-honua-offline-expires-at", read.manifest.expiresAt);
  return new Response(head ? null : Uint8Array.from(read.bytes), { status: 200, headers });
}

function setHeaderIfValid(headers: Headers, name: string, value: string): void {
  if (
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint <= 0xff && codePoint !== 0x7f;
    })
  ) {
    headers.set(name, value);
  }
}

function isExpired(read: OfflineRegionResourceRead, now: Date): boolean {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date.");
  if (!read.manifest.expiresAt) return false;
  const expiresAt = Date.parse(read.manifest.expiresAt);
  return !Number.isFinite(expiresAt) || now.getTime() >= expiresAt;
}
