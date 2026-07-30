const SHARED_KEYWORDS = ["gis", "geospatial", "maplibre", "typescript"];

// Keep these requirements aligned with the generated package metadata in
// prepare-split-packages.mjs. They are intentionally package-specific: a
// geometry package should not claim to be an ArcGIS migration package, while
// every split package should remain discoverable as part of the Honua GIS /
// MapLibre family.
const SPLIT_PACKAGE_RULES = {
  "@honua/sdk": {
    keywords: ["arcgis", "ogc-api", "stac", "geocoding"],
    descriptionTerms: ["arcgis", "ogc api", "stac", "maplibre"],
  },
  "@honua/sdk-esri-compat": {
    keywords: ["arcgis-migration", "esri"],
    descriptionTerms: ["arcgis", "migration", "maplibre"],
  },
  "@honua/geometry": {
    keywords: ["geometry", "reprojection"],
    descriptionTerms: ["geometry"],
  },
  "@honua/react": {
    keywords: ["react", "map"],
    descriptionTerms: ["react", "map"],
  },
  "@honua/app-platform": {
    keywords: ["app-platform", "webmap"],
    descriptionTerms: ["application-platform", "workspace"],
  },
};

export function splitPackageDiscoverabilityErrors(packageJson, expectedName) {
  const errors = [];
  const rule = SPLIT_PACKAGE_RULES[expectedName];
  const actualName = packageJson?.name ?? "<missing>";
  const description = typeof packageJson?.description === "string" ? packageJson.description : "";
  const keywords = Array.isArray(packageJson?.keywords) ? packageJson.keywords : [];

  if (!rule) {
    errors.push(`no discoverability rule exists for ${expectedName}`);
    return errors;
  }
  if (actualName !== expectedName) {
    errors.push(`package name is ${actualName}, expected ${expectedName}`);
  }
  for (const keyword of SHARED_KEYWORDS) {
    if (!keywords.includes(keyword)) {
      errors.push(`missing shared keyword ${keyword}`);
    }
  }
  for (const keyword of rule.keywords) {
    if (!keywords.includes(keyword)) {
      errors.push(`missing package keyword ${keyword}`);
    }
  }
  if (keywords.length > 15) {
    errors.push(`keyword list has ${keywords.length} entries; maximum is 15`);
  }
  for (const term of rule.descriptionTerms) {
    if (!description.toLocaleLowerCase().includes(term)) {
      errors.push(`description is missing discovery term ${term}`);
    }
  }
  return errors;
}
