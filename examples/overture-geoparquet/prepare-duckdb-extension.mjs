import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensurePinnedParquetExtension, resolveParquetExtensionCachePath } from "./extension-cache.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");
const args = new Set(process.argv.slice(2));
for (const argument of args) {
  if (argument !== "--offline") throw new Error(`Unknown argument: ${argument}`);
}
const offline = args.has("--offline");
const cachePath = resolveParquetExtensionCachePath({ repoRoot });
const prepared = await ensurePinnedParquetExtension({ cachePath, offline });
process.stdout.write(
  `duckDbParquetExtension=${prepared.status} sha256=${prepared.sha256} path=${path.relative(repoRoot, cachePath)}\n`,
);
