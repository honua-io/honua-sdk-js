import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  PUBLISHED_PACKAGE_RULES,
  publishedPackageDiscoverabilityErrors,
} from "./lib/package-discoverability.mjs";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const listing = fs.readFileSync(
  path.join(root, "docs", "listings", "maplibre-plugin-directory.md"),
  "utf8",
);

// Every package published from a committed manifest — the SDK, the MCP server,
// and the scaffold — not just the root one. A published package with no
// keywords is invisible in npm search however good its siblings' metadata is
// (honua-io/honua-sdk-js#499 REQ-004).
const metadataFailures = [];
for (const [name, rule] of Object.entries(PUBLISHED_PACKAGE_RULES)) {
  const manifestPath = path.join(root, rule.manifest);
  if (!fs.existsSync(manifestPath)) {
    metadataFailures.push(`${name}: manifest ${rule.manifest} does not exist`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const errors = publishedPackageDiscoverabilityErrors(manifest, name);

  // Declaring a license is not shipping one: Apache-2.0 asks distributions to
  // carry the license text. The `files` array is deliberately NOT checked — npm
  // always packs a LICENSE next to the manifest whether or not it is listed —
  // so the only thing that matters is that the file exists.
  const packageDir = path.dirname(manifestPath);
  if (manifest.license && !fs.existsSync(path.join(packageDir, "LICENSE"))) {
    errors.push(`declares license ${manifest.license} but ships no LICENSE file`);
  }

  if (errors.length > 0) {
    metadataFailures.push(`${rule.manifest} (${name}):\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  }
}
if (metadataFailures.length > 0) {
  throw new Error(`npm discoverability metadata is incomplete:\n${metadataFailures.join("\n")}`);
}

const requiredLinks = [
  "docs/listings/maplibre-plugin-directory.md",
  "docs/listings/npm-search-verification.md",
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
