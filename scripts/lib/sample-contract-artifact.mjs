import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SAMPLE_CONTRACT_PATHS = Object.freeze([
  "samples/dist",
  "samples/contract/v2/schemas",
  "samples/contract/v2/consumer-fixtures",
]);

/** Pack sample-consumer metadata independently of the runtime SDK. */
export async function packSampleContractArtifact({ projectRoot, outputDirectory }) {
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const sourceDirty = execFileSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" }).trim().length > 0;
  const sdk = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const staging = await mkdtemp(path.join(os.tmpdir(), "honua-sample-contract-"));
  await mkdir(outputDirectory, { recursive: true });
  try {
    for (const relative of [...SAMPLE_CONTRACT_PATHS, "LICENSE"]) {
      await mkdir(path.dirname(path.join(staging, relative)), { recursive: true });
      await cp(path.join(projectRoot, relative), path.join(staging, relative), { recursive: true });
    }
    await writeFile(path.join(staging, "package.json"), `${JSON.stringify({
      name: "@honua/sdk-sample-contract", version: sdk.version, private: true,
      description: "Independent Honua sample-consumer contracts and archived evidence",
      license: sdk.license, files: [...SAMPLE_CONTRACT_PATHS, "source.json", "LICENSE"],
    }, null, 2)}\n`);
    await writeFile(path.join(staging, "source.json"), `${JSON.stringify({ sourceRevision, sourceDirty, sdkVersion: sdk.version }, null, 2)}\n`);
    const npmArguments = ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory];
    const command = process.env.npm_execpath ? process.execPath : "npm";
    const args = process.env.npm_execpath ? [process.env.npm_execpath, ...npmArguments] : npmArguments;
    const [packed] = JSON.parse(execFileSync(command, args, { cwd: staging, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true }));
    const archive = await readFile(path.join(outputDirectory, packed.filename));
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    if (integrity !== packed.integrity) throw new Error("Sample-contract tarball integrity differs from npm pack");
    const filename = `honua-sdk-sample-contract-${sha256}.tgz`;
    await rename(path.join(outputDirectory, packed.filename), path.join(outputDirectory, filename));
    const receipt = { schema: "honua.sample-contract-artifact/v1", sourceRevision, sourceDirty,
      sdkVersion: sdk.version, filename, sha256, integrity, compressedBytes: archive.length,
      unpackedBytes: packed.unpackedSize, files: packed.files.map(({ path: file, size }) => ({ path: file, size })),
      node: process.version };
    await writeFile(path.join(outputDirectory, "sample-contract-artifact.v1.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
