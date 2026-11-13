// PMTiles output for the parcel pair: tippecanoe from its tagged source in
// Docker, then the publication stamp written into the archive metadata.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const TIPPECANOE_IMAGE = "honua-local/tippecanoe:2.79.0";
const TIPPECANOE_SOURCE = "https://github.com/felt/tippecanoe.git#2.79.0";

function ensureTippecanoeImage() {
  try {
    execFileSync("docker", ["image", "inspect", TIPPECANOE_IMAGE], { stdio: "ignore" });
  } catch {
    execFileSync("docker", ["build", "-t", TIPPECANOE_IMAGE, TIPPECANOE_SOURCE], { stdio: "inherit" });
  }
}

export function runTippecanoe({ features, directory, layer, minZoom, maxZoom }) {
  const inputName = "parcels.tiles.ndjson";
  const lines = features.map((feature) => JSON.stringify(feature));
  fs.writeFileSync(path.join(directory, inputName), `${lines.join("\n")}\n`);
  ensureTippecanoeImage();
  const mount = path.resolve(directory);
  execFileSync(
    "docker",
    [
      "run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-v", `${mount}:/work`, "-w", "/work",
      TIPPECANOE_IMAGE, "tippecanoe", "--force", "--quiet", "-o", "parcels.raw.pmtiles", "-l", layer,
      "-Z", String(minZoom), "-z", String(maxZoom), "--drop-densest-as-needed",
      "--extend-zooms-if-still-dropping", "--no-tile-stats", "-n", "Maui County parcels", inputName,
    ],
    { stdio: "inherit" },
  );
  fs.rmSync(path.join(directory, inputName));
  return path.join(directory, "parcels.raw.pmtiles");
}

const PMTILES_HEADER_BYTES = 127;

function readHeaderNumber(header, offset) {
  return Number(header.readBigUInt64LE(offset));
}

export function withPublicationMetadata(rawPath, publicationStamp, target) {
  const archive = fs.readFileSync(rawPath);
  const header = Buffer.from(archive.subarray(0, PMTILES_HEADER_BYTES));
  const section = (offset) => archive.subarray(readHeaderNumber(header, offset), readHeaderNumber(header, offset) + readHeaderNumber(header, offset + 8));
  const internalCompression = header[97];
  if (internalCompression !== 2) throw new Error(`Expected gzip PMTiles metadata, found compression ${internalCompression}`);
  const metadata = JSON.parse(gunzipSync(section(24)).toString("utf8"));
  metadata["honua:publication"] = publicationStamp;
  const metadataBytes = gzipSync(Buffer.from(JSON.stringify(metadata)), { level: 9 });
  const rootDirectory = section(8);
  const leafDirectories = section(40);
  const tileData = section(56);
  let cursor = PMTILES_HEADER_BYTES;
  for (const [offsetField, bytes] of [[8, rootDirectory], [24, metadataBytes], [40, leafDirectories], [56, tileData]]) {
    header.writeBigUInt64LE(BigInt(cursor), offsetField);
    header.writeBigUInt64LE(BigInt(bytes.length), offsetField + 8);
    cursor += bytes.length;
  }
  fs.writeFileSync(target, Buffer.concat([header, rootDirectory, metadataBytes, leafDirectories, tileData]));
  fs.rmSync(rawPath);
  return target;
}
