import type { HonuaClient } from "../core/client.js";

/** Storage backends accepted by Honua Server's versioned Zarr registration API. */
export type ZarrStorageProvider = "AwsS3" | "AzureBlob" | "Local";

export interface RegisterZarrStoreRequest {
  readonly layerId: number;
  readonly name: string;
  readonly description?: string;
  readonly provider: ZarrStorageProvider;
  readonly bucket: string;
  readonly rootPath: string;
}

export interface ZarrVariableMetadata {
  readonly name: string;
  readonly shape: readonly number[];
  readonly chunks: readonly number[];
  readonly dataType: string;
  readonly compressor: string | null;
  readonly dimensionNames: readonly string[];
}

/** Metadata returned by `/api/v1/admin/zarr-stores`. */
export interface ZarrStoreRegistration {
  readonly id: number;
  readonly layerId: number;
  readonly name: string;
  readonly description: string | null;
  readonly provider: ZarrStorageProvider;
  readonly bucket: string;
  readonly rootPath: string;
  readonly zarrFormat: 2 | 3 | null;
  readonly srid: number | null;
  readonly variableCount: number | null;
  readonly primaryVariable: string | null;
  readonly variables: readonly ZarrVariableMetadata[] | null;
  readonly metadataScannedAt: string | null;
  readonly createdAt: string;
}

export type ZarrMaturityFailureCode =
  | "metadata-pending"
  | "unsupported-version"
  | "unsupported-codec"
  | "unsupported-dtype"
  | "ambiguous-dimensions";

export interface ZarrMaturityFailure {
  readonly code: ZarrMaturityFailureCode;
  readonly message: string;
  readonly variable?: string;
}

/**
 * Client-side interpretation of the server's experimental Zarr contract.
 * Direct object-store reads are deliberately not implied by this status.
 */
export interface ZarrMaturityAssessment {
  readonly maturity: "experimental";
  readonly metadata: "ready" | "pending";
  readonly serverTileHandoff: "ready" | "unavailable";
  readonly directObjectStoreRead: "unavailable";
  readonly failures: readonly ZarrMaturityFailure[];
}

export interface ZarrTileRequest {
  readonly layerId: number;
  readonly tileMatrixSetId: string;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly variable?: string;
  readonly datetime?: string;
  /** Non-negative grid index for the vertical axis. */
  readonly elevation?: number;
  /** Response ceiling. Defaults to 2 MiB. */
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ZarrTileResult {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png";
  readonly requestUrl: string;
}

export interface ZarrClientOptions {
  /** Versioned admin base path. Defaults to `/api/v1/admin/zarr-stores`. */
  readonly adminBasePath?: string;
  /** Versioned public datacube base path. Defaults to `/api/v1/datacubes`. */
  readonly datacubeBasePath?: string;
  /** Registration/metadata response ceiling. Defaults to 2 MiB. */
  readonly maxMetadataResponseBytes?: number;
  /** Tile response ceiling. Defaults to 2 MiB. */
  readonly maxTileResponseBytes?: number;
}

/** Structural dependency that preserves HonuaClient auth, cancellation, retry, and interceptors. */
export type ZarrHonuaClient = Pick<HonuaClient, "serverBaseUrl" | "pipelineFetch">;
