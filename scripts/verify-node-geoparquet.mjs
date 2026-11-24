#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runNpmSync } from "./lib/npm-cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "honua-native-consumer-"));
const publicUrl = "https://raw.githubusercontent.com/honua-io/honua-sdk-js/9ddd349c11cde4000379086ee21371e6dc2f8e71/test/fixtures/geoparquet/places-geoparquet.parquet";
const fixtureHash = "d7c8027f9de1ad002ae24d33c1ca3973f8587c7acedea747f6a20e34c898b063";

function checked(result) {
  if (result.error || result.status !== 0) {
    throw new Error(`${result.error ?? "command failed"}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}
function npm(args, cwd = temporary) {
  return checked(runNpmSync(args, { cwd, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 }));
}
function node(args) {
  return checked(spawnSync(process.execPath, args, { cwd: temporary, encoding: "utf8", timeout: 120000 }));
}
async function checkBrowserIsolation() {
  const bundled = await build({
    absWorkingDir: temporary,
    stdin: {
      contents: 'export * from "@honua/sdk-js/contract"; export * from "@honua/sdk-js/geoparquet";',
      resolveDir: temporary,
    },
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
    external: ["@duckdb/duckdb-wasm"], logLevel: "silent",
  });
  assert.ok(!Object.keys(bundled.metafile.inputs).some((name) => name.includes("@duckdb/node")));
  assert.ok(!bundled.outputFiles[0].text.includes("@duckdb/node-api"));
  await assert.rejects(build({
    absWorkingDir: temporary,
    stdin: { contents: 'import "@honua/sdk-js/geoparquet/node";', resolveDir: temporary },
    bundle: true, platform: "browser", write: false, logLevel: "silent",
  }), /Could not resolve/);
}

try {
  fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], root));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(temporary, packed.filename)]);
  assert.ok(!fs.existsSync(path.join(temporary, "node_modules/@duckdb/node-api")), "optional native peer installed unexpectedly");
  node(["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createNodeDuckDbDriver } from '@honua/sdk-js/geoparquet/node';
    await assert.rejects(createNodeDuckDbDriver(), /Install.*node-api/);
  `]);
  await checkBrowserIsolation();
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", `@duckdb/node-api@${packageJson.devDependencies["@duckdb/node-api"]}`]);
  const fixture = path.join(temporary, "places.parquet");
  fs.copyFileSync(path.join(root, "test/fixtures/geoparquet/places-geoparquet.parquet"), fixture);
  fs.copyFileSync(path.join(root, "test/fixtures/geoparquet/node-consumer.mjs"), path.join(temporary, "consumer.mjs"));
  const local = JSON.parse(node(["consumer.mjs", fixture]));
  let publicResult;
  if (process.argv.includes("--public")) {
    const response = await fetch(publicUrl, { signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, `public fixture HTTP ${response.status}`);
    const hash = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
    assert.equal(hash, fixtureHash);
    publicResult = { url: publicUrl, sha256: hash, ...JSON.parse(node(["consumer.mjs", publicUrl])) };
  }
  await checkBrowserIsolation();
  const native = JSON.parse(fs.readFileSync(path.join(temporary, "node_modules/@duckdb/node-api/package.json"), "utf8"));
  console.log(JSON.stringify({ gate: "node-geoparquet", packageVersion: packed.version, integrity: packed.integrity,
    nodeVersion: process.version, nativeVersion: native.version, local, public: publicResult,
    missingPeer: "passed", browserIsolation: "passed" }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
