/** Bounded static-STAC traversal and evidence-based asset classification for connect(). */

import type { ConnectDiscoveryExtent, ConnectDiscoverySourceSnapshot } from "./connect.js";
import type { DiscoveryCapabilityEvidence, DiscoveryProvenance } from "./contract/discovery.js";
import type { Protocol, SourceLocator } from "./contract/types.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import { honuaMetadataRequestHeaders } from "./core/cache-state.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";

const DEFAULT_MAX_DOCUMENTS = 32;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_LINKS_PER_DOCUMENT = 64;
const DEFAULT_MAX_ASSETS = 256;
const DEFAULT_MAX_ASSET_PROBES = 8;
const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;

const HARD_MAX_DOCUMENTS = 64;
const HARD_MAX_DEPTH = 8;
const HARD_MAX_LINKS_PER_DOCUMENT = 128;
const HARD_MAX_ASSETS = 1024;
const HARD_MAX_ASSET_PROBES = 16;
const HARD_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const STAC_SOURCE_CAPABILITIES = Object.freeze(["query", "queryObjectIds", "stream"] as const);
const STATIC_DOCUMENT_MEDIA_TYPES = new Set(["application/json", "application/geo+json"]);
const METADATA_MEDIA_TYPES = new Set([
  "application/json",
  "application/geo+json",
  "application/xml",
  "text/xml",
  "text/plain",
]);
const RASTER_TILE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);
const VECTOR_TILE_MEDIA_TYPES = new Set([
  "application/vnd.mapbox-vector-tile",
  "application/x-protobuf",
  "application/vnd.mapbox-vector-tile;encoding=mvt",
]);

export type StacStaticObjectType = "catalog" | "collection" | "item";
export type StacAssetCandidateState = "classified" | "ambiguous" | "unsupported";
export type StacAssetKind = "cog" | "geoparquet" | "pmtiles" | "tile" | "metadata";
export type StacAssetConfidence = "high" | "medium" | "low" | "none";

export interface StacStaticTraversalOptions {
  readonly maxDocuments?: number;
  readonly maxDepth?: number;
  readonly maxLinksPerDocument?: number;
  readonly maxAssets?: number;
  readonly maxAssetProbes?: number;
  readonly maxDocumentBytes?: number;
}

export interface StacStaticTraversalPolicy {
  readonly maxDocuments: number;
  readonly maxDepth: number;
  readonly maxLinksPerDocument: number;
  readonly maxAssets: number;
  readonly maxAssetProbes: number;
  readonly maxDocumentBytes: number;
}

export interface StacAssetClassificationEvidence {
  readonly kind: "media-type" | "role" | "extension" | "asset-field" | "probe" | "url-policy";
  readonly value: string;
  readonly supports?: readonly StacAssetKind[];
}

export interface StacAssetSourceCandidate {
  readonly protocol: Extract<Protocol, "pmtiles" | "geoparquet" | "maplibre-vector" | "maplibre-raster">;
  readonly locator: SourceLocator;
}

export interface StacAssetCandidateMetadata {
  readonly crs?: readonly string[];
  readonly extent?: ConnectDiscoveryExtent;
  readonly license?: string;
  readonly attribution?: string;
  readonly datetime?: string;
  readonly startDatetime?: string;
  readonly endDatetime?: string;
}

export interface StacAssetCandidate {
  readonly id: string;
  readonly state: StacAssetCandidateState;
  readonly kind?: StacAssetKind;
  readonly confidence: StacAssetConfidence;
  readonly documentUrl: string;
  readonly objectType: StacStaticObjectType;
  readonly objectId: string;
  readonly collectionId?: string;
  readonly itemId?: string;
  readonly assetKey: string;
  /** Credential-free HTTP(S) asset URL. Unsafe URLs are redacted and omitted. */
  readonly href?: string;
  readonly mediaType?: string;
  readonly roles: readonly string[];
  /** Present only when the classification maps honestly onto an existing adapter/runtime locator. */
  readonly source?: StacAssetSourceCandidate;
  readonly metadata: StacAssetCandidateMetadata;
  readonly evidence: readonly StacAssetClassificationEvidence[];
  readonly provenance: readonly DiscoveryProvenance[];
}

export interface StacStaticObjectSummary {
  readonly url: string;
  readonly type: StacStaticObjectType;
  readonly id: string;
  readonly stacVersion: string;
  readonly contentDigest: `sha256:${string}`;
  readonly validator?: string;
  readonly title?: string;
  readonly description?: string;
  readonly collectionId?: string;
  readonly metadata: StacAssetCandidateMetadata;
  readonly provenance: readonly DiscoveryProvenance[];
}

export type StacStaticDiagnosticCode =
  | "unsafe-link-skipped"
  | "cross-origin-link-skipped"
  | "non-json-link-skipped"
  | "malformed-link-skipped"
  | "linked-document-unavailable"
  | "linked-document-invalid"
  | "document-limit-reached"
  | "depth-limit-reached"
  | "link-limit-reached"
  | "asset-limit-reached";

export interface StacStaticDiagnostic {
  readonly code: StacStaticDiagnosticCode;
  readonly severity: "warning";
  readonly documentUrl: string;
  readonly rel?: string;
  readonly message: string;
}

export interface StacStaticDiscoveryInspection {
  readonly policy: StacStaticTraversalPolicy;
  /** Original endpoint whose same-origin response produced `root`. */
  readonly rootRequestUrl: string;
  readonly root: StacStaticObjectSummary;
  readonly documents: readonly StacStaticObjectSummary[];
  readonly assetCandidates: readonly StacAssetCandidate[];
  readonly diagnostics: readonly StacStaticDiagnostic[];
  /** Digest over sorted URL/version/validator/content bindings for the complete bounded tree. */
  readonly treeFingerprint: `sha256:${string}`;
}

export interface StacStaticDiscoveryOptions {
  readonly signal?: AbortSignal;
  readonly refresh?: boolean;
  readonly metadata?: Omit<HonuaMetadataRequestOptions, "signal" | "refresh">;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly policy: StacStaticTraversalPolicy;
  readonly collectionId?: string;
}

export interface StacStaticDiscoveryResult {
  readonly source: ConnectDiscoverySourceSnapshot;
  readonly inspection: StacStaticDiscoveryInspection;
}

export interface StacRootDocumentResponse {
  readonly value: unknown;
  readonly requestUrl: string;
  readonly url: string;
  readonly validator?: string;
}

interface ParsedStaticDocument {
  readonly raw: Record<string, unknown>;
  readonly url: string;
  readonly type: StacStaticObjectType;
  readonly id: string;
  readonly stacVersion: string;
  readonly title?: string;
  readonly description?: string;
  readonly collectionId?: string;
  readonly links: readonly unknown[];
  readonly assets: Readonly<Record<string, unknown>>;
  readonly extensions: readonly string[];
  readonly metadata: StacAssetCandidateMetadata;
  readonly validator?: string;
  readonly retrievedAt: string;
  readonly contentDigest: `sha256:${string}`;
}

interface QueuedDocument {
  readonly url: string;
  readonly depth: number;
  readonly expand: boolean;
  readonly raw?: unknown;
  readonly validator?: string;
  readonly parentUrl?: string;
  readonly rel?: string;
}

interface PendingAsset {
  readonly document: ParsedStaticDocument;
  readonly assetKey: string;
  readonly asset: Record<string, unknown>;
}

interface AssetProbe {
  readonly attempted: boolean;
  readonly contentType?: string;
  readonly unavailable?: "cross-origin" | "policy-limit" | "request-failed";
}

interface MediaSignal {
  readonly kind?: StacAssetKind;
  readonly tileProtocol?: "maplibre-vector" | "maplibre-raster";
  readonly confidence: StacAssetConfidence;
  readonly ambiguous?: boolean;
}

export function normalizeStacStaticTraversalPolicy(
  options: StacStaticTraversalOptions = {},
): StacStaticTraversalPolicy {
  return Object.freeze({
    maxDocuments: boundedOption(options.maxDocuments, DEFAULT_MAX_DOCUMENTS, HARD_MAX_DOCUMENTS, "maxDocuments"),
    maxDepth: boundedOption(options.maxDepth, DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH, "maxDepth"),
    maxLinksPerDocument: boundedOption(
      options.maxLinksPerDocument,
      DEFAULT_MAX_LINKS_PER_DOCUMENT,
      HARD_MAX_LINKS_PER_DOCUMENT,
      "maxLinksPerDocument",
    ),
    maxAssets: boundedOption(options.maxAssets, DEFAULT_MAX_ASSETS, HARD_MAX_ASSETS, "maxAssets"),
    maxAssetProbes: boundedOption(
      options.maxAssetProbes,
      DEFAULT_MAX_ASSET_PROBES,
      HARD_MAX_ASSET_PROBES,
      "maxAssetProbes",
      true,
    ),
    maxDocumentBytes: boundedOption(
      options.maxDocumentBytes,
      DEFAULT_MAX_DOCUMENT_BYTES,
      HARD_MAX_DOCUMENT_BYTES,
      "maxDocumentBytes",
    ),
  });
}

export function stacStaticTraversalPolicyIdentity(policy: StacStaticTraversalPolicy): string {
  return `stac-static-policy:v1:${JSON.stringify(policy)}`;
}

/** `conformsTo` is intentionally authoritative and keeps API landing pages off the static path. */
export function isStaticStacDocument(value: unknown): boolean {
  if (!isPlainObject(value) || Object.hasOwn(value, "conformsTo")) return false;
  return (
    typeof value.stac_version === "string" &&
    (value.type === "Catalog" || value.type === "Collection" || value.type === "Feature")
  );
}

/** Fetch the ambiguous STAC root through the same bounded raw-response path used for linked objects. */
export async function fetchStacRootDocument(
  client: HonuaClient,
  endpoint: string,
  options: StacStaticDiscoveryOptions,
): Promise<StacRootDocumentResponse> {
  const requestUrl = canonicalDocumentUrl(endpoint, endpoint);
  const fetched = await fetchStaticDocument(client, requestUrl, options);
  return Object.freeze({ ...fetched, requestUrl });
}

export async function discoverStaticStac(
  client: HonuaClient,
  endpoint: string,
  rootResponse: StacRootDocumentResponse,
  options: StacStaticDiscoveryOptions,
): Promise<StacStaticDiscoveryResult> {
  throwIfAborted(options.signal);
  const rootRequestUrl = canonicalDocumentUrl(endpoint, endpoint);
  if (rootResponse.requestUrl !== rootRequestUrl) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Static STAC root response is not bound to the requested endpoint.",
    );
  }
  const rootUrl = canonicalDocumentUrl(rootResponse.url, rootRequestUrl);
  if (new URL(rootUrl).origin !== new URL(rootRequestUrl).origin) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC root redirect left the connected origin.");
  }
  const queue: QueuedDocument[] = [
    {
      url: rootUrl,
      depth: 0,
      expand: true,
      raw: rootResponse.value,
      ...(rootResponse.validator ? { validator: rootResponse.validator } : {}),
    },
  ];
  const visited = new Set<string>();
  const completedUrls = new Set<string>();
  const documents: ParsedStaticDocument[] = [];
  const pendingAssets: PendingAsset[] = [];
  const diagnostics: StacStaticDiagnostic[] = [];
  let documentLimitReported = false;
  let assetLimitReported = false;
  let documentAttempts = 0;

  while (queue.length > 0) {
    throwIfAborted(options.signal);
    const next = queue.shift()!;
    if (visited.has(next.url)) continue;
    if (documentAttempts >= options.policy.maxDocuments) {
      if (!documentLimitReported) {
        diagnostics.push(
          diagnostic(
            "document-limit-reached",
            documents.at(-1)?.url ?? rootUrl,
            `Static STAC traversal stopped at ${options.policy.maxDocuments} documents.`,
          ),
        );
        documentLimitReported = true;
      }
      break;
    }
    visited.add(next.url);
    documentAttempts += 1;

    let raw: unknown;
    let responseValidator = next.validator;
    let finalUrl = next.url;
    try {
      if (next.raw !== undefined) {
        raw = next.raw;
      } else {
        const fetched = await fetchStaticDocument(client, next.url, options);
        raw = fetched.value;
        responseValidator = fetched.validator;
        finalUrl = fetched.url;
        visited.add(finalUrl);
      }
    } catch (cause) {
      if (options.signal?.aborted || cause instanceof HonuaAbortError) throw new HonuaAbortError();
      diagnostics.push(
        diagnostic(
          "linked-document-unavailable",
          next.parentUrl ?? documents.at(-1)?.url ?? rootUrl,
          "A linked static STAC document was unavailable and was skipped.",
          next.rel,
        ),
      );
      continue;
    }

    if (completedUrls.has(finalUrl)) continue;

    let document: ParsedStaticDocument;
    try {
      document = await parseStaticDocument(raw, finalUrl, responseValidator);
    } catch (cause) {
      if (next.depth === 0) throw cause;
      diagnostics.push(
        diagnostic(
          "linked-document-invalid",
          next.parentUrl ?? documents.at(-1)?.url ?? rootUrl,
          "A linked document was not a valid bounded STAC object.",
          next.rel,
        ),
      );
      continue;
    }
    completedUrls.add(finalUrl);
    documents.push(document);

    for (const [assetKey, assetValue] of Object.entries(document.assets)) {
      if (pendingAssets.length >= options.policy.maxAssets) {
        if (!assetLimitReported) {
          diagnostics.push(
            diagnostic(
              "asset-limit-reached",
              document.url,
              `Static STAC asset discovery stopped at ${options.policy.maxAssets} assets.`,
            ),
          );
          assetLimitReported = true;
        }
        break;
      }
      if (!isPlainObject(assetValue)) {
        pendingAssets.push({ document, assetKey, asset: Object.create(null) as Record<string, unknown> });
      } else {
        pendingAssets.push({ document, assetKey, asset: assetValue });
      }
    }

    if (!next.expand) continue;
    const links = document.links;
    if (links.length > options.policy.maxLinksPerDocument) {
      diagnostics.push(
        diagnostic(
          "link-limit-reached",
          document.url,
          `Only the first ${options.policy.maxLinksPerDocument} links were considered.`,
        ),
      );
    }
    for (const linkValue of links.slice(0, options.policy.maxLinksPerDocument)) {
      const link = relevantLink(linkValue, document.type);
      if (!link.relevant) continue;
      if (!link.href) {
        diagnostics.push(
          diagnostic("malformed-link-skipped", document.url, "A relevant STAC link had no usable href.", link.rel),
        );
        continue;
      }
      if (link.mediaType && !STATIC_DOCUMENT_MEDIA_TYPES.has(mediaEssence(link.mediaType))) {
        diagnostics.push(
          diagnostic(
            "non-json-link-skipped",
            document.url,
            "A relevant link advertised a non-STAC media type and was skipped.",
            link.rel,
          ),
        );
        continue;
      }
      if (next.depth >= options.policy.maxDepth) {
        diagnostics.push(
          diagnostic(
            "depth-limit-reached",
            document.url,
            `Static STAC traversal stopped at depth ${options.policy.maxDepth}.`,
            link.rel,
          ),
        );
        continue;
      }
      const resolved = traversalLinkUrl(link.href, document.url, rootUrl);
      if (resolved.state !== "safe") {
        diagnostics.push(
          diagnostic(
            resolved.state === "cross-origin" ? "cross-origin-link-skipped" : "unsafe-link-skipped",
            document.url,
            resolved.state === "cross-origin"
              ? "A cross-origin STAC traversal link was preserved as metadata but not fetched with root credentials."
              : "A credential-bearing or non-HTTP STAC traversal link was skipped.",
            link.rel,
          ),
        );
        continue;
      }
      if (!visited.has(resolved.url)) {
        queue.push({
          url: resolved.url,
          depth: next.depth + 1,
          // A collection reached from an Item enriches inheritance but does not
          // turn a single-Item connection into a crawl of the whole collection.
          expand: link.rel !== "collection",
          parentUrl: document.url,
          ...(link.rel ? { rel: link.rel } : {}),
        });
      }
    }
  }

  const root = documents[0];
  if (!root) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC discovery returned no valid root object.");
  }
  const collectionById = new Map(
    documents.filter((document) => document.type === "collection").map((document) => [document.id, document]),
  );
  const sourceObject = options.collectionId ? collectionById.get(options.collectionId) : root;
  if (!sourceObject) {
    throw new HonuaDiscoveryError(
      "ambiguous-source",
      `Collection "${options.collectionId}" was not found in the bounded static STAC traversal.`,
      { collectionId: options.collectionId, sourceIds: [...collectionById.keys()] },
    );
  }
  const candidates: StacAssetCandidate[] = [];
  let probes = 0;
  for (const pending of pendingAssets) {
    throwIfAborted(options.signal);
    const href = resolveAssetUrl(pending.asset.href, pending.document.url);
    let probe: AssetProbe = { attempted: false };
    if (href.state === "safe") {
      if (new URL(href.url).origin !== new URL(rootUrl).origin) {
        probe = { attempted: false, unavailable: "cross-origin" };
      } else if (probes < options.policy.maxAssetProbes) {
        probes += 1;
        probe = await probeAsset(client, href.url, options.signal);
      } else {
        probe = { attempted: false, unavailable: "policy-limit" };
      }
    }
    const inheritedCollection = pending.document.collectionId
      ? collectionById.get(pending.document.collectionId)
      : pending.document.type === "collection"
        ? pending.document
        : undefined;
    candidates.push(classifyAsset(pending, href, probe, inheritedCollection));
  }

  const summaries = Object.freeze(documents.map(summarizeDocument));
  const immutableCandidates = Object.freeze(candidates);
  const treeFingerprint = await treeDigest(summaries, immutableCandidates);
  const inspection: StacStaticDiscoveryInspection = Object.freeze({
    policy: options.policy,
    rootRequestUrl,
    root: summaries[0]!,
    documents: summaries,
    assetCandidates: immutableCandidates,
    diagnostics: Object.freeze(diagnostics),
    treeFingerprint,
  });
  const provenance = Object.freeze(documents.map((document) => documentProvenance(document)));
  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: STAC_SOURCE_CAPABILITIES,
      scope: STAC_SOURCE_CAPABILITIES,
      provenance,
    }),
  ]);
  const source: ConnectDiscoverySourceSnapshot = Object.freeze({
    id: sourceObject.id,
    locator: Object.freeze({
      url: rootRequestUrl,
      layout: "stac-static" as const,
      stacStatic: options.policy,
      ...(sourceObject.type === "collection" || sourceObject.collectionId
        ? { collectionId: sourceObject.type === "collection" ? sourceObject.id : sourceObject.collectionId }
        : {}),
    }),
    ...(sourceObject.title ? { title: sourceObject.title } : {}),
    ...(sourceObject.description ? { description: sourceObject.description } : {}),
    ...(sourceObject.metadata.crs ? { crs: sourceObject.metadata.crs } : {}),
    ...(sourceObject.metadata.extent ? { extent: sourceObject.metadata.extent } : {}),
    evidence,
  });
  return Object.freeze({ source, inspection });
}

/** Re-validate caller-cache data and rebind every candidate to one validated tree document. */
export async function validateCachedStacStaticInspection(
  value: unknown,
  endpoint: string,
  expectedPolicy: StacStaticTraversalPolicy,
): Promise<StacStaticDiscoveryInspection> {
  if (!isPlainObject(value) || !samePolicy(value.policy, expectedPolicy)) {
    throw invalidStaticCache("Cached static STAC traversal policy does not match this connection.");
  }
  const rootRequestUrl = cachedDocumentUrl(value.rootRequestUrl, endpoint);
  if (rootRequestUrl !== endpoint) {
    throw invalidStaticCache("Cached static STAC root request is not bound to the connected endpoint.");
  }
  if (
    !Array.isArray(value.documents) ||
    value.documents.length === 0 ||
    value.documents.length > expectedPolicy.maxDocuments
  ) {
    throw invalidStaticCache("Cached static STAC documents exceed the active traversal policy.");
  }
  const documents = Object.freeze(value.documents.map((entry) => validateCachedDocument(entry, endpoint)));
  // `root` is a redundant convenience view. Canonicalize it from the first
  // validated document so caller-cache data cannot make the two disagree.
  const root = documents[0]!;
  const byUrl = new Map<string, StacStaticObjectSummary>();
  for (const document of documents) {
    if (byUrl.has(document.url)) throw invalidStaticCache("Cached static STAC document URLs must be unique.");
    byUrl.set(document.url, document);
  }
  if (!Array.isArray(value.assetCandidates) || value.assetCandidates.length > expectedPolicy.maxAssets) {
    throw invalidStaticCache("Cached static STAC asset candidates exceed the active traversal policy.");
  }
  const assetCandidates = Object.freeze(
    value.assetCandidates.map((entry) => validateCachedCandidate(entry, byUrl, endpoint)),
  );
  if (!Array.isArray(value.diagnostics)) throw invalidStaticCache("Cached static STAC diagnostics must be an array.");
  const diagnostics = Object.freeze(value.diagnostics.map((entry) => validateCachedDiagnostic(entry, byUrl, endpoint)));
  const expectedFingerprint = await treeDigest(documents, assetCandidates);
  if (value.treeFingerprint !== expectedFingerprint) {
    throw invalidStaticCache("Cached static STAC tree fingerprint does not match its document validators.");
  }
  return Object.freeze({
    policy: expectedPolicy,
    rootRequestUrl,
    root,
    documents,
    assetCandidates,
    diagnostics,
    treeFingerprint: expectedFingerprint,
  });
}

function validateCachedDocument(value: unknown, endpoint: string): StacStaticObjectSummary {
  if (!isPlainObject(value)) throw invalidStaticCache("Cached static STAC document summary is invalid.");
  const url = cachedDocumentUrl(value.url, endpoint);
  const type = cachedEnum(value.type, ["catalog", "collection", "item"] as const, "object type");
  const id = cachedText(value.id, 512, "object id");
  const stacVersion = cachedText(value.stacVersion, 64, "STAC version");
  const contentDigest = cachedDigest(value.contentDigest, "content digest");
  const validator = value.validator === undefined ? undefined : cachedText(value.validator, 512, "validator");
  const metadata = validateCachedMetadata(value.metadata);
  if (!Array.isArray(value.provenance) || value.provenance.length !== 1) {
    throw invalidStaticCache("Cached static STAC document provenance is invalid.");
  }
  const provenance = Object.freeze([validateCachedProvenance(value.provenance[0], url, validator ?? contentDigest)]);
  return Object.freeze({
    url,
    type,
    id,
    stacVersion,
    contentDigest,
    ...(validator ? { validator } : {}),
    ...(value.title !== undefined ? { title: cachedText(value.title, 2048, "title") } : {}),
    ...(value.description !== undefined ? { description: cachedText(value.description, 16_384, "description") } : {}),
    ...(value.collectionId !== undefined ? { collectionId: cachedText(value.collectionId, 512, "collection id") } : {}),
    metadata,
    provenance,
  });
}

function validateCachedCandidate(
  value: unknown,
  documents: ReadonlyMap<string, StacStaticObjectSummary>,
  endpoint: string,
): StacAssetCandidate {
  if (!isPlainObject(value)) throw invalidStaticCache("Cached static STAC asset candidate is invalid.");
  const documentUrl = cachedDocumentUrl(value.documentUrl, endpoint);
  const document = documents.get(documentUrl);
  if (!document) throw invalidStaticCache("Cached asset candidate does not bind to a traversed document.");
  const state = cachedEnum(value.state, ["classified", "ambiguous", "unsupported"] as const, "candidate state");
  const kind =
    value.kind === undefined
      ? undefined
      : cachedEnum(value.kind, ["cog", "geoparquet", "pmtiles", "tile", "metadata"] as const, "asset kind");
  if (state === "classified" && !kind) {
    throw invalidStaticCache("Cached classified candidates require one recognized asset kind.");
  }
  const confidence = cachedEnum(value.confidence, ["high", "medium", "low", "none"] as const, "confidence");
  const objectType = cachedEnum(value.objectType, ["catalog", "collection", "item"] as const, "object type");
  const objectId = cachedText(value.objectId, 512, "object id");
  if (objectType !== document.type || objectId !== document.id) {
    throw invalidStaticCache("Cached asset candidate identity contradicts its traversed document.");
  }
  const assetKey = cachedText(value.assetKey, 512, "asset key");
  const id = cachedText(value.id, 1024, "candidate id");
  if (id !== `${document.id}:${assetKey}`) {
    throw invalidStaticCache("Cached asset candidate id is not derived from its object and asset key.");
  }
  const expectedCollectionId = document.type === "collection" ? document.id : document.collectionId;
  const collectionId =
    value.collectionId === undefined ? undefined : cachedText(value.collectionId, 512, "collection id");
  if (collectionId !== expectedCollectionId) {
    throw invalidStaticCache("Cached asset candidate collection identity contradicts its traversed document.");
  }
  const expectedItemId = document.type === "item" ? document.id : undefined;
  const itemId = value.itemId === undefined ? undefined : cachedText(value.itemId, 512, "item id");
  if (itemId !== expectedItemId) {
    throw invalidStaticCache("Cached asset candidate item identity contradicts its traversed document.");
  }
  const href = value.href === undefined ? undefined : cachedAssetUrl(value.href);
  const roles = cachedStringArray(value.roles, 128, 64, "asset roles");
  const metadata = validateCachedMetadata(value.metadata);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 128) {
    throw invalidStaticCache("Cached asset classification evidence is invalid.");
  }
  const evidence = Object.freeze(value.evidence.map(validateCachedClassificationEvidence));
  if (!Array.isArray(value.provenance) || value.provenance.length !== 1) {
    throw invalidStaticCache("Cached asset provenance is invalid.");
  }
  const documentValidator = document.validator ?? document.contentDigest;
  const provenance = Object.freeze([validateCachedProvenance(value.provenance[0], documentUrl, documentValidator)]);
  const source = value.source === undefined ? undefined : validateCachedSourceCandidate(value.source, kind, href);
  if (source && state !== "classified") {
    throw invalidStaticCache("Only classified cached assets may carry source locators.");
  }
  return Object.freeze({
    id,
    state,
    ...(kind ? { kind } : {}),
    confidence,
    documentUrl,
    objectType,
    objectId,
    ...(collectionId ? { collectionId } : {}),
    ...(itemId ? { itemId } : {}),
    assetKey,
    ...(href ? { href } : {}),
    ...(value.mediaType !== undefined ? { mediaType: cachedText(value.mediaType, 512, "media type") } : {}),
    roles,
    ...(source ? { source } : {}),
    metadata,
    evidence,
    provenance,
  });
}

function validateCachedSourceCandidate(
  value: unknown,
  kind: StacAssetKind | undefined,
  href: string | undefined,
): StacAssetSourceCandidate {
  if (!isPlainObject(value) || !isPlainObject(value.locator) || !href || value.locator.url !== href) {
    throw invalidStaticCache("Cached asset source locator is not bound to its credential-free href.");
  }
  const protocol = cachedEnum(
    value.protocol,
    ["pmtiles", "geoparquet", "maplibre-vector", "maplibre-raster"] as const,
    "source protocol",
  );
  const compatible =
    (kind === "pmtiles" && protocol === "pmtiles") ||
    (kind === "geoparquet" && protocol === "geoparquet") ||
    (kind === "tile" && (protocol === "maplibre-vector" || protocol === "maplibre-raster"));
  if (!compatible) throw invalidStaticCache("Cached asset kind and source protocol are incompatible.");
  const locator: SourceLocator = Object.freeze({
    url: href,
    ...(protocol === "geoparquet" && isPlainObject(value.locator.geoparquet)
      ? {
          geoparquet: Object.freeze({
            ...(value.locator.geoparquet.geometryColumn !== undefined
              ? { geometryColumn: cachedText(value.locator.geoparquet.geometryColumn, 512, "geometry column") }
              : {}),
          }),
        }
      : {}),
  });
  return Object.freeze({ protocol, locator });
}

function validateCachedClassificationEvidence(value: unknown): StacAssetClassificationEvidence {
  if (!isPlainObject(value)) throw invalidStaticCache("Cached asset evidence is invalid.");
  const kind = cachedEnum(
    value.kind,
    ["media-type", "role", "extension", "asset-field", "probe", "url-policy"] as const,
    "evidence kind",
  );
  const supports =
    value.supports === undefined
      ? undefined
      : Object.freeze(
          cachedStringArray(value.supports, 32, 5, "supported asset kinds").map((entry) =>
            cachedEnum(entry, ["cog", "geoparquet", "pmtiles", "tile", "metadata"] as const, "asset kind"),
          ),
        );
  return Object.freeze({
    kind,
    value: cachedText(value.value, 2048, "evidence value"),
    ...(supports && supports.length > 0 ? { supports } : {}),
  });
}

function validateCachedDiagnostic(
  value: unknown,
  documents: ReadonlyMap<string, StacStaticObjectSummary>,
  endpoint: string,
): StacStaticDiagnostic {
  if (!isPlainObject(value) || value.severity !== "warning") {
    throw invalidStaticCache("Cached static STAC diagnostic is invalid.");
  }
  const documentUrl = cachedDocumentUrl(value.documentUrl, endpoint);
  if (!documents.has(documentUrl) && documentUrl !== endpoint) {
    throw invalidStaticCache("Cached static STAC diagnostic is not bound to the traversed tree.");
  }
  return Object.freeze({
    code: cachedEnum(
      value.code,
      [
        "unsafe-link-skipped",
        "cross-origin-link-skipped",
        "non-json-link-skipped",
        "malformed-link-skipped",
        "linked-document-unavailable",
        "linked-document-invalid",
        "document-limit-reached",
        "depth-limit-reached",
        "link-limit-reached",
        "asset-limit-reached",
      ] as const,
      "diagnostic code",
    ),
    severity: "warning" as const,
    documentUrl,
    ...(value.rel !== undefined ? { rel: cachedText(value.rel, 64, "link relation") } : {}),
    message: cachedText(value.message, 2048, "diagnostic message"),
  });
}

function validateCachedMetadata(value: unknown): StacAssetCandidateMetadata {
  if (!isPlainObject(value)) throw invalidStaticCache("Cached static STAC metadata is invalid.");
  const crs = value.crs === undefined ? undefined : cachedStringArray(value.crs, 2048, 64, "CRS");
  const extent = value.extent === undefined ? undefined : validateCachedExtent(value.extent);
  return Object.freeze({
    ...(crs && crs.length > 0 ? { crs } : {}),
    ...(extent ? { extent } : {}),
    ...(value.license !== undefined ? { license: cachedText(value.license, 2048, "license") } : {}),
    ...(value.attribution !== undefined ? { attribution: cachedText(value.attribution, 4096, "attribution") } : {}),
    ...(value.datetime !== undefined ? { datetime: cachedDate(value.datetime, "datetime") } : {}),
    ...(value.startDatetime !== undefined ? { startDatetime: cachedDate(value.startDatetime, "start datetime") } : {}),
    ...(value.endDatetime !== undefined ? { endDatetime: cachedDate(value.endDatetime, "end datetime") } : {}),
  });
}

function validateCachedExtent(value: unknown): ConnectDiscoveryExtent {
  if (!isPlainObject(value)) throw invalidStaticCache("Cached static STAC extent is invalid.");
  const spatial = value.spatial;
  const temporal = value.temporal;
  if (spatial === undefined && temporal === undefined) throw invalidStaticCache("Cached extent must not be empty.");
  let normalizedSpatial: ConnectDiscoveryExtent["spatial"];
  if (spatial !== undefined) {
    if (!isPlainObject(spatial) || !Array.isArray(spatial.bbox) || !spatial.bbox.every(validBbox)) {
      throw invalidStaticCache("Cached static STAC spatial extent is invalid.");
    }
    normalizedSpatial = Object.freeze({
      bbox: Object.freeze(spatial.bbox.map((entry) => Object.freeze([...entry]))),
      ...(spatial.crs !== undefined ? { crs: cachedText(spatial.crs, 2048, "extent CRS") } : {}),
    });
  }
  let normalizedTemporal: ConnectDiscoveryExtent["temporal"];
  if (temporal !== undefined) {
    if (!isPlainObject(temporal) || !Array.isArray(temporal.interval) || !temporal.interval.every(validInterval)) {
      throw invalidStaticCache("Cached static STAC temporal extent is invalid.");
    }
    normalizedTemporal = Object.freeze({
      interval: Object.freeze(temporal.interval.map((entry) => Object.freeze([...entry]))),
      ...(temporal.trs !== undefined ? { trs: cachedText(temporal.trs, 2048, "extent TRS") } : {}),
    });
  }
  return Object.freeze({
    ...(normalizedSpatial ? { spatial: normalizedSpatial } : {}),
    ...(normalizedTemporal ? { temporal: normalizedTemporal } : {}),
  });
}

function validateCachedProvenance(value: unknown, source: string, validator: string): DiscoveryProvenance {
  if (!isPlainObject(value) || value.source !== source || value.validator !== validator) {
    throw invalidStaticCache("Cached static STAC provenance is not bound to its document version.");
  }
  return Object.freeze({
    source,
    ...(value.retrievedAt !== undefined
      ? { retrievedAt: cachedDate(value.retrievedAt, "provenance retrieval time") }
      : {}),
    validator,
  });
}

function samePolicy(value: unknown, expected: StacStaticTraversalPolicy): boolean {
  return (
    isPlainObject(value) &&
    value.maxDocuments === expected.maxDocuments &&
    value.maxDepth === expected.maxDepth &&
    value.maxLinksPerDocument === expected.maxLinksPerDocument &&
    value.maxAssets === expected.maxAssets &&
    value.maxAssetProbes === expected.maxAssetProbes &&
    value.maxDocumentBytes === expected.maxDocumentBytes
  );
}

function cachedDocumentUrl(value: unknown, endpoint: string): string {
  const url = canonicalDocumentUrl(cachedText(value, 8192, "document URL"), endpoint);
  if (new URL(url).origin !== new URL(endpoint).origin) {
    throw invalidStaticCache("Cached traversed STAC documents must stay on the connected origin.");
  }
  return url;
}

function cachedAssetUrl(value: unknown): string {
  const text = cachedText(value, 8192, "asset URL");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalidStaticCache("Cached STAC asset URL is invalid.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    assetUrlString(url) !== text
  ) {
    throw invalidStaticCache("Cached STAC asset URL is not credential-free canonical HTTP(S). ");
  }
  return text;
}

function cachedDate(value: unknown, label: string): string {
  const text = cachedText(value, 128, label);
  if (Number.isNaN(Date.parse(text))) throw invalidStaticCache(`Cached ${label} is invalid.`);
  return text;
}

function cachedDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw invalidStaticCache(`Cached ${label} is invalid.`);
  }
  return value as `sha256:${string}`;
}

function cachedStringArray(value: unknown, maxText: number, maxItems: number, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalidStaticCache(`Cached ${label} is invalid.`);
  return Object.freeze(value.map((entry) => cachedText(entry, maxText, label)));
}

function cachedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.trim() !== value) {
    throw invalidStaticCache(`Cached ${label} is invalid.`);
  }
  return value;
}

function cachedEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw invalidStaticCache(`Cached ${label} is invalid.`);
  }
  return value as T[number];
}

function invalidStaticCache(message: string): HonuaDiscoveryError {
  return new HonuaDiscoveryError("invalid-discovery-cache", message);
}

async function fetchStaticDocument(
  client: HonuaClient,
  url: string,
  options: StacStaticDiscoveryOptions,
): Promise<{ readonly value: unknown; readonly validator?: string; readonly url: string }> {
  const response = await client.pipelineFetch(
    "GET",
    url,
    {
      headers: honuaMetadataRequestHeaders({
        accept: "application/json, application/geo+json;q=0.9",
        refresh: options.refresh === true,
        bypass: options.metadata?.cache === "bypass",
      }),
    },
    options.signal,
    { redirect: "error" },
  );
  const contentType = mediaEssence(response.headers.get("content-type") ?? "");
  if (contentType && !STATIC_DOCUMENT_MEDIA_TYPES.has(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HonuaDiscoveryError("invalid-endpoint", "Linked STAC metadata did not return JSON.");
  }
  const finalUrl = response.url ? canonicalDocumentUrl(response.url, url) : url;
  if (new URL(finalUrl).origin !== new URL(client.serverBaseUrl).origin) {
    await response.body?.cancel().catch(() => undefined);
    throw new HonuaDiscoveryError("invalid-endpoint", "A linked STAC metadata redirect left the connected origin.");
  }
  const bytes = await readBoundedBytes(response, options.policy.maxDocumentBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "Linked STAC metadata contained invalid JSON.");
  }
  const validator = response.headers.get("etag") ?? response.headers.get("last-modified") ?? undefined;
  return { value, ...(validator ? { validator: boundedText(validator, 512, "validator") } : {}), url: finalUrl };
}

async function readBoundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const length = Number(advertised);
    if (Number.isFinite(length) && length > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new HonuaDiscoveryError("invalid-endpoint", `STAC metadata exceeds the ${maximum}-byte limit.`);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new HonuaDiscoveryError("invalid-endpoint", `STAC metadata exceeds the ${maximum}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function parseStaticDocument(
  value: unknown,
  url: string,
  responseValidator: string | undefined,
): Promise<ParsedStaticDocument> {
  if (!isPlainObject(value) || Object.hasOwn(value, "conformsTo")) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC documents must be plain non-API objects.");
  }
  const type = stacObjectType(value.type);
  const id = boundedText(value.id, 512, "STAC object id");
  const stacVersion = boundedText(value.stac_version, 64, "STAC version");
  const links = value.links;
  if (!Array.isArray(links)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC documents must contain a links array.");
  }
  const assetsValue = value.assets;
  if (assetsValue !== undefined && !isPlainObject(assetsValue)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC assets must be an object map.");
  }
  const extensions = value.stac_extensions;
  if (
    extensions !== undefined &&
    (!Array.isArray(extensions) || extensions.some((entry) => typeof entry !== "string"))
  ) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC extensions must be a string array.");
  }
  if (type === "collection" && (!isPlainObject(value.extent) || typeof value.license !== "string")) {
    throw new HonuaDiscoveryError("invalid-endpoint", "A STAC Collection requires extent and license metadata.");
  }
  if (type === "item" && !isPlainObject(value.properties)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "A STAC Item requires a properties object.");
  }
  const retrievedAt = new Date().toISOString();
  const cacheValidator =
    isPlainObject(value.cache) && isPlainObject(value.cache.validator) ? value.cache.validator : {};
  const validatorValue =
    responseValidator ??
    (typeof cacheValidator.etag === "string"
      ? cacheValidator.etag
      : typeof cacheValidator.lastModified === "string"
        ? cacheValidator.lastModified
        : undefined);
  const rawForDigest = { ...value };
  delete rawForDigest.cache;
  const metadata = objectMetadata(value, type);
  return Object.freeze({
    raw: value,
    url,
    type,
    id,
    stacVersion,
    ...(optionalBoundedText(value.title, 2048, "STAC title") ? { title: String(value.title) } : {}),
    ...(optionalBoundedText(value.description, 16_384, "STAC description")
      ? { description: String(value.description) }
      : {}),
    ...(type === "item" && typeof value.collection === "string" && value.collection
      ? { collectionId: boundedText(value.collection, 512, "STAC Item collection") }
      : {}),
    links: Object.freeze([...links]),
    assets: Object.freeze({ ...(assetsValue ?? {}) }),
    extensions: Object.freeze((extensions ?? []).map((entry) => boundedText(entry, 2048, "STAC extension"))),
    metadata,
    ...(validatorValue ? { validator: boundedText(validatorValue, 512, "STAC validator") } : {}),
    retrievedAt,
    contentDigest: await sha256(canonicalJson(rawForDigest)),
  });
}

function objectMetadata(value: Record<string, unknown>, type: StacStaticObjectType): StacAssetCandidateMetadata {
  const properties = type === "item" && isPlainObject(value.properties) ? value.properties : value;
  const crs = extractCrs(properties, value);
  const extent = type === "collection" ? collectionExtent(value.extent) : itemExtent(value, properties);
  const license = typeof value.license === "string" ? boundedText(value.license, 2048, "STAC license") : undefined;
  const attribution = extractAttribution(value);
  const datetime = validDatetime(properties.datetime);
  const startDatetime = validDatetime(properties.start_datetime);
  const endDatetime = validDatetime(properties.end_datetime);
  return Object.freeze({
    ...(crs.length > 0 ? { crs } : {}),
    ...(extent ? { extent } : {}),
    ...(license ? { license } : {}),
    ...(attribution ? { attribution } : {}),
    ...(datetime ? { datetime } : {}),
    ...(startDatetime ? { startDatetime } : {}),
    ...(endDatetime ? { endDatetime } : {}),
  });
}

function collectionExtent(value: unknown): ConnectDiscoveryExtent | undefined {
  if (!isPlainObject(value)) return undefined;
  const spatialValue = isPlainObject(value.spatial) ? value.spatial : undefined;
  const temporalValue = isPlainObject(value.temporal) ? value.temporal : undefined;
  const bbox = spatialValue?.bbox;
  const interval = temporalValue?.interval;
  const spatial =
    Array.isArray(bbox) && bbox.every(validBbox)
      ? Object.freeze({
          bbox: Object.freeze(bbox.map((entry) => Object.freeze([...entry]))),
          ...(typeof spatialValue?.crs === "string" ? { crs: boundedText(spatialValue.crs, 2048, "extent crs") } : {}),
        })
      : undefined;
  const temporal =
    Array.isArray(interval) && interval.every(validInterval)
      ? Object.freeze({
          interval: Object.freeze(interval.map((entry) => Object.freeze([...entry]))),
          ...(typeof temporalValue?.trs === "string"
            ? { trs: boundedText(temporalValue.trs, 2048, "extent trs") }
            : {}),
        })
      : undefined;
  return spatial || temporal
    ? Object.freeze({ ...(spatial ? { spatial } : {}), ...(temporal ? { temporal } : {}) })
    : undefined;
}

function itemExtent(
  value: Record<string, unknown>,
  properties: Record<string, unknown>,
): ConnectDiscoveryExtent | undefined {
  const bboxValue = Array.isArray(value.bbox) && validBbox(value.bbox) ? value.bbox : undefined;
  const datetime = validDatetime(properties.datetime);
  const start = validDatetime(properties.start_datetime);
  const end = validDatetime(properties.end_datetime);
  const interval = datetime ? [datetime, datetime] : start || end ? [start ?? null, end ?? null] : undefined;
  return bboxValue || interval
    ? Object.freeze({
        ...(bboxValue ? { spatial: Object.freeze({ bbox: Object.freeze([Object.freeze([...bboxValue])]) }) } : {}),
        ...(interval ? { temporal: Object.freeze({ interval: Object.freeze([Object.freeze(interval)]) }) } : {}),
      })
    : undefined;
}

function extractCrs(...values: readonly Record<string, unknown>[]): readonly string[] {
  const out: string[] = [];
  for (const value of values) {
    if (Array.isArray(value.crs)) {
      for (const entry of value.crs) if (typeof entry === "string" && entry.trim()) out.push(entry);
    }
    if (typeof value["proj:code"] === "string" && value["proj:code"].trim()) out.push(value["proj:code"]);
    if (typeof value["proj:epsg"] === "number" && Number.isSafeInteger(value["proj:epsg"])) {
      out.push(`EPSG:${value["proj:epsg"]}`);
    }
  }
  return Object.freeze([...new Set(out.map((entry) => boundedText(entry, 2048, "STAC CRS")))]);
}

function extractAttribution(value: Record<string, unknown>): string | undefined {
  if (typeof value.attribution === "string" && value.attribution.trim()) {
    return boundedText(value.attribution, 4096, "STAC attribution");
  }
  if (!Array.isArray(value.providers)) return undefined;
  const names = value.providers
    .filter(isPlainObject)
    .map((provider) => provider.name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => boundedText(name, 1024, "STAC provider name"));
  return names.length > 0 ? names.join("; ") : undefined;
}

function relevantLink(
  value: unknown,
  documentType: StacStaticObjectType,
): { readonly relevant: boolean; readonly rel?: string; readonly href?: string; readonly mediaType?: string } {
  if (!isPlainObject(value)) return { relevant: false };
  const rel = typeof value.rel === "string" ? value.rel.toLowerCase() : undefined;
  const relevant = rel === "child" || rel === "item" || (documentType === "item" && rel === "collection");
  if (!relevant) return { relevant: false, ...(rel ? { rel } : {}) };
  return {
    relevant: true,
    ...(rel ? { rel } : {}),
    ...(typeof value.href === "string" && value.href ? { href: value.href } : {}),
    ...(typeof value.type === "string" && value.type ? { mediaType: value.type } : {}),
  };
}

function traversalLinkUrl(
  href: string,
  documentUrl: string,
  rootUrl: string,
): { readonly state: "safe"; readonly url: string } | { readonly state: "unsafe" | "cross-origin" } {
  let resolved: URL;
  try {
    resolved = new URL(href, documentUrl);
  } catch {
    return { state: "unsafe" };
  }
  if (
    (resolved.protocol !== "http:" && resolved.protocol !== "https:") ||
    resolved.username ||
    resolved.password ||
    resolved.search ||
    resolved.hash
  ) {
    return { state: "unsafe" };
  }
  if (resolved.origin !== new URL(rootUrl).origin) return { state: "cross-origin" };
  return { state: "safe", url: canonicalDocumentUrl(resolved.toString(), documentUrl) };
}

function resolveAssetUrl(
  hrefValue: unknown,
  documentUrl: string,
):
  | { readonly state: "safe"; readonly url: string }
  | { readonly state: "missing" | "unsafe"; readonly redacted?: string } {
  if (typeof hrefValue !== "string" || !hrefValue) return { state: "missing" };
  let resolved: URL;
  try {
    resolved = new URL(hrefValue, documentUrl);
  } catch {
    return { state: "unsafe" };
  }
  const redacted =
    resolved.protocol === "http:" || resolved.protocol === "https:"
      ? `${resolved.origin}${resolved.pathname}`
      : undefined;
  if (
    (resolved.protocol !== "http:" && resolved.protocol !== "https:") ||
    resolved.username ||
    resolved.password ||
    resolved.search ||
    resolved.hash
  ) {
    return { state: "unsafe", ...(redacted ? { redacted } : {}) };
  }
  return { state: "safe", url: assetUrlString(resolved) };
}

async function probeAsset(client: HonuaClient, href: string, signal: AbortSignal | undefined): Promise<AssetProbe> {
  try {
    const response = await client.pipelineFetch("HEAD", href, { headers: { Accept: "*/*" } }, signal, {
      redirect: "error",
    });
    const finalUrl = response.url ? canonicalDocumentUrl(response.url, href) : href;
    if (new URL(finalUrl).origin !== new URL(client.serverBaseUrl).origin) {
      await response.body?.cancel().catch(() => undefined);
      return { attempted: true, unavailable: "request-failed" };
    }
    const contentType = response.headers.get("content-type");
    await response.body?.cancel().catch(() => undefined);
    return {
      attempted: true,
      ...(contentType ? { contentType: boundedText(contentType, 512, "asset probe content type") } : {}),
    };
  } catch (cause) {
    if (signal?.aborted || cause instanceof HonuaAbortError) throw new HonuaAbortError();
    return { attempted: true, unavailable: "request-failed" };
  }
}

function classifyAsset(
  pending: PendingAsset,
  href: ReturnType<typeof resolveAssetUrl>,
  probe: AssetProbe,
  collection: ParsedStaticDocument | undefined,
): StacAssetCandidate {
  const { document, assetKey, asset } = pending;
  const roles = normalizeRoles(asset.roles);
  const declaredType = typeof asset.type === "string" ? boundedText(asset.type, 512, "asset media type") : undefined;
  const probedType = probe.contentType;
  const declared = classifyMediaType(declaredType, roles, asset, document.extensions, document.raw);
  const probed = classifyMediaType(probedType, roles, asset, document.extensions, document.raw);
  const evidence: StacAssetClassificationEvidence[] = [];
  if (declaredType) {
    evidence.push(
      evidenceRecord("media-type", normalizeMediaType(declaredType), declared.kind ? [declared.kind] : undefined),
    );
  }
  for (const role of roles) evidence.push(evidenceRecord("role", role));
  for (const extension of relevantExtensions(document.extensions))
    evidence.push(evidenceRecord("extension", extension));
  if (typeof document.raw["table:primary_geometry"] === "string") {
    evidence.push(evidenceRecord("asset-field", "table:primary_geometry", ["geoparquet"]));
  }
  if (typeof asset["table:primary_geometry"] === "string") {
    evidence.push(evidenceRecord("asset-field", "table:primary_geometry", ["geoparquet"]));
  }
  if (probe.contentType) {
    evidence.push(
      evidenceRecord(
        "probe",
        `content-type:${normalizeMediaType(probe.contentType)}`,
        probed.kind ? [probed.kind] : undefined,
      ),
    );
  } else if (probe.unavailable) {
    evidence.push(
      evidenceRecord(
        "probe",
        probe.unavailable === "cross-origin"
          ? "blocked-cross-origin"
          : probe.unavailable === "policy-limit"
            ? "blocked-policy-limit"
            : "unavailable",
      ),
    );
  } else if (!probe.attempted) {
    evidence.push(evidenceRecord("probe", "not-attempted-limit"));
  }
  if (href.state !== "safe") {
    evidence.push(evidenceRecord("url-policy", href.state === "missing" ? "missing-href" : "unsafe-href-redacted"));
  }

  const conflict = Boolean(declared.kind && probed.kind && declared.kind !== probed.kind);
  let state: StacAssetCandidateState;
  let kind: StacAssetKind | undefined;
  let confidence: StacAssetConfidence;
  let tileProtocol: MediaSignal["tileProtocol"];
  if (conflict || declared.ambiguous || (!declaredType && probed.ambiguous)) {
    state = "ambiguous";
    confidence = "low";
  } else {
    const selected = declared.kind ? declared : probed.kind ? probed : declaredType ? declared : probed;
    kind = selected.kind;
    tileProtocol = selected.tileProtocol;
    if (kind) {
      state = "classified";
      confidence = selected.confidence;
    } else if (!declaredType || mediaEssence(declaredType) === "application/octet-stream") {
      state = "ambiguous";
      confidence = "none";
    } else {
      state = "unsupported";
      confidence = "none";
    }
  }
  if (href.state !== "safe") {
    state = "unsupported";
    confidence = "none";
  } else if (probe.unavailable && confidence === "high") {
    confidence = "medium";
  } else if (probe.unavailable && confidence === "medium") {
    confidence = "low";
  }

  const itemMetadata = document.metadata;
  const assetCrs = extractCrs(asset, document.raw);
  const metadata: StacAssetCandidateMetadata = Object.freeze({
    ...(assetCrs.length > 0
      ? { crs: assetCrs }
      : itemMetadata.crs
        ? { crs: itemMetadata.crs }
        : collection?.metadata.crs
          ? { crs: collection.metadata.crs }
          : {}),
    ...((assetExtent(asset) ?? itemMetadata.extent ?? collection?.metadata.extent)
      ? { extent: assetExtent(asset) ?? itemMetadata.extent ?? collection?.metadata.extent }
      : {}),
    ...(typeof asset.license === "string"
      ? { license: boundedText(asset.license, 2048, "asset license") }
      : itemMetadata.license
        ? { license: itemMetadata.license }
        : collection?.metadata.license
          ? { license: collection.metadata.license }
          : {}),
    ...(typeof asset.attribution === "string"
      ? { attribution: boundedText(asset.attribution, 4096, "asset attribution") }
      : itemMetadata.attribution
        ? { attribution: itemMetadata.attribution }
        : collection?.metadata.attribution
          ? { attribution: collection.metadata.attribution }
          : {}),
    ...(itemMetadata.datetime ? { datetime: itemMetadata.datetime } : {}),
    ...(itemMetadata.startDatetime ? { startDatetime: itemMetadata.startDatetime } : {}),
    ...(itemMetadata.endDatetime ? { endDatetime: itemMetadata.endDatetime } : {}),
  });
  const source =
    state === "classified" && kind && href.state === "safe"
      ? sourceCandidate(kind, tileProtocol, href.url, asset, document.raw)
      : undefined;
  const provenance = Object.freeze([documentProvenance(document)]);
  return Object.freeze({
    id: `${document.id}:${assetKey}`,
    state,
    ...(kind ? { kind } : {}),
    confidence,
    documentUrl: document.url,
    objectType: document.type,
    objectId: document.id,
    ...(document.type === "collection"
      ? { collectionId: document.id }
      : document.collectionId
        ? { collectionId: document.collectionId }
        : {}),
    ...(document.type === "item" ? { itemId: document.id } : {}),
    assetKey: boundedText(assetKey, 512, "STAC asset key"),
    ...(href.state === "safe" ? { href: href.url } : {}),
    ...(declaredType ? { mediaType: normalizeMediaType(declaredType) } : {}),
    roles,
    ...(source ? { source } : {}),
    metadata,
    evidence: Object.freeze(evidence),
    provenance,
  });
}

function classifyMediaType(
  value: string | undefined,
  roles: readonly string[],
  asset: Record<string, unknown>,
  extensions: readonly string[],
  document: Record<string, unknown>,
): MediaSignal {
  if (!value) return { confidence: "none" };
  const normalized = normalizeMediaType(value);
  const essence = mediaEssence(normalized);
  const parameters = normalized.slice(essence.length);
  if (
    (essence === "image/tiff" &&
      parameters.includes("application=geotiff") &&
      parameters.includes("profile=cloud-optimized")) ||
    (essence === "image/vnd.stac.geotiff" && parameters.includes("profile=cloud-optimized"))
  ) {
    return { kind: "cog", confidence: "high" };
  }
  if (essence === "image/tiff" || essence === "image/vnd.stac.geotiff") {
    return { confidence: "low", ambiguous: true };
  }
  if (essence === "application/vnd.pmtiles") return { kind: "pmtiles", confidence: "high" };
  if (essence === "application/vnd.apache.parquet") {
    const tableGeometry =
      typeof asset["table:primary_geometry"] === "string" || typeof document["table:primary_geometry"] === "string";
    const tableExtension = extensions.some((entry) => entry.toLowerCase().includes("/table/"));
    return {
      kind: "geoparquet",
      confidence: tableGeometry || tableExtension || roles.includes("data") ? "high" : "medium",
    };
  }
  if (VECTOR_TILE_MEDIA_TYPES.has(normalized) || VECTOR_TILE_MEDIA_TYPES.has(essence)) {
    return { kind: "tile", tileProtocol: "maplibre-vector", confidence: "high" };
  }
  if (roles.includes("tiles") && RASTER_TILE_MEDIA_TYPES.has(essence)) {
    return { kind: "tile", tileProtocol: "maplibre-raster", confidence: "high" };
  }
  if (roles.includes("tiles") && (essence === "application/json" || essence === "application/geo+json")) {
    return { kind: "tile", confidence: "medium" };
  }
  if (roles.includes("metadata") || (METADATA_MEDIA_TYPES.has(essence) && !roles.includes("data"))) {
    return { kind: "metadata", confidence: roles.includes("metadata") ? "high" : "medium" };
  }
  return { confidence: "none" };
}

function sourceCandidate(
  kind: StacAssetKind,
  tileProtocol: MediaSignal["tileProtocol"],
  href: string,
  asset: Record<string, unknown>,
  document: Record<string, unknown>,
): StacAssetSourceCandidate | undefined {
  if (kind === "pmtiles") {
    return Object.freeze({ protocol: "pmtiles" as const, locator: Object.freeze({ url: href }) });
  }
  if (kind === "geoparquet") {
    const geometryColumn =
      typeof asset["table:primary_geometry"] === "string"
        ? boundedText(asset["table:primary_geometry"], 512, "GeoParquet geometry column")
        : typeof document["table:primary_geometry"] === "string"
          ? boundedText(document["table:primary_geometry"], 512, "GeoParquet geometry column")
          : undefined;
    return Object.freeze({
      protocol: "geoparquet" as const,
      locator: Object.freeze({
        url: href,
        ...(geometryColumn ? { geoparquet: Object.freeze({ geometryColumn }) } : {}),
      }),
    });
  }
  if (kind === "tile" && tileProtocol && hasTileTemplate(href)) {
    return Object.freeze({ protocol: tileProtocol, locator: Object.freeze({ url: href }) });
  }
  // A COG remains typed but non-executable as a protocol-neutral Source. The
  // experimental /cog subpath consumes this evidence-bound candidate directly;
  // metadata and non-template tile assets remain inspection-only.
  return undefined;
}

function hasTileTemplate(href: string): boolean {
  const lower = href.toLowerCase();
  return lower.includes("{z}") && lower.includes("{x}") && lower.includes("{y}");
}

function assetExtent(asset: Record<string, unknown>): ConnectDiscoveryExtent | undefined {
  const bbox = asset["proj:bbox"] ?? asset.bbox;
  return Array.isArray(bbox) && validBbox(bbox)
    ? Object.freeze({ spatial: Object.freeze({ bbox: Object.freeze([Object.freeze([...bbox])]) }) })
    : undefined;
}

function normalizeRoles(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
    return Object.freeze([]);
  return Object.freeze([...new Set(value.map((entry) => boundedText(entry.toLowerCase(), 128, "asset role")))]);
}

function relevantExtensions(values: readonly string[]): readonly string[] {
  return Object.freeze(
    values
      .filter((value) => /(?:\/|^)(?:table|tiles|tiled-assets|projection|raster|file)(?:\/|$)/i.test(value))
      .map((value) => boundedText(value, 2048, "STAC extension")),
  );
}

function evidenceRecord(
  kind: StacAssetClassificationEvidence["kind"],
  value: string,
  supports?: readonly StacAssetKind[],
): StacAssetClassificationEvidence {
  return Object.freeze({
    kind,
    value: boundedText(value, 2048, "classification evidence"),
    ...(supports && supports.length > 0 ? { supports: Object.freeze([...supports]) } : {}),
  });
}

function summarizeDocument(document: ParsedStaticDocument): StacStaticObjectSummary {
  const provenance = Object.freeze([documentProvenance(document)]);
  return Object.freeze({
    url: document.url,
    type: document.type,
    id: document.id,
    stacVersion: document.stacVersion,
    contentDigest: document.contentDigest,
    ...(document.validator ? { validator: document.validator } : {}),
    ...(document.title ? { title: document.title } : {}),
    ...(document.description ? { description: document.description } : {}),
    ...(document.collectionId ? { collectionId: document.collectionId } : {}),
    metadata: document.metadata,
    provenance,
  });
}

function documentProvenance(document: ParsedStaticDocument): DiscoveryProvenance {
  return Object.freeze({
    source: document.url,
    retrievedAt: document.retrievedAt,
    ...(document.validator ? { validator: document.validator } : { validator: document.contentDigest }),
  });
}

async function treeDigest(
  documents: readonly StacStaticObjectSummary[],
  candidates: readonly StacAssetCandidate[],
): Promise<`sha256:${string}`> {
  const documentBindings = [...documents]
    .sort((left, right) => left.url.localeCompare(right.url))
    .map((document) => ({
      url: document.url,
      stacVersion: document.stacVersion,
      validator: document.validator ?? null,
      contentDigest: document.contentDigest,
    }));
  const candidateBindings = [...candidates]
    .sort((left, right) =>
      `${left.documentUrl}\u0000${left.assetKey}`.localeCompare(`${right.documentUrl}\u0000${right.assetKey}`),
    )
    .map((candidate) => ({
      documentUrl: candidate.documentUrl,
      assetKey: candidate.assetKey,
      state: candidate.state,
      kind: candidate.kind ?? null,
      href: candidate.href ?? null,
      source: candidate.source ? { protocol: candidate.source.protocol, locator: candidate.source.locator } : null,
    }));
  return sha256(canonicalJson({ documents: documentBindings, assetCandidates: candidateBindings }));
}

function diagnostic(
  code: StacStaticDiagnosticCode,
  documentUrl: string,
  message: string,
  rel?: string,
): StacStaticDiagnostic {
  return Object.freeze({ code, severity: "warning" as const, documentUrl, ...(rel ? { rel } : {}), message });
}

function stacObjectType(value: unknown): StacStaticObjectType {
  if (value === "Catalog") return "catalog";
  if (value === "Collection") return "collection";
  if (value === "Feature") return "item";
  throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC object type must be Catalog, Collection, or Feature.");
}

function canonicalDocumentUrl(value: string, base: string): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Static STAC document links must be absolute or resolvable URLs.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Static STAC document URLs must be credential-free HTTP(S) URLs without query parameters or fragments.",
    );
  }
  return url.toString();
}

function normalizeMediaType(value: string): string {
  return value
    .split(";")
    .map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/^([^=]+)=\"(.*)\"$/, "$1=$2"),
    )
    .filter(Boolean)
    .join(";");
}

function assetUrlString(url: URL): string {
  return url.toString().replaceAll(/%7B([zxy])%7D/gi, (_match, token: string) => `{${token.toLowerCase()}}`);
}

function mediaEssence(value: string): string {
  return normalizeMediaType(value).split(";", 1)[0] ?? "";
}

function validBbox(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    (value.length === 4 || value.length === 6) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
    value[0]! <= value[value.length / 2]! &&
    value[1]! <= value[value.length / 2 + 1]! &&
    (value.length === 4 || value[2]! <= value[5]!)
  );
}

function validInterval(value: unknown): value is (string | null)[] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((entry) => entry === null || (typeof entry === "string" && !Number.isNaN(Date.parse(entry))))
  );
}

function validDatetime(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? boundedText(value, 128, "STAC datetime")
    : undefined;
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.trim() !== value) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${label} must be non-empty bounded text.`);
  }
  return value;
}

function optionalBoundedText(value: unknown, maximum: number, label: string): boolean {
  if (value === undefined) return false;
  boundedText(value, maximum, label);
  return true;
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
  allowZero = false,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `stac.${name} must be an integer between ${allowZero ? 0 : 1} and ${maximum}.`,
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HonuaDiscoveryError("invalid-endpoint", "STAC JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new HonuaDiscoveryError("invalid-endpoint", "STAC metadata must contain JSON-compatible data only.");
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  if (!globalThis.crypto?.subtle) {
    throw new HonuaDiscoveryError("invalid-cache-identity", "Static STAC discovery requires Web Crypto SHA-256.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
