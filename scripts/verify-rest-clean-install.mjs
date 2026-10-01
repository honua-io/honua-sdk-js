#!/usr/bin/env node

/**
 * Installed REST production build for issue #1715.
 *
 * Packs the split SDK and installs it outside this repository so Vite cannot
 * resolve optional gRPC peers from an ancestor node_modules. The historical
 * failure (Rolldown cannot resolve `@connectrpc/connect` or
 * `@bufbuild/protobuf/codegenv2`) is reproduced on a negative-control entry
 * before the fixed packages are built.
 *
 * `config/installed-package-certification.v1.json` still pins those three
 * packages in consumerDependencies. That pin is a temporary sample workaround
 * for the published 0.1.9-beta.0 tarball, not the packaging contract. Do not
 * delete test-results/installed-quickstart-budget.json to make this check pass.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runNpmSync } from "./lib/npm-cli.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGES_ROOT = path.join(PROJECT_ROOT, "dist", "packages");
const OPTIONAL_GRPC_PACKAGES = ["@bufbuild/protobuf", "@connectrpc/connect", "@connectrpc/connect-web"];
const ROOT_PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "honua-rest-clean-"));
let preview;

try {
  assertOutsideRepository(appDir);
  const sdkTar = packSplit("@honua/sdk", "honua-sdk");
  const compatTar = packSplit("@honua/sdk-esri-compat", "honua-sdk-esri-compat");
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    `${JSON.stringify(
      {
        name: "honua-rest-clean-install",
        private: true,
        type: "module",
        dependencies: {
          "@honua/sdk": `file:${sdkTar}`,
          "@honua/sdk-esri-compat": `file:${compatTar}`,
        },
        devDependencies: {
          vite: ROOT_PACKAGE_JSON.devDependencies.vite,
          "@playwright/test": ROOT_PACKAGE_JSON.devDependencies["@playwright/test"],
        },
      },
      null,
      2,
    )}\n`,
  );
  runNpm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
  runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assertLockedClosure();
  writeConsumerFiles();
  assertNegativeControl("vite.negative-connect.config.js", '@connectrpc/connect');
  assertNegativeControl("vite.negative-proto.config.js", "@bufbuild/protobuf/codegenv2");
  runNode([path.join(appDir, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.config.js"]);
  assertProductionGraph();
  const missingPeer = runNode(["missing-peer.mjs"]);
  process.stdout.write(missingPeer.stdout);
  await queryProductionBuild();
  process.stdout.write("restCleanInstall=ok\n");
} finally {
  if (preview && preview.exitCode === null) preview.kill("SIGTERM");
  fs.rmSync(appDir, { recursive: true, force: true });
}

function assertOutsideRepository(directory) {
  const realApp = fs.realpathSync(directory);
  const realRepo = fs.realpathSync(PROJECT_ROOT);
  if (realApp === realRepo || realApp.startsWith(`${realRepo}${path.sep}`)) {
    throw new Error(`REST proof directory is inside the repository: ${realApp}`);
  }
}

function packSplit(packageName, directoryName) {
  const packageDir = path.join(PACKAGES_ROOT, directoryName);
  if (!fs.existsSync(path.join(packageDir, "package.json"))) {
    throw new Error(`Missing split package ${packageName} at ${packageDir}. Run "npm run build:split-packages" first.`);
  }
  const packed = runNpm(["pack", packageDir, "--pack-destination", appDir], PROJECT_ROOT);
  const filename = packed.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!filename || !filename.endsWith(".tgz")) {
    throw new Error(`npm pack did not report a tarball for ${packageName}.\n${packed.stdout}`);
  }
  return `./${filename}`;
}

function writeConsumerFiles() {
  fs.mkdirSync(path.join(appDir, "negative"), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "negative", "connect.js"),
    'export function load() {\n  return import("@connectrpc/connect");\n}\n',
  );
  fs.writeFileSync(
    path.join(appDir, "negative", "needs-proto.js"),
    'import { fileDesc } from "@bufbuild/protobuf/codegenv2";\nexport const marker = fileDesc;\n',
  );
  fs.writeFileSync(
    path.join(appDir, "negative", "proto-entry.js"),
    'export { marker } from "./needs-proto.js";\n',
  );
  fs.writeFileSync(
    path.join(appDir, "index.html"),
    '<!doctype html>\n<html><body><pre id="out">pending</pre><script type="module" src="/main.js"></script></body></html>\n',
  );
  fs.writeFileSync(
    path.join(appDir, "main.js"),
    `import { createHonua, HonuaClient } from "@honua/sdk";
import { FeatureLayerCompat } from "@honua/sdk-esri-compat";

const kernel = createHonua();
if (typeof kernel.connect !== "function") throw new Error("createHonua did not return a kernel");
if (typeof FeatureLayerCompat !== "function") throw new Error("FeatureLayerCompat missing");

const out = document.querySelector("#out");
try {
  const client = new HonuaClient({ baseUrl: window.location.origin });
  const result = await client.queryFeatures({
    serviceId: "plants",
    layerId: 0,
    where: "1=1",
    outFields: ["name"],
    returnGeometry: false,
  });
  const name = result.features?.[0]?.attributes?.name;
  out.textContent = typeof name === "string" ? name : "missing";
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  out.textContent = \`error:\${error instanceof Error ? error.name : "unknown"}:\${message}\`;
}
`,
  );
  fs.writeFileSync(
    path.join(appDir, "missing-peer.mjs"),
    `import { HonuaClient } from "@honua/sdk";

const client = new HonuaClient({
  baseUrl: "https://grpc.example.test",
  transport: "grpc-web",
  fetchFn: async () => {
    throw new Error("REST fetch ran for a gRPC client");
  },
});
try {
  await client.queryFeatures({ serviceId: "plants", layerId: 0, where: "1=1", returnGeometry: false });
  console.error("missing optional gRPC peer was not reported");
  process.exit(1);
} catch (error) {
  if (error?.name !== "HonuaOptionalGrpcPeerError") {
    console.error(error);
    process.exit(1);
  }
  for (const peer of ${JSON.stringify(OPTIONAL_GRPC_PACKAGES)}) {
    if (!error.message.includes(peer)) {
      console.error(\`missing peer diagnostic did not name \${peer}: \${error.message}\`);
      process.exit(1);
    }
  }
  if (!(error.cause instanceof Error)) {
    console.error("missing peer diagnostic dropped the original load error");
    process.exit(1);
  }
  console.log("restCleanInstallMissingPeer=ok");
}
`,
  );
  const viteConfig = `import fs from "node:fs";
import { defineConfig } from "vite";

const fixture = JSON.stringify({ features: [{ attributes: { name: "Plant A" } }] });

export default defineConfig({
  plugins: [
    {
      name: "rest-clean-install-proof",
      generateBundle() {
        fs.writeFileSync("module-ids.json", JSON.stringify([...this.getModuleIds()]));
      },
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          const pathname = (request.url ?? "").split("?")[0];
          if (pathname.endsWith("/rest/services/plants/FeatureServer/0/query")) {
            response.setHeader("content-type", "application/json");
            response.end(fixture);
            return;
          }
          next();
        });
      },
    },
  ],
});
`;
  fs.writeFileSync(path.join(appDir, "vite.config.js"), viteConfig);
  fs.writeFileSync(
    path.join(appDir, "vite.negative-connect.config.js"),
    negativeConfig("negative/connect.js", "dist-negative-connect"),
  );
  fs.writeFileSync(
    path.join(appDir, "vite.negative-proto.config.js"),
    negativeConfig("negative/proto-entry.js", "dist-negative-proto"),
  );
}

function negativeConfig(entry, outDir) {
  const base = path.posix.basename(entry);
  return `import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve("negative"),
  build: {
    emptyOutDir: true,
    outDir: path.resolve(${JSON.stringify(outDir)}),
    rollupOptions: { input: path.resolve("negative", ${JSON.stringify(base)}) },
  },
});
`;
}

function assertLockedClosure() {
  const lockPath = path.join(appDir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const keys = Object.keys(lock.packages ?? {});
  if (keys.length < 3) throw new Error("consumer lock did not record the installed dependency closure");
  for (const peerName of OPTIONAL_GRPC_PACKAGES) {
    if (keys.some((key) => key === `node_modules/${peerName}` || key.endsWith(`/node_modules/${peerName}`))) {
      throw new Error(`REST-only lock installed optional gRPC peer ${peerName}`);
    }
    if (fs.existsSync(path.join(appDir, "node_modules", peerName))) {
      throw new Error(`REST-only install materialized optional gRPC peer ${peerName}`);
    }
  }
  for (const packageName of ["@honua/sdk", "@honua/sdk-esri-compat"]) {
    const installed = path.join(appDir, "node_modules", packageName);
    const real = fs.realpathSync(installed);
    if (!real.startsWith(`${fs.realpathSync(appDir)}${path.sep}`)) {
      throw new Error(`${packageName} resolved outside the isolated install: ${real}`);
    }
    const stat = fs.lstatSync(installed);
    if (stat.isSymbolicLink() && fs.realpathSync(installed).startsWith(`${fs.realpathSync(PROJECT_ROOT)}${path.sep}`)) {
      throw new Error(`${packageName} is a symlink into the repository`);
    }
  }
}

function assertNegativeControl(configFile, expectedSpecifier) {
  const result = spawnSync(process.execPath, [path.join(appDir, "node_modules", "vite", "bin", "vite.js"), "build", "--config", configFile], {
    cwd: appDir,
    encoding: "utf8",
    env: consumerEnv(),
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
  if (result.status === 0 || !output.includes(expectedSpecifier) || !output.includes("failed to resolve import")) {
    throw new Error(`Negative control ${configFile} did not reproduce the unresolved optional peer.\n${output}`);
  }
  process.stdout.write(`restCleanInstallNegativeControl=${expectedSpecifier}\n`);
}

function assertProductionGraph() {
  const ids = JSON.parse(fs.readFileSync(path.join(appDir, "module-ids.json"), "utf8"));
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("production build did not record a module graph");
  const realApp = fs.realpathSync(appDir);
  const realRepo = fs.realpathSync(PROJECT_ROOT);
  for (const id of ids) {
    if (typeof id !== "string") throw new Error(`unexpected module id ${String(id)}`);
    if (id.includes("@bufbuild") || id.includes("@connectrpc")) {
      throw new Error(`REST production graph resolved an optional gRPC module: ${id}`);
    }
    if (id.includes("\0")) continue;
    const candidate = path.isAbsolute(id) ? id : path.resolve(appDir, id);
    if (!fs.existsSync(candidate)) continue;
    const real = fs.realpathSync(candidate);
    if (real === realRepo || real.startsWith(`${realRepo}${path.sep}`)) {
      throw new Error(`production module resolved inside the repository: ${real}`);
    }
    if (!real.startsWith(`${realApp}${path.sep}`)) {
      throw new Error(`production module resolved outside the isolated install: ${real}`);
    }
  }
  const sdkClient = ids.find((id) => id.includes("/@honua/sdk/") && id.endsWith("/core/client.js"));
  const compatClient = ids.find((id) => id.includes("/@honua/sdk-esri-compat/") && id.endsWith("/core/client.js"));
  if (!sdkClient) throw new Error("production graph did not include the installed @honua/sdk client");
  if (!compatClient) throw new Error("production graph did not include the installed esri-compat client");
}

async function queryProductionBuild() {
  const port = await freePort();
  preview = spawn(
    process.execPath,
    [path.join(appDir, "node_modules", "vite", "bin", "vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: appDir, env: consumerEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  preview.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  preview.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });
  const url = `http://127.0.0.1:${port}/`;
  const ready = waitForPreview(preview, () => log.includes("Local:") || log.includes(url));
  await ready;
  const playwrightEntry = pathToFileURL(path.join(appDir, "node_modules/@playwright/test/index.js")).href;
  const playwright = await import(playwrightEntry);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) {
    throw new Error("The isolated Playwright install did not export chromium.");
  }
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("#out")?.textContent !== "pending", undefined, {
      timeout: 30_000,
    });
    const text = await page.textContent("#out");
    if (text !== "Plant A") {
      throw new Error(`production browser query returned ${JSON.stringify(text)}; page errors: ${pageErrors.join(" | ")}\n${log}`);
    }
    process.stdout.write("restCleanInstallBrowserQuery=Plant A\n");
  } finally {
    await browser.close();
  }
}

function waitForPreview(child, isReady) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("vite preview did not start")), 60_000);
    const poll = setInterval(() => {
      if (isReady()) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 100);
    child.once("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timeout);
      reject(new Error(`vite preview exited early (${code})`));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function consumerEnv() {
  return { ...process.env, NODE_PATH: "" };
}

function runNpm(args, cwd = appDir) {
  const result = runNpmSync(args, { cwd, encoding: "utf8", env: consumerEnv() });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`);
  }
  return result;
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: appDir, encoding: "utf8", env: consumerEnv() });
  if (result.error || result.status !== 0) {
    throw new Error(`node ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`);
  }
  return result;
}
