import type { HonuaClient } from "../core/client.js";

export type CoverageScalar = string | number;

export interface CoverageLink {
  readonly href: string;
  readonly rel: string;
  readonly type?: string;
  readonly title?: string;
}

export interface CoverageLandingPage {
  readonly title: string;
  readonly description?: string;
  readonly links: readonly CoverageLink[];
}

export interface CoverageConformance {
  readonly conformsTo: readonly string[];
  readonly links?: readonly CoverageLink[];
}

export interface CoverageCollection {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly itemType?: string;
  readonly extent?: Readonly<Record<string, unknown>>;
  readonly links: readonly CoverageLink[];
  readonly crs?: readonly string[];
  readonly storageCrs?: string;
  readonly grid?: Readonly<Record<string, unknown>>;
  readonly domain?: Readonly<Record<string, unknown>>;
  readonly defaultFields?: readonly string[];
  readonly [key: string]: unknown;
}

export interface CoverageCollections {
  readonly collections: readonly CoverageCollection[];
  readonly links: readonly CoverageLink[];
}

export interface CoverageServiceDescription {
  readonly landing: CoverageLandingPage;
  readonly conformance: CoverageConformance;
  readonly collections: readonly CoverageCollection[];
}

export interface CoverageAxis {
  readonly name: string;
  readonly lower?: CoverageScalar;
  readonly upper?: CoverageScalar;
  readonly values?: readonly CoverageScalar[];
  readonly resolution?: number;
  readonly raw?: unknown;
}

export interface CoverageDomainSet {
  readonly collectionId: string;
  readonly crs?: string;
  readonly bbox?: readonly number[];
  readonly axes: readonly CoverageAxis[];
  readonly grid?: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CoverageRangeField {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly dataType?: string;
  readonly noData?: readonly CoverageScalar[];
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CoverageRangeType {
  readonly collectionId: string;
  readonly fields: readonly CoverageRangeField[];
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CoverageAxisSubset {
  readonly axis: string;
  readonly low: CoverageScalar;
  readonly high?: CoverageScalar;
}

export type CoverageFormat = "image/tiff" | "image/png";

export interface CoverageScaleSize {
  readonly width: number;
  readonly height: number;
}

export interface CoverageRequest {
  readonly bbox?: readonly [number, number, number, number];
  readonly bboxCrs?: string;
  readonly outputCrs?: string;
  readonly subsets?: readonly CoverageAxisSubset[];
  readonly datetime?: string;
  readonly properties?: readonly string[];
  readonly resolution?: number | readonly [number, number];
  readonly scaleFactor?: number;
  readonly scaleSize?: CoverageScaleSize;
  readonly format?: CoverageFormat;
  readonly maxResponseBytes?: number;
  readonly allowFullCoverage?: boolean;
  readonly signal?: AbortSignal;
}

export interface CoverageResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly contentDisposition?: string;
  readonly requestUrl: string;
}

export interface CoverageClientOptions {
  /** OGC API Coverages service root. Defaults to Honua Server's `/ogc/coverages`. */
  readonly basePath?: string;
  /** Default coverage body ceiling. Defaults to 32 MiB. */
  readonly maxResponseBytes?: number;
  /** Discovery/schema body ceiling. Defaults to 2 MiB. */
  readonly maxMetadataResponseBytes?: number;
}

export interface CoverageSource {
  readonly id: string;
  collection(options?: { readonly signal?: AbortSignal }): Promise<CoverageCollection>;
  domainSet(options?: { readonly signal?: AbortSignal }): Promise<CoverageDomainSet>;
  rangeType(options?: { readonly signal?: AbortSignal }): Promise<CoverageRangeType>;
  coverage(request: CoverageRequest): Promise<CoverageResult>;
}

export interface WcsClientOptions {
  /** WCS KVP endpoint, for example `/ogc/services/7/wcs`. */
  readonly basePath: string;
  readonly version?: "2.0.1";
  readonly maxResponseBytes?: number;
  readonly maxMetadataResponseBytes?: number;
}

export interface WcsCapabilitiesRequest {
  readonly acceptVersions?: readonly string[];
  readonly sections?: readonly string[];
  readonly acceptFormats?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface WcsCapabilities {
  readonly version: string;
  readonly title?: string;
  readonly operations: readonly string[];
  readonly coverageIds: readonly string[];
  readonly formats: readonly string[];
  readonly crs: readonly string[];
  readonly rawXml: string;
}

export interface WcsCoverageDescription {
  readonly coverageId: string;
  readonly crs?: string;
  readonly axisLabels: readonly string[];
  readonly lowerCorner?: readonly CoverageScalar[];
  readonly upperCorner?: readonly CoverageScalar[];
  readonly fields: readonly CoverageRangeField[];
  readonly noData: readonly CoverageScalar[];
  readonly rawXml: string;
}

export type WcsFormat = "image/tiff" | "image/png" | "image/jpeg";

export interface WcsGetCoverageRequest {
  readonly bbox?: readonly [number, number, number, number];
  readonly bboxCrs?: string;
  readonly subsets?: readonly CoverageAxisSubset[];
  readonly subsettingCrs?: string;
  readonly outputCrs?: string;
  readonly rangeSubset?: readonly string[];
  readonly scaleSize?: Readonly<Record<string, number>>;
  readonly scaleFactor?: number;
  readonly scaleAxes?: Readonly<Record<string, number>>;
  readonly scaleExtent?: readonly CoverageAxisSubset[];
  readonly interpolation?: string;
  readonly datetime?: string;
  readonly format?: WcsFormat;
  readonly maxResponseBytes?: number;
  readonly allowFullCoverage?: boolean;
  readonly signal?: AbortSignal;
}

export interface MapLibreImageSourceLike {
  readonly type: "image";
  readonly url: string;
  readonly coordinates: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
}

export interface MapLibreRasterLayerLike {
  readonly id: string;
  readonly type: "raster";
  readonly source: string;
}

export interface CoverageMapLibreImage {
  readonly sourceId: string;
  readonly source: MapLibreImageSourceLike;
  readonly layer: MapLibreRasterLayerLike;
  dispose(): void;
}

/** Structural dependency retained in the public types for auth/interceptor-aware construction. */
export type CoverageHonuaClient = Pick<HonuaClient, "serverBaseUrl" | "pipelineFetch">;
