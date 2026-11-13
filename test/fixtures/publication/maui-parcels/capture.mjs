import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PAGE_SIZE = 500;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchJson(url, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: body ? "POST" : "GET",
        ...(body ? { body: new URLSearchParams(body), headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      const document = await response.json();
      if (document.error) throw new Error(`Source error from ${url}: ${JSON.stringify(document.error)}`);
      return document;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}

async function readLayerState(sourceUrl) {
  const metadata = await fetchJson(`${sourceUrl}?f=json`);
  const ids = await fetchJson(`${sourceUrl}/query`, { where: "1=1", returnIdsOnly: "true", f: "json" });
  const objectIds = [...ids.objectIds].sort((a, b) => a - b);
  return {
    metadata,
    objectIds,
    metadataSha256: sha256(JSON.stringify(metadata)),
    idsSha256: sha256(objectIds.join(",")),
  };
}

export async function capture({ source, out }, publicFields) {
  if (!source || !out) throw new Error("capture needs --source and --out");
  fs.mkdirSync(out, { recursive: true });
  const before = await readLayerState(source);
  const outFields = ["objectid", ...publicFields.map((field) => field.name)].join(",");
  const lines = [];
  for (let start = 0; start < before.objectIds.length; start += PAGE_SIZE) {
    const page = before.objectIds.slice(start, start + PAGE_SIZE);
    const collection = await fetchJson(`${source}/query`, {
      objectIds: page.join(","),
      outFields,
      outSR: "4326",
      returnGeometry: "true",
      f: "geojson",
    });
    if (collection.features.length !== page.length) {
      throw new Error(`Page at ${start} returned ${collection.features.length} of ${page.length} features`);
    }
    for (const feature of collection.features) lines.push(JSON.stringify(feature));
    process.stdout.write(`captured ${Math.min(start + PAGE_SIZE, before.objectIds.length)}/${before.objectIds.length}\r`);
  }
  const after = await readLayerState(source);
  if (after.idsSha256 !== before.idsSha256 || after.metadataSha256 !== before.metadataSha256) {
    throw new Error("The source layer changed while it was captured; run the capture again.");
  }
  const features = `${lines.sort(byObjectId).join("\n")}\n`;
  fs.writeFileSync(path.join(out, "capture.ndjson"), features);
  const record = {
    captureId: `sha256:${sha256(features)}`,
    capturedAt: new Date().toISOString(),
    sourceUrl: source,
    sourceRevision: `metadata-sha256:${before.metadataSha256}`,
    sourceCrs: `EPSG:${before.metadata.sourceSpatialReference?.latestWkid ?? before.metadata.extent.spatialReference.latestWkid}`,
    featureCount: before.objectIds.length,
    idsSha256: before.idsSha256,
    layerName: before.metadata.name,
    attribution: before.metadata.copyrightText,
    sourceFields: before.metadata.fields.map(({ name, type }) => ({ name, type })),
  };
  fs.writeFileSync(path.join(out, "capture.json"), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`\ncapture ${record.captureId} features=${record.featureCount}\n`);
}

function byObjectId(left, right) {
  return JSON.parse(left).properties.objectid - JSON.parse(right).properties.objectid;
}
