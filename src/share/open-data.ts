/**
 * Browser-safe open-data read projections and DCAT / Schema.org helper shapes.
 *
 * Generated apps and embeds frequently render an open-data landing card for a
 * public-indexed item and need a stable, anonymous-safe shape plus a way to
 * emit standards-aligned metadata (DCAT distributions, a Schema.org `Dataset`
 * JSON-LD block) from an already-fetched server response. These helpers do not
 * fetch or publish — they project a presentation read model the browser already
 * holds into the shared vocabulary, so Console JS interop and generated apps
 * agree on field names.
 *
 * The DCAT / Schema.org output follows the public DCAT (W3C / DCAT-AP) and
 * Schema.org `Dataset` vocabularies. When honua-server's open-data publication
 * API lands its own projection, prefer the server-emitted document; this helper
 * remains the browser fallback for responses that only carry the read model.
 *
 * @module
 */

import type { HonuaShareItemType } from "./types.js";

/** A downloadable/queryable distribution of an open-data item. */
export interface HonuaOpenDataDistribution {
  /** Stable id of the distribution within the item. */
  readonly id?: string;
  /** Human title of the distribution (e.g. "GeoJSON download"). */
  readonly title?: string;
  /** IANA media type (e.g. `application/geo+json`). */
  readonly mediaType?: string;
  /** Short format label (e.g. `GeoJSON`, `CSV`, `OGC API - Features`). */
  readonly format?: string;
  /** Direct download URL, when the distribution is a file. */
  readonly downloadUrl?: string;
  /** Access URL for service/API distributions (non-file). */
  readonly accessUrl?: string;
}

/**
 * Anonymous-safe open-data read projection for a public-indexed item. Presents
 * only fields safe to expose on an open-data landing surface.
 */
export interface HonuaOpenDataReadProjection {
  readonly itemId: string;
  readonly itemType: HonuaShareItemType;
  readonly title: string;
  readonly summary?: string;
  /** Keyword/theme tags. */
  readonly keywords?: readonly string[];
  /** License identifier or URL, when published. */
  readonly license?: string;
  /** Publishing organization/attribution, when set. */
  readonly publisher?: string;
  /** ISO-8601 timestamp the item was last modified, when known. */
  readonly modified?: string;
  /** Landing-page URL for the item on the open-data surface. */
  readonly landingPageUrl?: string;
  /** Distributions the item is available through. */
  readonly distributions?: readonly HonuaOpenDataDistribution[];
}

/** A DCAT distribution object (`dcat:Distribution`). */
export interface DcatDistribution {
  readonly "@type": "dcat:Distribution";
  readonly title?: string;
  readonly mediaType?: string;
  readonly format?: string;
  readonly downloadURL?: string;
  readonly accessURL?: string;
}

/** A DCAT dataset object (`dcat:Dataset`) for an open-data item. */
export interface DcatDataset {
  readonly "@type": "dcat:Dataset";
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly keyword?: readonly string[];
  readonly license?: string;
  readonly publisher?: string;
  readonly modified?: string;
  readonly landingPage?: string;
  readonly distribution?: readonly DcatDistribution[];
}

/** A Schema.org `DataDownload` node. */
export interface SchemaOrgDataDownload {
  readonly "@type": "DataDownload";
  readonly name?: string;
  readonly encodingFormat?: string;
  readonly contentUrl?: string;
}

/** A Schema.org `Dataset` JSON-LD node for an open-data item. */
export interface SchemaOrgDataset {
  readonly "@context": "https://schema.org";
  readonly "@type": "Dataset";
  readonly identifier: string;
  readonly name: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly license?: string;
  readonly publisher?: { readonly "@type": "Organization"; readonly name: string };
  readonly dateModified?: string;
  readonly url?: string;
  readonly distribution?: readonly SchemaOrgDataDownload[];
}

function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    out[key] = val;
  }
  return out as T;
}

/**
 * Projects a browser-held open-data read projection into a `dcat:Dataset`
 * object. Omits unset/empty fields so the emitted document is minimal.
 */
export function toDcatDataset(projection: HonuaOpenDataReadProjection): DcatDataset {
  const distribution = projection.distributions?.map((d) =>
    compact<DcatDistribution>({
      "@type": "dcat:Distribution",
      title: d.title,
      mediaType: d.mediaType,
      format: d.format,
      downloadURL: d.downloadUrl,
      accessURL: d.accessUrl,
    }),
  );
  return compact<DcatDataset>({
    "@type": "dcat:Dataset",
    identifier: projection.itemId,
    title: projection.title,
    description: projection.summary,
    keyword: projection.keywords,
    license: projection.license,
    publisher: projection.publisher,
    modified: projection.modified,
    landingPage: projection.landingPageUrl,
    distribution,
  });
}

/**
 * Projects a browser-held open-data read projection into a Schema.org `Dataset`
 * JSON-LD node, suitable for injection into a `<script type="application/ld+json">`
 * block on an open-data landing page. Omits unset/empty fields.
 */
export function toSchemaOrgDataset(projection: HonuaOpenDataReadProjection): SchemaOrgDataset {
  const distribution = projection.distributions?.map((d) =>
    compact<SchemaOrgDataDownload>({
      "@type": "DataDownload",
      name: d.title,
      encodingFormat: d.mediaType ?? d.format,
      contentUrl: d.downloadUrl ?? d.accessUrl,
    }),
  );
  return compact<SchemaOrgDataset>({
    "@context": "https://schema.org",
    "@type": "Dataset",
    identifier: projection.itemId,
    name: projection.title,
    description: projection.summary,
    keywords: projection.keywords,
    license: projection.license,
    publisher: projection.publisher ? { "@type": "Organization", name: projection.publisher } : undefined,
    dateModified: projection.modified,
    url: projection.landingPageUrl,
    distribution,
  });
}
