import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const outdir = "artifacts/native-edit-evaluation";
await mkdir(outdir, { recursive: true });
const outfile = `${outdir}/honua-grpc-native-edit.mjs`;
const result = await build({
  entryPoints: ["native-edit-evaluation-entry.ts"], outfile,
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  minify: true, sourcemap: true, metafile: true,
});
const external = Object.values(result.metafile.outputs).flatMap(output => output.imports).filter(item => item.external);
if (external.length) throw new Error(`External imports: ${JSON.stringify(external)}`);
const exports = result.metafile.outputs[outfile].exports;
const required = ["HonuaClient", "createDataset", "geoServicesFeatureSource", "createServiceEditSession", "PROTOCOL_DEFAULT_CAPABILITIES"];
for (const name of required) if (!exports.includes(name)) throw new Error(`Missing ${name}`);
const consumer = await import(`./${outfile}`);
for (const name of required.slice(0, 4)) if (typeof consumer[name] !== "function") throw new Error(`Invalid ${name}`);
const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");
await writeFile(`${outdir}/metafile.json`, JSON.stringify(result.metafile, null, 2));
const provenance = {
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceStatus: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  entrySha256: await digest("native-edit-evaluation-entry.ts"),
  buildScriptSha256: await digest("native-edit-evaluation-build.mjs"),
  lockSha256: await digest("package-lock.json"), bundleSha256: await digest(outfile),
  exports, externalImports: external, liveStatus: "NOT RUN",
};
await writeFile(`${outdir}/provenance.json`, JSON.stringify(provenance, null, 2) + "\n");
console.log(JSON.stringify(provenance));
