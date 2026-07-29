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

if (!listing.includes("Status: **prepared, not filed**")) {
  throw new Error("ecosystem listing kit must state that external submissions are not filed by SDK CI");
}

console.log(`Discoverability metadata verified for ${packageJson.name}`);
