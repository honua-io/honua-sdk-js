import { createDataset } from "../contract/source.js";
import type { Dataset, Source, SourceDescriptor, SourceResolver } from "../contract/types.js";
import type { HonuaClient } from "../core/client.js";
import { GeoparquetRuntime } from "../geoparquet/index.js";
import type { Publication } from "./open.js";
import { type PublicationSourceOptions, publicationSource } from "./source.js";

/** Resolver for `createDataset` that serves the publication's query descriptor with the paired source. */
export function publicationResolver(
  publication: Publication,
  options: PublicationSourceOptions = {},
): SourceResolver & { readonly runtime: GeoparquetRuntime; dispose(): Promise<void> } {
  const runtime =
    options.runtime ?? new GeoparquetRuntime(options.driverFactory ? { driverFactory: options.driverFactory } : {});
  const resolve = (descriptor: SourceDescriptor): Source | undefined =>
    descriptor.protocol === "geoparquet" && descriptor.locator.url === publication.geoparquetUrl
      ? publicationSource(publication, { ...options, id: descriptor.id, runtime })
      : undefined;
  return Object.assign(resolve, { runtime, dispose: () => runtime.dispose() });
}

export interface PublicationDatasetOptions extends PublicationSourceOptions {
  readonly client: HonuaClient;
}

/** A Dataset with the publication's PMTiles display source and its paired GeoParquet query source. */
export function createPublicationDataset(
  publication: Publication,
  options: PublicationDatasetOptions,
): {
  readonly dataset: Dataset;
  readonly displaySourceId: string;
  readonly querySourceId: string;
  dispose(): Promise<void>;
} {
  const { client, ...sourceOptions } = options;
  const descriptors = publication.sourceDescriptors(options.id);
  const resolver = publicationResolver(publication, sourceOptions);
  const dataset = createDataset({
    id: publication.descriptor.publicationId,
    client,
    skipCompatibilityCheck: true,
    sources: [descriptors.display, descriptors.query],
    resolveSource: resolver,
  });
  return Object.freeze({
    dataset,
    displaySourceId: descriptors.display.id,
    querySourceId: descriptors.query.id,
    dispose: () => resolver.dispose(),
  });
}
