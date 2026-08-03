import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const listing = fs.readFileSync(
  path.join(root, "docs", "listings", "maplibre-plugin-directory.md"),
  "utf8",
);

const requiredKeywords = ["maplibre", "arcgis-migration", "ogc-api", "stac", "geocoding"];
const missingKeywords = requiredKeywords.filter((keyword) => !packageJson.keywords?.includes(keyword));
if (missingKeywords.length > 0) {
  throw new Error(`package.json is missing discoverability keywords: ${missingKeywords.join(", ")}`);
}

const requiredPackageFields = ["description", "homepage", "repository", "bugs"];
const missingPackageFields = requiredPackageFields.filter((field) => !packageJson[field]);
if (missingPackageFields.length > 0) {
  throw new Error(`package.json is missing discoverability fields: ${missingPackageFields.join(", ")}`);
}

const requiredLinks = [
  "docs/listings/maplibre-plugin-directory.md",
  "examples/maplibre-quickstart/",
  "docs/comparison.md",
];
const missingLinks = requiredLinks.filter((link) => !readme.includes(link));
if (missingLinks.length > 0) {
  throw new Error(`README is missing discoverability links: ${missingLinks.join(", ")}`);
}

// The listing kit doubles as the external-submission ledger. It must keep
// saying that this repository never files submissions itself, and every ledger
// row must carry a real state, so the kit cannot drift into implying an
// acceptance that never happened (honua-io/honua-sdk-js#499).
if (!/SDK CI never files anything/.test(listing)) {
  throw new Error("ecosystem listing kit must state that external submissions are never filed by SDK CI");
}

const afterLedgerHeading = listing.split("## Submission ledger")[1];
if (!afterLedgerHeading) {
  throw new Error("ecosystem listing kit must carry a '## Submission ledger' section recording each external submission");
}
// Stop at the next top-level heading so a later section's tables cannot be
// mistaken for ledger rows.
const ledgerSection = afterLedgerHeading.split(/^## /m)[0];

const ledgerRows = ledgerSection
  .split(/\r?\n/)
  .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line))
  .slice(1) // drop the header row
  .map((line) => line.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0));

if (ledgerRows.length === 0) {
  throw new Error("submission ledger must list at least one external target");
}

for (const [target, submission, state] of ledgerRows) {
  if (!submission || !/\bhttps?:\/\//.test(submission)) {
    throw new Error(`submission ledger row "${target}" must link the actual submission`);
  }
  if (!state || !/merged|open|closed|declined/i.test(state)) {
    throw new Error(`submission ledger row "${target}" must record a real state (merged/open/closed/declined), got "${state ?? ""}"`);
  }
}

console.log(`Discoverability metadata verified for ${packageJson.name}`);
