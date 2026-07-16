import type { DiscoveryCacheIdentity } from "./contract/discovery.js";
import type {
  CrsDefinition,
  JsonObject,
  MetadataProvenance,
  SpatialExtent,
  TemporalExtent,
} from "./contract/schema.js";
import type { SourceLocator } from "./contract/types.js";

/** HTTP implementation accepted by static STAC discovery. */
export type StacDiscoveryFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Caller-tunable limits. Every value is also capped by an SDK hard maximum. */
export interface StacDiscoveryLimits {
  /** Maximum STAC documents read, including the root. Defaults to 128. */
  readonly maxDocuments?: number;
  /** Maximum child/item link depth below the root. Defaults to 12. */
  readonly maxDepth?: number;
  /** Maximum relevant links retained from one document. Defaults to 512. */
  readonly maxLinksPerDocument?: number;
  /** Maximum assets normalized across the traversal. Defaults to 1,000. */
  readonly maxAssets?: number;
  /** Maximum UTF-8 bytes accepted for one STAC JSON document. Defaults to 1 MiB. */
  readonly maxJsonBytes?: number;
  /** Maximum bytes read by one asset probe. Defaults to 64 KiB. */
  readonly maxProbeBytes?: number;
  /** Per-request deadline in milliseconds. Defaults to 10 seconds. */
  readonly requestTimeoutMs?: number;
  /** Maximum same-policy redirects followed per request. Defaults to 5. */
  readonly maxRedirects?: number;
}

/** Static STAC discovery input. */
export interface DiscoverStaticStacOptions {
  /** Absolute HTTP(S) URL of a Catalog, Collection, or Item JSON document. */
  readonly endpoint: string | URL;
  /** Stable ACL/audience fingerprint. Raw credentials are prohibited. Defaults to `public`. */
  readonly authorizationScopeFingerprint?: string;
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  readonly fetchFn?: StacDiscoveryFetch;
  /** Headers sent only to the root origin. Sensitive values are never retained in results. */
  readonly headers?: HeadersInit;
  /** Additional origins whose STAC JSON links may be traversed. */
  readonly allowedOrigins?: readonly string[];
  /** Origins whose assets may receive bounded format probes. The root origin is allowed by default. */
  readonly probeOrigins?: readonly string[];
  /** Disable all asset byte probes while retaining metadata-only classification. Defaults to true. */
  readonly probeAssets?: boolean;
  readonly limits?: StacDiscoveryLimits;
  readonly signal?: AbortSignal;
}

export type StacDocumentType = "catalog" | "collection" | "item";
export type StacAssetFormat = "cog" | "geoparquet" | "pmtiles" | "tiles" | "metadata";
export type StacAssetClassificationState = "classified" | "ambiguous" | "unsupported";

export type StacAssetEvidenceCode =
  | "media-type"
  | "asset-role"
  | "extension-field"
  | "tile-template"
  | "probe-magic"
  | "probe-metadata"
  | "probe-conflict"
  | "probe-skipped";

/** One credential-free explanation for or against an asset format. */
export interface StacAssetClassificationEvidence {
  readonly code: StacAssetEvidenceCode;
  readonly format?: StacAssetFormat;
  readonly strength: "conclusive" | "supporting" | "contradicting" | "informational";
  readonly detail: string;
}

export interface StacAssetClassification {
  readonly state: StacAssetClassificationState;
  readonly format?: StacAssetFormat;
  /** Plausible formats retained when evidence is insufficient or conflicting. */
  readonly candidates: readonly StacAssetFormat[];
  readonly confidence?: "declared" | "verified";
  readonly tileLayout?: "tilejson" | "template";
  readonly tileContent?: "vector" | "raster" | "unknown";
  readonly evidence: readonly StacAssetClassificationEvidence[];
  readonly reason: string;
}

/** Existing SDK adapter coordinates emitted only when classification is safe and actionable. */
export interface StacCandidateSourceLocator {
  readonly protocol: "pmtiles" | "geoparquet" | "maplibre-vector" | "maplibre-raster";
  readonly locator: Readonly<SourceLocator>;
  /** Extra runtime needed after discovery, if any. */
  readonly requirement?: "geoparquet-profiler" | "pmtiles-runtime";
}

export interface StacProvider {
  readonly name: string;
  readonly description?: string;
  readonly roles: readonly string[];
  readonly url?: string;
}

export interface StacLicense {
  readonly expression: string;
  readonly links: readonly string[];
}

export interface StacAssetCandidate {
  /** Stable document/asset identity; never includes URL credentials. */
  readonly id: string;
  readonly documentId: string;
  readonly collectionId?: string;
  readonly itemId?: string;
  readonly key: string;
  /** Credential-free normalized asset URL. */
  readonly href: string;
  /** Direct means the URL can enter an SDK locator; resolver-required means it contains query auth/identity. */
  readonly access: "direct" | "resolver-required";
  readonly title?: string;
  readonly description?: string;
  readonly mediaType?: string;
  readonly roles: readonly string[];
  readonly classification: StacAssetClassification;
  readonly source?: StacCandidateSourceLocator;
  readonly crs?: CrsDefinition;
  readonly extent: SpatialExtent;
  readonly temporalExtent: TemporalExtent;
  readonly license?: StacLicense;
  readonly attribution?: string;
  readonly providers: readonly StacProvider[];
  readonly provenance: readonly MetadataProvenance[];
  /** Bounded namespaced STAC fields retained without interpreting unknown extensions. */
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface StacDiscoveredDocument {
  readonly documentType: StacDocumentType;
  readonly id: string;
  readonly url: string;
  readonly stacVersion: string;
  readonly collectionId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly crs?: CrsDefinition;
  readonly extent: SpatialExtent;
  readonly temporalExtent: TemporalExtent;
  readonly license?: StacLicense;
  readonly attribution?: string;
  readonly providers: readonly StacProvider[];
  readonly stacExtensions: readonly string[];
  readonly provenance: readonly MetadataProvenance[];
  readonly assets: readonly StacAssetCandidate[];
}

export type StacDiscoveryDiagnosticCode =
  | "link-loop"
  | "cross-origin-link"
  | "unsafe-url"
  | "unsupported-link-media-type"
  | "document-unreadable"
  | "document-invalid"
  | "document-limit"
  | "depth-limit"
  | "link-limit"
  | "asset-limit"
  | "asset-invalid"
  | "asset-probe-skipped"
  | "asset-probe-failed"
  | "asset-ambiguous"
  | "asset-unsupported";

/** Safe diagnostic. Messages and coordinates never include request URLs or credential values. */
export interface StacDiscoveryDiagnostic {
  readonly code: StacDiscoveryDiagnosticCode;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly documentId?: string;
  readonly assetKey?: string;
  readonly relation?: string;
}

export interface StaticStacDiscoveryStatistics {
  readonly documentsRead: number;
  readonly assetsRead: number;
  readonly requests: number;
  readonly redirects: number;
  readonly bytesRead: number;
  readonly probeBytesRead: number;
}

export interface StaticStacDiscoveryResult {
  readonly root: StacDiscoveredDocument;
  readonly documents: readonly StacDiscoveredDocument[];
  readonly assets: readonly StacAssetCandidate[];
  readonly diagnostics: readonly StacDiscoveryDiagnostic[];
  readonly cacheIdentity: DiscoveryCacheIdentity;
  readonly retrievedAt: string;
  readonly statistics: StaticStacDiscoveryStatistics;
}

/** Internal JSON object alias used by bounded extension snapshots. */
export type StacJsonObject = JsonObject;
