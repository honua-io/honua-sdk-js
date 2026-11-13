import { type BrowserDriverOptions, createBrowserDuckDbDriver } from "../geoparquet/driver.js";
import { type DuckDbDriverFactory, GeoparquetRuntime } from "../geoparquet/index.js";

/**
 * Browser engine file settings for publication artifacts. CDNs commonly answer
 * a HEAD request that carries a Range header with 200 and the whole length, so
 * the engine sizes the file from a one-byte range request instead. The engine
 * would read the whole file from a host without range support; the paired
 * source refuses such a host with its own footer read before any engine query.
 */
export const PUBLICATION_ENGINE_FILESYSTEM = Object.freeze({
  reliableHeadRequests: false,
  allowFullHttpReads: true,
});

/** Browser engine for publication queries, opened with {@link PUBLICATION_ENGINE_FILESYSTEM}. */
export function publicationDriverFactory(
  options: Omit<BrowserDriverOptions, "filesystem" | "signal"> = {},
): DuckDbDriverFactory {
  return (lifecycle) =>
    createBrowserDuckDbDriver({ ...options, ...lifecycle, filesystem: PUBLICATION_ENGINE_FILESYSTEM });
}

export function publicationRuntime(options: {
  readonly runtime?: GeoparquetRuntime;
  readonly driverFactory?: DuckDbDriverFactory;
}): GeoparquetRuntime {
  return (
    options.runtime ?? new GeoparquetRuntime({ driverFactory: options.driverFactory ?? publicationDriverFactory() })
  );
}
