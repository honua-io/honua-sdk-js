import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_MANIFEST_PATH = path.join("examples", "cloud-demo-services.json");

export function compareManifestBytes(vendoredBytes, publishedBytes) {
  if (!Buffer.from(vendoredBytes).equals(Buffer.from(publishedBytes))) {
    throw new Error("vendored demo-services.v1.json differs from the published manifest");
  }
}

export async function checkCloudDemoManifestDrift({
  fetchImpl = fetch,
  manifestUrl,
  vendoredPath = DEFAULT_MANIFEST_PATH,
} = {}) {
  if (!manifestUrl) {
    throw new Error("HONUA_CLOUD_DEMO_MANIFEST_URL is required for the cloud demo manifest drift check");
  }

  let url;
  try {
    url = new URL(manifestUrl);
  } catch (error) {
    throw new Error(`Invalid cloud demo manifest URL: ${manifestUrl}`, { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new Error(`Cloud demo manifest URL must use HTTPS: ${url.toString()}`);
  }

  const response = await fetchImpl(url);
  const publishedBytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`GET ${url.toString()} returned ${response.status}: ${publishedBytes.toString("utf8").slice(0, 200)}`);
  }

  const vendoredBytes = await fs.readFile(vendoredPath);
  compareManifestBytes(vendoredBytes, publishedBytes);
  return { manifestUrl: url.toString(), bytes: vendoredBytes.byteLength };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const result = await checkCloudDemoManifestDrift({
    manifestUrl: process.env.HONUA_CLOUD_DEMO_MANIFEST_URL,
  });
  console.log(`Cloud demo manifest is byte-identical (${result.bytes} bytes): ${result.manifestUrl}`);
}
