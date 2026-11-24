#!/usr/bin/env node
// Vendors publication descriptor v1 (schema and examples) from honua-server.
//
//   node scripts/vendor-publication-descriptor.mjs update <commit>
//       copy the files from github.com/honua-io/honua-server at <commit> and rewrite the pin
//   node scripts/vendor-publication-descriptor.mjs check
//       fail unless every vendored file equals the server's file at the pinned commit

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "honua-io/honua-server";
const PIN = "config/publication-descriptor.v1.vendor.json";
const SCHEMA = { local: "config/publication-descriptor.v1.schema.json", source: "docs/gis/schemas/publication-descriptor.v1.schema.json" };
const EXAMPLES_SOURCE = "docs/gis/schemas/publication-descriptor.v1";
const EXAMPLES_LOCAL = "test/fixtures/publication/descriptor-v1";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function serverFile(commit, file) {
  const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${file}`);
  if (!response.ok) throw new Error(`${file} at ${commit}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function serverExampleNames(commit) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/contents/${EXAMPLES_SOURCE}/invalid?ref=${commit}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`listing invalid examples at ${commit}: HTTP ${response.status}`);
  return (await response.json()).map((entry) => entry.name).sort();
}

async function update(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("update needs a full 40-character commit SHA");
  const pairs = [
    SCHEMA,
    { local: `${EXAMPLES_LOCAL}/maui-county-parcels.json`, source: `${EXAMPLES_SOURCE}/maui-county-parcels.json` },
    ...(await serverExampleNames(commit)).map((name) => ({
      local: `${EXAMPLES_LOCAL}/invalid/${name}`,
      source: `${EXAMPLES_SOURCE}/invalid/${name}`,
    })),
  ];
  const files = {};
  for (const { local, source } of pairs) {
    const bytes = await serverFile(commit, source);
    mkdirSync(path.dirname(path.join(ROOT, local)), { recursive: true });
    writeFileSync(path.join(ROOT, local), bytes);
    files[local] = { source, sha256: sha256(bytes) };
  }
  writeFileSync(path.join(ROOT, PIN), `${JSON.stringify({ repository: REPOSITORY, commit, files }, null, 2)}\n`);
  process.stdout.write(`vendored ${pairs.length} files from ${REPOSITORY}@${commit}\n`);
}

async function check() {
  const pin = JSON.parse(readFileSync(path.join(ROOT, PIN), "utf8"));
  const drifted = [];
  for (const [local, { source, sha256: pinned }] of Object.entries(pin.files)) {
    const vendored = sha256(readFileSync(path.join(ROOT, local)));
    const server = sha256(await serverFile(pin.commit, source));
    if (vendored !== pinned || server !== pinned) drifted.push(`${local} (vendored ${vendored}, server ${server}, pin ${pinned})`);
  }
  if (drifted.length > 0) {
    process.stderr.write(`Vendored publication descriptor drifted from ${REPOSITORY}@${pin.commit}:\n  ${drifted.join("\n  ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`publicationDescriptorVendor=ok commit=${pin.commit} files=${Object.keys(pin.files).length}\n`);
}

const [command, argument] = process.argv.slice(2);
if (command === "update") await update(argument);
else if (command === "check") await check();
else throw new Error("usage: vendor-publication-descriptor.mjs update <commit> | check");
