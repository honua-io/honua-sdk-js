export interface DuckDbExtensionProvenance {
  readonly engineVersion: string;
  readonly platform: string;
  readonly fileName: string;
  readonly sourceUrl: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly wasmMagic: readonly number[];
}

export interface ExtensionCacheFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, bytes: Uint8Array, options: { flag: "wx"; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ExtensionFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly redirected: boolean;
  readonly url: string;
  readonly headers?: { get(name: string): string | null };
  readonly body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
      releaseLock(): void;
    };
  };
}

export type ExtensionFetch = (
  url: string,
  init: {
    readonly headers: { readonly accept: "application/wasm" };
    readonly redirect: "error";
    readonly signal: AbortSignal;
  },
) => Promise<ExtensionFetchResponse>;

export const PARQUET_EXTENSION_PROVENANCE: Readonly<DuckDbExtensionProvenance>;

export function validatePinnedParquetExtension(
  bytes: Uint8Array,
  provenance?: DuckDbExtensionProvenance,
): Readonly<{ byteLength: number; sha256: string }>;

export function resolveParquetExtensionCachePath(options: {
  repoRoot: string;
  provenance?: DuckDbExtensionProvenance;
}): string;

export function readPinnedParquetExtension(options: {
  cachePath: string;
  fsImpl?: ExtensionCacheFileSystem;
  provenance?: DuckDbExtensionProvenance;
}): Promise<Readonly<{ cachePath: string; bytes: Uint8Array; byteLength: number; sha256: string }>>;

export function ensurePinnedParquetExtension(options: {
  cachePath: string;
  fsImpl?: ExtensionCacheFileSystem;
  fetchImpl?: ExtensionFetch;
  offline?: boolean;
  timeoutMs?: number;
  provenance?: DuckDbExtensionProvenance;
}): Promise<
  Readonly<{
    cachePath: string;
    bytes: Uint8Array;
    byteLength: number;
    sha256: string;
    status: "cache-hit" | "downloaded" | "replaced";
  }>
>;
