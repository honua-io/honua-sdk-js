export type CatalogItemKind = 'dataset' | 'layer' | 'service' | 'map' | 'app';
export type DatasetKind = 'feature-type' | 'coverage';
export type CatalogAccessLevel = 'public' | 'org' | 'private';
export type CatalogAudienceKind = 'public' | 'signed-in' | 'roles';
export type TemplateSlot = 'home' | 'search' | CatalogItemKind | 'category';
export type CatalogFacetKey = 'kind' | 'protocol' | 'folder' | 'tag' | 'owner' | 'category' | 'status';
export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';
export type CatalogItemStatus = 'active' | 'deprecated';

export interface ItemRef {
  readonly kind: CatalogItemKind;
  readonly id: string;
}

export interface CatalogSummary {
  readonly id: string;
  readonly title: string;
  readonly audience: CatalogAudienceKind;
  readonly publicHref: string;
}

export interface CatalogFeed {
  readonly format: 'records' | 'dcat' | 'dcat-ap' | 'schema-org';
  readonly href: string;
  readonly mediaType: string;
}

export interface CatalogBranding {
  readonly logo: { readonly href: string; readonly alt: string } | null;
  readonly lightAccent: string;
  readonly darkAccent: string;
}

export interface CatalogCategory {
  readonly id: string;
  readonly title: string;
  readonly count: number;
}

export interface CatalogView extends CatalogSummary {
  readonly description: string | null;
  readonly revision: string;
  readonly branding: CatalogBranding;
  readonly sections: readonly CatalogSection[];
  readonly categories: readonly CatalogCategory[];
  readonly feeds: readonly CatalogFeed[];
}

export interface CatalogSection {
  readonly id: string;
  readonly kind: 'search' | 'featured' | 'categories' | 'items';
  readonly title: string;
  readonly categoryId: string | null;
}

export interface CatalogThumbnail {
  readonly href: string;
  readonly alt: string;
  readonly source: 'generated' | 'upload' | 'placeholder';
  readonly width: number;
  readonly height: number;
}

export interface CatalogEndpoint {
  readonly protocol: string;
  readonly href: string;
  readonly mediaType: string | null;
}

export interface CatalogHealth {
  readonly status: HealthStatus;
  readonly observedAt: string | null;
  readonly uptimePercent: number | null;
  readonly windowHours: number | null;
}

export interface CatalogUsage {
  readonly requests: number;
  readonly windowHours: number;
  readonly asOf: string;
}

export interface CatalogItem extends ItemRef {
  readonly title: string;
  readonly summary: string | null;
  readonly owner: string;
  readonly access: CatalogAccessLevel;
  readonly created: string | null;
  readonly updated: string | null;
  readonly folder: { readonly id: string; readonly title: string } | null;
  readonly tags: readonly string[];
  readonly categories: readonly string[];
  readonly status: CatalogItemStatus;
  readonly datasetKind: DatasetKind | null;
  readonly spatial: boolean;
  readonly extent: readonly [number, number, number, number] | null;
  readonly temporalExtent: { readonly start: string | null; readonly end: string | null } | null;
  readonly detailHref: string;
  readonly launchHref: string | null;
  readonly releasedVersionId: string | null;
  readonly thumbnail: CatalogThumbnail;
  readonly endpoints: readonly CatalogEndpoint[];
  readonly health: CatalogHealth;
  readonly usage: CatalogUsage | null;
}

export interface CatalogFacet {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface CatalogPage {
  readonly catalogId: string;
  readonly revision: string;
  readonly items: readonly CatalogItem[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly facets: Readonly<Record<CatalogFacetKey, readonly CatalogFacet[]>>;
}

export interface CatalogItemDetail extends CatalogItem {
  readonly description: string | null;
  readonly feeds: readonly CatalogFeed[];
  readonly relations: readonly { readonly relation: 'uses' | 'used-by' | 'layers'; readonly href: string }[];
  readonly replacement: ItemRef | null;
  readonly metadataHref: string | null;
}

export interface CatalogSearch {
  readonly q?: string;
  readonly kind?: readonly CatalogItemKind[];
  readonly protocol?: readonly string[];
  readonly folderId?: string;
  readonly tag?: readonly string[];
  readonly owner?: readonly string[];
  readonly category?: readonly string[];
  readonly status?: CatalogItemStatus;
  readonly bbox?: readonly [number, number, number, number];
  readonly datetime?: string;
  readonly sort?: 'title' | '-updated';
  readonly offset?: number;
  readonly limit?: number;
}

export type CatalogOverride<T> =
  | { readonly mode: 'inherit' }
  | { readonly mode: 'set'; readonly value: T }
  | { readonly mode: 'clear' };

export interface CatalogAppearance {
  readonly title: CatalogOverride<string>;
  readonly summary: CatalogOverride<string>;
  readonly thumbnailAssetId: CatalogOverride<string>;
  readonly thumbnailAlt: CatalogOverride<string>;
}

export interface CatalogMembership {
  readonly item: ItemRef;
  readonly inclusion: 'scope' | 'include' | 'exclude';
  readonly hiddenHere: boolean;
  readonly categoryIds: readonly string[];
  readonly featuredPosition: number | null;
  readonly approvedItemRevision: string | null;
  readonly appearance: CatalogAppearance | null;
}

export interface CatalogConfig {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly revision: string;
  readonly audience: { readonly kind: CatalogAudienceKind; readonly roleIds: readonly string[] };
  readonly scope: {
    readonly folderIds: readonly string[];
    readonly tags: readonly string[];
    readonly kinds: readonly CatalogItemKind[];
  };
  readonly defaultListing: 'automatic' | 'after-review' | 'manual';
  readonly branding: CatalogBranding;
  readonly hostName: string | null;
  readonly allowedEmbedOrigins: readonly string[];
  readonly sections: readonly CatalogSection[];
  readonly categories: readonly {
    readonly id: string;
    readonly title: string;
    readonly tags: readonly string[];
    readonly items: readonly ItemRef[];
  }[];
  readonly feeds: { readonly formats: readonly CatalogFeed['format'][]; readonly indexing: boolean };
  readonly templates: readonly { readonly slot: TemplateSlot; readonly contentId: string; readonly versionId: string }[];
  readonly memberships: readonly CatalogMembership[];
}

export interface CatalogListingAdmin {
  readonly item: ItemRef;
  readonly canAppearInCatalogs: boolean;
  readonly itemRevision: string;
  readonly catalogs: readonly {
    readonly catalogId: string;
    readonly reason: 'scope' | 'manual' | 'excluded' | 'awaiting-review' | 'hidden-here' | 'opted-out';
    readonly audienceEligible: boolean;
    readonly categoryIds: readonly string[];
    readonly featuredPosition: number | null;
  }[];
}

export interface CatalogTemplate {
  readonly contentId: string;
  readonly title: string;
  readonly slot: TemplateSlot;
  readonly revision: string;
  readonly draftId: string | null;
  readonly releasedVersionId: string | null;
  readonly proposalId: string | null;
  readonly componentBundleDigest: string;
}

export interface CatalogOverview {
  readonly catalogId: string;
  readonly revision: string;
  readonly counts: {
    readonly listed: number;
    readonly audienceRestricted: number;
    readonly hiddenHere: number;
    readonly optedOut: number;
    readonly matched: number;
  };
  readonly needsAttention: readonly { readonly item: ItemRef; readonly reasons: readonly string[] }[];
}
