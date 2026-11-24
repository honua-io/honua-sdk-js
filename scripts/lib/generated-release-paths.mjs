export const GENERATED_FILES = new Set([
  "README.md", "bench/cross-sdk/corpus.json", "docs/bundle-sizes.md", "docs/comparison.md",
  "docs/errors.md", "docs/generated/mcp-eval-scorecard.md", "docs/generated/sample-catalog.md",
  "llms.txt", "llms-full.txt", "samples/catalog.v2.json",
  "samples/contract/v2/migrations/catalog.v1-to-v2.json", "samples/contract/v2/release-matrix-lanes.v1.json",
  ...[2, 3, 4].map((version) => `samples/contract/v2/consumer-fixtures/honua-site-consumer.v${version}.json`),
]);
export const GENERATED_PREFIXES = ["api-report/", "examples/migration-workbench/public/artifacts/",
  "examples/migration-workbench/src/generated/", "examples/ai-spatial-app-builder/evidence/",
  "examples/realtime-incident-dashboard/evidence/", "examples/spatial-analytics-workbench/evidence/",
  "samples/dist/", ...["imagery-cog-quickstart", "maplibre-quickstart", "migration-workbench", "service-explorer"]
    .map((name) => `samples/evidence/${name}/`)];

export function isGeneratedReleasePath(file) {
  return typeof file === "string" &&
    (GENERATED_FILES.has(file) || GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix)));
}
