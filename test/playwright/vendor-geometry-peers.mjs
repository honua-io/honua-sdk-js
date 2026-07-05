/**
 * Vendor bundles + import map for the SDK's DECLARED geometry peers.
 *
 * The migration browser-smoke harnesses serve raw `dist/src/**` modules to a
 * real browser with no bundler. The esri-compat entry re-exports the
 * geometryEngine compat shim (issue #351), whose backing (`src/geometry`)
 * imports the optional peer dependencies `@turf/*` and `proj4` as bare
 * specifiers — unresolvable in a bundler-less browser without an import map.
 *
 * This helper esbuild-bundles ONLY those declared peers (read from
 * package.json `peerDependencies`, so the list cannot drift) into
 * self-contained ESM files and returns an import map for them. Any OTHER bare
 * specifier that sneaks into the compat graph still fails module resolution
 * in these specs — the "esri-compat loads without a bundler beyond its
 * declared peers" guard stays intact.
 */

import fs from "node:fs";
import path from "node:path";

import * as esbuild from "esbuild";

function sanitize(name) {
  return name.replace(/[@/]/g, "_");
}

export function geometryPeerNames(projectRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  return Object.keys(pkg.peerDependencies ?? {}).filter(
    (name) => name.startsWith("@turf/") || name === "proj4",
  );
}

/**
 * Bundle each declared geometry peer into `outDir` as a self-contained ESM
 * file (named exports preserved). Returns { importMap, files } where importMap
 * maps bare specifier -> served /vendor/ URL.
 */
export async function buildGeometryPeerVendors(projectRoot, outDir) {
  const names = geometryPeerNames(projectRoot);
  fs.mkdirSync(outDir, { recursive: true });
  const entryPoints = {};
  for (const name of names) {
    // Bare names: esbuild resolves them like imports (node_modules, `import`
    // condition), so the ESM entry with named exports is what gets bundled.
    entryPoints[sanitize(name)] = name;
  }
  await esbuild.build({
    entryPoints,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    outdir: outDir,
    logLevel: "silent",
    absWorkingDir: projectRoot,
  });
  const imports = Object.fromEntries(names.map((name) => [name, `/vendor/${sanitize(name)}.js`]));
  return { imports, outDir };
}

export function importMapScriptTag(imports) {
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

/**
 * startServer() hook: serve a /vendor/<file>.js request from `outDir`.
 * Returns true when the request was handled.
 */
export function serveVendorRequest(requestUrl, res, outDir) {
  if (!requestUrl.pathname.startsWith("/vendor/")) return false;
  const fileName = path.basename(requestUrl.pathname);
  const filePath = path.join(outDir, fileName);
  if (!filePath.startsWith(outDir) || !fs.existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return true;
  }
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
  res.end(fs.readFileSync(filePath, "utf8"));
  return true;
}
