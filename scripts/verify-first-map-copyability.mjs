#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-first-map-copy-pack-"));
const appRoot = fs.mkdtempSync(path.join(projectRoot, ".first-map-copyability-"));

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`${label} failed${result.status === null ? "" : ` (exit ${result.status})`}: ${detail}`);
  }
  return result.stdout;
}

function packageTarget(packageRoot, key, condition) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const declaration = manifest.exports?.[key];
  const target = typeof declaration === "string" ? declaration : declaration?.[condition];
  if (typeof target !== "string" || !target.startsWith("./dist/") || !target.endsWith(condition === "types" ? ".d.ts" : ".js")) {
    throw new Error(`packed SDK has no safe ${key} ${condition} export`);
  }
  const resolved = path.resolve(packageRoot, target);
  const metadata = fs.lstatSync(resolved);
  if (!resolved.startsWith(`${packageRoot}${path.sep}`) || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`packed SDK ${key} ${condition} export escapes its package`);
  }
  return resolved;
}

try {
  const packed = JSON.parse(
    run("npm pack", "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot, projectRoot]),
  );
  const tarball = packed.find(({ name }) => name === "@honua/sdk-js")?.filename;
  if (typeof tarball !== "string") throw new Error("npm pack did not report the SDK tarball");
  run("extract packed SDK", "tar", ["-xzf", path.join(packRoot, tarball), "-C", appRoot]);
  const packedSdk = path.join(appRoot, "package");
  const sourceRoot = path.join(projectRoot, "examples/maplibre-quickstart/src");
  for (const file of ["first-map-config.ts", "first-map-model.ts", "workflow.ts"]) {
    fs.copyFileSync(path.join(sourceRoot, file), path.join(appRoot, file));
  }
  fs.writeFileSync(
    path.join(appRoot, "main.ts"),
    `import { resolveFirstMapConfig } from "./first-map-config.js";\n` +
      `import { runFirstMapWorkflow } from "./workflow.js";\n\n` +
      `export function makeFirstMap(map: Parameters<typeof runFirstMapWorkflow>[1]["map"]) {\n` +
      `  return runFirstMapWorkflow(\n` +
      `    resolveFirstMapConfig({ endpoint: "https://example.test/FeatureServer/0", protocol: "auto", maxFeatures: 25 }),\n` +
      `    { map },\n` +
      `  );\n` +
      `}\n`,
  );
  const typePaths = {
    "@honua/sdk-js": [packageTarget(packedSdk, ".", "types")],
    "@honua/sdk-js/runtime": [packageTarget(packedSdk, "./runtime", "types")],
  };
  fs.writeFileSync(
    path.join(appRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
          baseUrl: ".",
          paths: typePaths,
        },
        include: ["*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run("fresh Vite TypeScript consumer", "npx", ["--no-install", "tsc", "-p", path.join(appRoot, "tsconfig.json")]);
  await build({
    configFile: false,
    root: appRoot,
    logLevel: "error",
    resolve: {
      alias: [
        { find: "@honua/sdk-js/runtime", replacement: packageTarget(packedSdk, "./runtime", "default") },
        { find: "@honua/sdk-js", replacement: packageTarget(packedSdk, ".", "default") },
      ],
    },
    build: {
      lib: { entry: path.join(appRoot, "main.ts"), formats: ["es"], fileName: "first-map" },
      outDir: path.join(appRoot, "dist"),
      emptyOutDir: true,
    },
  });
  if (!fs.existsSync(path.join(appRoot, "dist/first-map.js"))) throw new Error("fresh Vite build emitted no module");
  process.stdout.write(
    "firstMapCopyability=ok files=first-map-config.ts,first-map-model.ts,workflow.ts sdk=packed consumer=fresh-vite\n",
  );
} finally {
  fs.rmSync(appRoot, { recursive: true, force: true });
  fs.rmSync(packRoot, { recursive: true, force: true });
}
