// Internal: reads the publication stamp an artifact embeds. Not re-exported from the package.

export const PUBLICATION_STAMP_KEY = "honua:publication";

/** Flat stamp keys a Honua server writes into an Export's GeoParquet key-value metadata and PMTiles metadata. */
export const EXPORT_STAMP_KEYS = Object.freeze({
  publicationId: "honua:exportId",
  version: "honua:publicationVersion",
  captureId: "honua:captureId",
});

/** The stamp an artifact carries: the `honua:publication` object, else the server's flat Export keys. */
export function readArtifactStamp(read: (key: string) => unknown): unknown {
  const combined = read(PUBLICATION_STAMP_KEY);
  if (combined !== undefined) return combined;
  const captureId = read(EXPORT_STAMP_KEYS.captureId);
  if (captureId === undefined) return undefined;
  return {
    publicationId: read(EXPORT_STAMP_KEYS.publicationId),
    version: read(EXPORT_STAMP_KEYS.version),
    captureId,
  };
}
