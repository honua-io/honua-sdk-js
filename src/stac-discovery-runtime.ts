import { createDiscoveryCacheIdentity, normalizeDiscoveryEndpoint } from "./contract/discovery.js";
import type { CrsDefinition, MetadataProvenance, SpatialExtent, TemporalExtent } from "./contract/schema.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import { classifyStacAsset } from "./stac-discovery-classification.js";
import {
  type ParsedStacDocument,
  assetCrs,
  assetExtensionSnapshot,
  assetExtent,
  assetTemporalExtent,
  optionalText,
  parseProviders,
  parseStacDocument,
  stringArray,
} from "./stac-discovery-normalization.js";
import {
  StacDiscoveryTransport,
  type StacTransportPurpose,
  type StacTransportResponse,
  type StacTransportStatistics,
  normalizeStacDiscoveryLimits,
} from "./stac-discovery-transport.js";
import type {
  DiscoverStaticStacOptions,
  StacAssetCandidate,
  StacDiscoveredDocument,
  StacDiscoveryDiagnostic,
  StacDiscoveryDiagnosticCode,
  StacLicense,
  StacProvider,
  StaticStacDiscoveryResult,
} from "./stac-discovery-types.js";

const STAC_STATIC_ADAPTER_VERSION = "honua-static-stac@1";
const STAC_STATIC_PROJECTION_VERSION = "honua-static-stac-discovery@1";

interface TraversalContext {
  readonly collectionId?: string;
  readonly crs?: CrsDefinition;
  readonly extent?: SpatialExtent;
  readonly temporalExtent?: TemporalExtent;
  readonly license?: StacLicense;
  readonly attribution?: string;
  readonly providers?: readonly StacProvider[];
  readonly provenance?: readonly MetadataProvenance[];
}

interface QueueEntry {
  readonly url: string;
  readonly depth: number;
  readonly context: TraversalContext;
  readonly root: boolean;
}

/**
 * Discover one static STAC Catalog, Collection, or Item and its bounded
 * child/item graph. Traversal is breadth-first and deterministic; unsafe or
 * optional descendants become diagnostics while an invalid root fails closed.
 */
export async function discoverStaticStacRuntime(
  options: DiscoverStaticStacOptions,
): Promise<StaticStacDiscoveryResult> {
  throwIfAborted(options.signal);
  const rootUrl = validateRootUrl(options.endpoint);
  const limits = normalizeStacDiscoveryLimits(options.limits);
  const allowedOrigins = normalizeOrigins(options.allowedOrigins, rootUrl.origin, "allowedOrigins");
  const probeOrigins = normalizeOrigins(options.probeOrigins, rootUrl.origin, "probeOrigins");
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC discovery requires a Fetch implementation.");
  }
  const observedAt = new Date().toISOString();
  const diagnostics: StacDiscoveryDiagnostic[] = [];
  const transportStatistics: StacTransportStatistics = {
    requests: 0,
    redirects: 0,
    bytesRead: 0,
    probeBytesRead: 0,
  };
  const transport = new StacDiscoveryTransport({
    fetchFn,
    rootOrigin: rootUrl.origin,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    limits,
    statistics: transportStatistics,
    assertRedirect: (url, purpose) => assertRequestUrl(url, purpose, allowedOrigins, probeOrigins),
  });
  const cacheIdentity = await createDiscoveryCacheIdentity({
    endpoint: rootUrl,
    protocol: "stac",
    authorizationScopeFingerprint: options.authorizationScopeFingerprint ?? "public",
    adapterVersion: STAC_STATIC_ADAPTER_VERSION,
    projectionVersion: STAC_STATIC_PROJECTION_VERSION,
  });

  const rootRequestUrl = rootUrl.toString();
  const queue: QueueEntry[] = [{ url: rootRequestUrl, depth: 0, context: Object.freeze({}), root: true }];
  const scheduled = new Set([canonicalTraversalUrl(rootUrl)]);
  const completed = new Set<string>();
  const documents: StacDiscoveredDocument[] = [];
  const assets: StacAssetCandidate[] = [];
  let linkLimitReported = false;
  let documentLimitReported = false;
  let assetLimitReported = false;

  while (queue.length > 0) {
    throwIfAborted(options.signal);
    const entry = queue.shift()!;
    let response: StacTransportResponse;
    let parsed: ParsedStacDocument;
    let documentUrl: string;
    try {
      response = await transport.document(entry.url);
      const finalUrl = new URL(response.url);
      assertRequestUrl(finalUrl, "document", allowedOrigins, probeOrigins);
      documentUrl = canonicalTraversalUrl(finalUrl);
      if (completed.has(documentUrl)) {
        diagnostics.push(diagnostic("link-loop", "info", "A redirect resolved to an already visited STAC document."));
        continue;
      }
      parsed = parseStacDocument(response, normalizeDiscoveryEndpoint(finalUrl), observedAt);
    } catch (cause) {
      if (cause instanceof HonuaAbortError) throw cause;
      if (entry.root) throw cause;
      diagnostics.push(
        diagnostic(
          cause instanceof HonuaDiscoveryError ? "document-invalid" : "document-unreadable",
          "warning",
          cause instanceof HonuaDiscoveryError
            ? "A linked STAC document was invalid and was not traversed."
            : "A linked STAC document could not be read and was not traversed.",
        ),
      );
      continue;
    }
    completed.add(documentUrl);

    const effective = effectiveContext(parsed, entry.context);
    const documentProvenance = mergeProvenance(entry.context.provenance, parsed.provenance);
    const documentAssets: StacAssetCandidate[] = [];
    for (const key of Object.keys(parsed.assets)) {
      if (assets.length >= limits.maxAssets) {
        if (!assetLimitReported) {
          diagnostics.push(
            diagnostic("asset-limit", "warning", "Static STAC discovery reached its total asset limit."),
          );
          assetLimitReported = true;
        }
        break;
      }
      const rawAsset = parsed.assets[key]!;
      const candidate = await normalizeAsset({
        rawAsset,
        key,
        parsed,
        documentUrl,
        context: effective,
        provenance: documentProvenance,
        transport,
        probeAssets: options.probeAssets !== false,
        probeOrigins,
        diagnostics,
      });
      if (!candidate) continue;
      documentAssets.push(candidate);
      assets.push(candidate);
    }

    const document = Object.freeze({
      documentType: parsed.documentType,
      id: parsed.id,
      url: normalizeDiscoveryEndpoint(documentUrl),
      stacVersion: parsed.stacVersion,
      ...(effective.collectionId ? { collectionId: effective.collectionId } : {}),
      ...(parsed.title ? { title: parsed.title } : {}),
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.crs ? { crs: parsed.crs } : {}),
      extent: parsed.extent,
      temporalExtent: parsed.temporalExtent,
      ...(effective.license ? { license: effective.license } : {}),
      ...(effective.attribution ? { attribution: effective.attribution } : {}),
      providers: Object.freeze(effective.providers ?? []),
      stacExtensions: parsed.stacExtensions,
      provenance: documentProvenance,
      assets: Object.freeze(documentAssets),
    }) satisfies StacDiscoveredDocument;
    documents.push(document);

    const childContext = traversalContext(parsed, effective, documentProvenance);
    const relevant = parsed.links
      .filter((link) => link.rel === "child" || link.rel === "item")
      .sort((left, right) => compareText(`${left.rel}\u0000${left.href}`, `${right.rel}\u0000${right.href}`));
    if (relevant.length > limits.maxLinksPerDocument && !linkLimitReported) {
      diagnostics.push(
        diagnostic(
          "link-limit",
          "warning",
          "A STAC document exceeded the per-document relevant-link limit; excess links were ignored.",
          parsed.id,
        ),
      );
      linkLimitReported = true;
    }
    for (const link of relevant.slice(0, limits.maxLinksPerDocument)) {
      if (!isJsonLinkMediaType(link.mediaType)) {
        diagnostics.push(
          diagnostic(
            "unsupported-link-media-type",
            "info",
            "A relevant STAC link explicitly declared a non-JSON representation and was ignored.",
            parsed.id,
            undefined,
            link.rel,
          ),
        );
        continue;
      }
      if (entry.depth >= limits.maxDepth) {
        diagnostics.push(
          diagnostic(
            "depth-limit",
            "warning",
            "A relevant STAC link exceeded the traversal depth limit and was ignored.",
            parsed.id,
            undefined,
            link.rel,
          ),
        );
        continue;
      }
      let target: URL;
      try {
        target = resolveTraversalLink(link.href, documentUrl);
        assertRequestUrl(target, "document", allowedOrigins, probeOrigins);
      } catch (cause) {
        diagnostics.push(
          diagnostic(
            cause instanceof CrossOriginUrlError ? "cross-origin-link" : "unsafe-url",
            "warning",
            cause instanceof CrossOriginUrlError
              ? "A cross-origin STAC link was not authorized for traversal."
              : "An unsafe STAC traversal link was ignored.",
            parsed.id,
            undefined,
            link.rel,
          ),
        );
        continue;
      }
      const targetKey = canonicalTraversalUrl(target);
      if (scheduled.has(targetKey) || completed.has(targetKey)) {
        diagnostics.push(
          diagnostic(
            "link-loop",
            "info",
            "A repeated or cyclic STAC link was ignored.",
            parsed.id,
            undefined,
            link.rel,
          ),
        );
        continue;
      }
      if (scheduled.size >= limits.maxDocuments) {
        if (!documentLimitReported) {
          diagnostics.push(
            diagnostic("document-limit", "warning", "Static STAC discovery reached its document limit."),
          );
          documentLimitReported = true;
        }
        continue;
      }
      scheduled.add(targetKey);
      queue.push({ url: target.toString(), depth: entry.depth + 1, context: childContext, root: false });
    }
  }

  const root = documents[0];
  if (!root) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC discovery produced no root document.");
  }
  return Object.freeze({
    root,
    documents: Object.freeze(documents),
    assets: Object.freeze(assets),
    diagnostics: Object.freeze(diagnostics),
    cacheIdentity,
    retrievedAt: observedAt,
    statistics: Object.freeze({
      documentsRead: documents.length,
      assetsRead: assets.length,
      requests: transportStatistics.requests,
      redirects: transportStatistics.redirects,
      bytesRead: transportStatistics.bytesRead,
      probeBytesRead: transportStatistics.probeBytesRead,
    }),
  });
}

async function normalizeAsset(input: {
  readonly rawAsset: Readonly<Record<string, unknown>>;
  readonly key: string;
  readonly parsed: ParsedStacDocument;
  readonly documentUrl: string;
  readonly context: TraversalContext;
  readonly provenance: readonly MetadataProvenance[];
  readonly transport: StacDiscoveryTransport;
  readonly probeAssets: boolean;
  readonly probeOrigins: ReadonlySet<string>;
  readonly diagnostics: StacDiscoveryDiagnostic[];
}): Promise<StacAssetCandidate | undefined> {
  const hrefValue = input.rawAsset.href;
  if (typeof hrefValue !== "string" || !hrefValue.trim() || hrefValue.length > 16_384) {
    input.diagnostics.push(
      diagnostic(
        "asset-invalid",
        "warning",
        "A STAC asset without a valid href was ignored.",
        input.parsed.id,
        input.key,
      ),
    );
    return undefined;
  }
  let rawUrl: string;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(hrefValue, input.documentUrl);
    if (
      (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.hash
    ) {
      throw new Error("unsafe");
    }
    rawUrl = restoreTileTokens(parsedUrl.toString());
  } catch {
    input.diagnostics.push(
      diagnostic("unsafe-url", "warning", "An unsafe STAC asset URL was ignored.", input.parsed.id, input.key),
    );
    return undefined;
  }
  const direct = parsedUrl.search.length === 0;
  const safeHref = normalizeDiscoveryEndpoint(parsedUrl);
  const roles = stringArray(input.rawAsset.roles);
  const mediaType = optionalText(input.rawAsset.type, "STAC asset media type", 512);
  const probeAllowed = input.probeOrigins.has(parsedUrl.origin);
  const classified = await classifyStacAsset({
    asset: input.rawAsset,
    rawUrl,
    direct,
    roles,
    ...(mediaType ? { mediaType } : {}),
    transport: input.transport,
    probe: input.probeAssets,
    probeAllowed,
  });
  if (classified.probeStatus === "skipped") {
    input.diagnostics.push(
      diagnostic(
        "asset-probe-skipped",
        "info",
        "A bounded asset probe was skipped by URL or caller policy.",
        input.parsed.id,
        input.key,
      ),
    );
  } else if (classified.probeStatus === "failed") {
    input.diagnostics.push(
      diagnostic(
        "asset-probe-failed",
        "warning",
        "A bounded asset probe did not produce validating evidence.",
        input.parsed.id,
        input.key,
      ),
    );
  }
  if (classified.classification.state === "ambiguous") {
    input.diagnostics.push(
      diagnostic(
        "asset-ambiguous",
        "warning",
        "A STAC asset has ambiguous or conflicting format evidence.",
        input.parsed.id,
        input.key,
      ),
    );
  } else if (classified.classification.state === "unsupported") {
    input.diagnostics.push(
      diagnostic(
        "asset-unsupported",
        "info",
        "A STAC asset has no reviewed supported-format evidence.",
        input.parsed.id,
        input.key,
      ),
    );
  }

  const assetProvenance = input.provenance;
  const crs = assetCrs(input.rawAsset, input.parsed.properties, input.parsed.crs ?? input.context.crs);
  const fallbackExtent =
    input.parsed.extent.state === "known" || input.parsed.extent.state === "empty"
      ? input.parsed.extent
      : (input.context.extent ?? input.parsed.extent);
  const fallbackTemporal =
    input.parsed.temporalExtent.state === "known" || input.parsed.temporalExtent.state === "empty"
      ? input.parsed.temporalExtent
      : (input.context.temporalExtent ?? input.parsed.temporalExtent);
  const extent = assetExtent(input.rawAsset, crs, fallbackExtent, assetProvenance);
  const temporalExtent = assetTemporalExtent(input.rawAsset, fallbackTemporal, assetProvenance);
  const providers = parseProviders(input.rawAsset.providers);
  const effectiveProviders = providers.length > 0 ? providers : (input.context.providers ?? []);
  const assetLicense = assetLicenseValue(input.rawAsset.license, input.context.license);
  const attribution =
    optionalText(input.rawAsset.attribution, "STAC asset attribution", 8_192) ?? input.context.attribution;
  const collectionId = input.parsed.collectionId ?? input.context.collectionId;
  const identity = [collectionId, input.parsed.id === collectionId ? undefined : input.parsed.id, input.key]
    .filter((value): value is string => value !== undefined)
    .map(encodeURIComponent)
    .join("/");
  return Object.freeze({
    id: identity,
    documentId: input.parsed.id,
    ...(collectionId ? { collectionId } : {}),
    ...(input.parsed.documentType === "item" ? { itemId: input.parsed.id } : {}),
    key: input.key,
    href: safeHref,
    access: direct ? "direct" : "resolver-required",
    ...(optionalText(input.rawAsset.title, "STAC asset title", 8_192) ? { title: String(input.rawAsset.title) } : {}),
    ...(optionalText(input.rawAsset.description, "STAC asset description", 64 * 1024)
      ? { description: String(input.rawAsset.description) }
      : {}),
    ...(mediaType ? { mediaType } : {}),
    roles,
    classification: classified.classification,
    ...(classified.source ? { source: classified.source } : {}),
    ...(crs ? { crs } : {}),
    extent,
    temporalExtent,
    ...(assetLicense ? { license: assetLicense } : {}),
    ...(attribution ? { attribution } : {}),
    providers: Object.freeze(effectiveProviders),
    provenance: assetProvenance,
    extensions: assetExtensionSnapshot(input.rawAsset),
  });
}

function validateRootUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input.toString());
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC endpoint must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC endpoint must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Static STAC endpoint must not contain user-info, query parameters, or a fragment; resolve credentials at request time.",
    );
  }
  return url;
}

function normalizeOrigins(
  values: readonly string[] | undefined,
  rootOrigin: string,
  label: "allowedOrigins" | "probeOrigins",
): ReadonlySet<string> {
  const origins = new Set([rootOrigin]);
  for (const value of values ?? []) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HonuaDiscoveryError("invalid-endpoint", `Static STAC ${label} must contain absolute origins.`);
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.origin !== value.replace(/\/$/, "") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new HonuaDiscoveryError("invalid-endpoint", `Static STAC ${label} must contain bare HTTP(S) origins.`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function assertRequestUrl(
  url: URL,
  purpose: StacTransportPurpose,
  allowedOrigins: ReadonlySet<string>,
  probeOrigins: ReadonlySet<string>,
): void {
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash ||
    (purpose === "document" && url.search)
  ) {
    throw new UnsafeUrlError();
  }
  const origins = purpose === "document" ? allowedOrigins : probeOrigins;
  if (!origins.has(url.origin)) throw new CrossOriginUrlError();
}

function resolveTraversalLink(href: string, base: string): URL {
  const url = new URL(href, base);
  if (url.search || url.hash || url.username || url.password) throw new UnsafeUrlError();
  return url;
}

function canonicalTraversalUrl(url: URL): string {
  const canonical = new URL(url);
  canonical.hash = "";
  while (canonical.pathname.length > 1 && canonical.pathname.endsWith("/")) {
    canonical.pathname = canonical.pathname.slice(0, -1);
  }
  return canonical.toString();
}

function effectiveContext(parsed: ParsedStacDocument, inherited: TraversalContext): TraversalContext {
  const collectionId = parsed.collectionId ?? inherited.collectionId;
  return Object.freeze({
    ...(collectionId ? { collectionId } : {}),
    ...((parsed.crs ?? inherited.crs) ? { crs: parsed.crs ?? inherited.crs } : {}),
    ...(parsed.extent.state === "known" || parsed.extent.state === "empty"
      ? { extent: parsed.extent }
      : inherited.extent
        ? { extent: inherited.extent }
        : {}),
    ...(parsed.temporalExtent.state === "known" || parsed.temporalExtent.state === "empty"
      ? { temporalExtent: parsed.temporalExtent }
      : inherited.temporalExtent
        ? { temporalExtent: inherited.temporalExtent }
        : {}),
    ...((parsed.license ?? inherited.license) ? { license: parsed.license ?? inherited.license } : {}),
    ...((parsed.attribution ?? inherited.attribution)
      ? { attribution: parsed.attribution ?? inherited.attribution }
      : {}),
    providers: parsed.providers.length > 0 ? parsed.providers : (inherited.providers ?? Object.freeze([])),
  });
}

function traversalContext(
  parsed: ParsedStacDocument,
  effective: TraversalContext,
  provenance: readonly MetadataProvenance[],
): TraversalContext {
  return Object.freeze({
    ...effective,
    provenance,
    ...(parsed.documentType === "collection" ? { collectionId: parsed.id } : {}),
  });
}

function mergeProvenance(
  inherited: readonly MetadataProvenance[] | undefined,
  own: readonly MetadataProvenance[],
): readonly MetadataProvenance[] {
  // Keep the document or asset observation first so consumers can inspect the
  // most specific source without walking through ancestor catalog records.
  const merged = [...own, ...(inherited ?? [])];
  const seen = new Set<string>();
  return Object.freeze(
    merged.filter((entry) => {
      const key = `${entry.method}\u0000${entry.source}\u0000${entry.observedAt ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

function assetLicenseValue(value: unknown, fallback: StacLicense | undefined): StacLicense | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) return fallback;
  return Object.freeze({ expression: value, links: Object.freeze([]) });
}

function isJsonLinkMediaType(value: string | undefined): boolean {
  if (!value) return true;
  const type = value.split(";", 1)[0]?.trim().toLowerCase();
  return type === "application/json" || type === "application/geo+json" || Boolean(type?.endsWith("+json"));
}

function restoreTileTokens(value: string): string {
  return value.replaceAll(/%7B([zxy])%7D/gi, (_match, token: string) => `{${token.toLowerCase()}}`);
}

function diagnostic(
  code: StacDiscoveryDiagnosticCode,
  severity: StacDiscoveryDiagnostic["severity"],
  message: string,
  documentId?: string,
  assetKey?: string,
  relation?: string,
): StacDiscoveryDiagnostic {
  return Object.freeze({
    code,
    severity,
    message,
    ...(documentId ? { documentId } : {}),
    ...(assetKey ? { assetKey } : {}),
    ...(relation ? { relation } : {}),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}

class UnsafeUrlError extends Error {}
class CrossOriginUrlError extends Error {}
