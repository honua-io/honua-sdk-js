const PUBLIC_GALLERY_TRACKS = Object.freeze([
  { track: "golden", title: "Golden journeys" },
  { track: "recipe", title: "Recipes" },
  { track: "lab", title: "Labs" },
]);

/**
 * Build the deterministic public-gallery model from the presentation-safe
 * catalog-v2 site projection. Internal fixture entries are intentionally not
 * public applications.
 */
export function createGalleryModel(siteProjection) {
  if (!siteProjection || !Array.isArray(siteProjection.samples)) {
    throw new TypeError("Gallery projection must contain a samples array.");
  }

  const groups = PUBLIC_GALLERY_TRACKS.map(({ track, title }) => ({
    track,
    title,
    samples: siteProjection.samples.filter((sample) => sample.track === track),
  })).filter((group) => group.samples.length > 0);
  const cardCount = groups.reduce((count, group) => count + group.samples.length, 0);

  if (cardCount === 0) {
    throw new Error("Gallery projection produced zero public cards; refusing to publish an empty gallery.");
  }

  return { cardCount, groups };
}
