export interface CatalogCardProjection {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string | null;
  readonly detailHref: string;
  readonly datasetKind?: string | null;
  readonly spatial?: boolean;
  readonly thumbnail?: { readonly href: string; readonly alt: string } | null;
  readonly health?: { readonly status: string } | null;
  readonly releasedVersionId: string | null;
  readonly structuredData?: CatalogStructuredData;
}

export interface CatalogStructuredData {
  readonly "@context": Readonly<Record<string, string>>;
  readonly "@graph": readonly Readonly<Record<string, unknown>>[];
}

export interface CatalogSearchQuery {
  readonly catalogId: string;
  readonly q?: string;
  readonly kind?: readonly string[];
  readonly category?: readonly string[];
  readonly sort?: "title" | "-updated";
  readonly offset?: number;
  readonly limit?: number;
}

export interface CatalogSearchProjection {
  readonly items: readonly CatalogCardProjection[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly facets: Readonly<
    Record<string, readonly { readonly value: string; readonly label: string; readonly count: number }[]>
  >;
  readonly structuredData?: CatalogStructuredData;
}

/** Presentation-only seam for draft fixtures; live binding awaits the canonical catalog client. */
export interface CatalogComponentClient {
  listCatalog(query: CatalogSearchQuery, options?: { readonly signal?: AbortSignal }): Promise<CatalogSearchProjection>;
  getCatalogItem(
    identity: { readonly catalogId: string; readonly kind: string; readonly id: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<CatalogCardProjection>;
}
