import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type UserConfig, defineConfig } from "vite";

export type SampleSdkMode = "source" | "packed";

export interface SampleViteOptions {
  readonly sdkEntrypoints: readonly string[];
  readonly define?: Readonly<Record<string, string>>;
}

const kitRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(kitRoot, "../..");
const packageName = "@honua/sdk-js";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly exports: Readonly<Record<string, { readonly default?: string } | string>>;
}

const MAX_ENTRYPOINT_BYTES = 4 * 1024 * 1024;

export function resolveContainedExport(root: string, target: string): string {
  if (
    !target.startsWith("./dist/") ||
    !target.endsWith(".js") ||
    `./${path.posix.normalize(target.slice(2))}` !== target
  ) {
    throw new Error(`unsafe SDK export target: ${target}`);
  }
  const canonicalRoot = fs.realpathSync(root);
  const candidate = path.resolve(canonicalRoot, target);
  const canonical = fs.realpathSync(candidate);
  if (!canonical.startsWith(`${canonicalRoot}${path.sep}`))
    throw new Error(`SDK export escapes package root: ${target}`);
  const metadata = fs.lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ENTRYPOINT_BYTES) {
    throw new Error(`SDK export must be a bounded regular file: ${target}`);
  }
  return canonical;
}

function validateDeclaredTarget(root: string, target: string): void {
  if (
    !target.startsWith("./dist/") ||
    !target.endsWith(".js") ||
    `./${path.posix.normalize(target.slice(2))}` !== target
  ) {
    throw new Error(`unsafe SDK export target: ${target}`);
  }
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(lexicalRoot, target);
  if (!lexicalTarget.startsWith(`${lexicalRoot}${path.sep}`))
    throw new Error(`SDK export escapes package root: ${target}`);
}

function readManifest(root: string): PackageManifest {
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest;
  if (manifest.name !== packageName || typeof manifest.version !== "string" || !manifest.exports) {
    throw new Error(`${manifestPath} is not an ${packageName} package manifest`);
  }
  return manifest;
}

function sdkMode(): SampleSdkMode {
  const value = process.env.HONUA_SAMPLE_SDK_MODE ?? "source";
  if (value !== "source" && value !== "packed") {
    throw new Error(`HONUA_SAMPLE_SDK_MODE must be source or packed, received ${JSON.stringify(value)}`);
  }
  return value;
}

function exportKey(specifier: string): string {
  if (specifier === packageName) return ".";
  const prefix = `${packageName}/`;
  if (!specifier.startsWith(prefix)) throw new Error(`not a public ${packageName} specifier: ${specifier}`);
  const subpath = specifier.slice(prefix.length);
  if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(subpath)) {
    throw new Error(`unsafe SDK export subpath: ${specifier}`);
  }
  return `./${subpath}`;
}

function defaultExport(manifest: PackageManifest, specifier: string, root: string): string {
  const key = exportKey(specifier);
  const declaration = manifest.exports[key];
  const target = typeof declaration === "string" ? declaration : declaration?.default;
  if (typeof target !== "string") {
    throw new Error(`${manifest.name} does not declare a JavaScript default export for ${key}`);
  }
  validateDeclaredTarget(root, target);
  return target;
}

function sourceTarget(target: string): string {
  const relative = target.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
  const absolute = path.resolve(repositoryRoot, relative);
  const canonical = fs.realpathSync(absolute);
  const metadata = fs.lstatSync(absolute);
  if (
    !canonical.startsWith(`${fs.realpathSync(repositoryRoot)}${path.sep}`) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_ENTRYPOINT_BYTES
  ) {
    throw new Error(`source entrypoint is not a bounded repository file for ${target}`);
  }
  return canonical;
}

function packedRoot(): string {
  const configured = process.env.HONUA_SAMPLE_SDK_DIR;
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("packed mode requires an absolute HONUA_SAMPLE_SDK_DIR");
  }
  const canonical = fs.realpathSync(configured);
  readManifest(canonical);
  return canonical;
}

function aliases(
  mode: SampleSdkMode,
  entrypoints: readonly string[],
): {
  aliases: Array<{ find: string; replacement: string }>;
  manifest: PackageManifest;
  sdkRoot: string;
  resolutions: Array<{ specifier: string; exportTarget: string; sha256: string }>;
} {
  const sdkRoot = mode === "packed" ? packedRoot() : repositoryRoot;
  const manifest = readManifest(sdkRoot);
  const unique = [...new Set(entrypoints)];
  if (unique.length !== entrypoints.length || unique.length === 0) {
    throw new Error("sdkEntrypoints must be a non-empty unique list");
  }
  const resolutions = unique
    .sort((left, right) => right.length - left.length)
    .map((specifier) => {
      const exportTarget = defaultExport(manifest, specifier, sdkRoot);
      const resolvedTarget =
        mode === "source" ? sourceTarget(exportTarget) : resolveContainedExport(sdkRoot, exportTarget);
      return {
        specifier,
        exportTarget,
        hashSubject: mode === "source" ? "repository-source-entrypoint-file" : "packed-published-entrypoint-file",
        sha256: createHash("sha256").update(fs.readFileSync(resolvedTarget)).digest("hex"),
      };
    });
  return {
    sdkRoot,
    manifest,
    resolutions,
    aliases: resolutions.map(({ specifier: find, exportTarget }) => {
      return {
        find,
        replacement: mode === "source" ? sourceTarget(exportTarget) : resolveContainedExport(sdkRoot, exportTarget),
      };
    }),
  };
}

export function createSampleViteConfig(metaUrl: string, options: SampleViteOptions): UserConfig {
  const exampleRoot = path.dirname(fileURLToPath(metaUrl));
  for (const reserved of ["__HONUA_SAMPLE_SDK_MODE__", "__HONUA_SDK_VERSION__"]) {
    if (Object.hasOwn(options.define ?? {}, reserved)) throw new Error(`${reserved} is reserved by the sample kit`);
  }
  const mode = sdkMode();
  const resolved = aliases(mode, options.sdkEntrypoints);
  let buildMode = false;
  let buildFailed = false;
  let outputRoot: string | undefined;
  let emittedBundle: Array<{ fileName: string; kind: "asset" | "chunk" }> | undefined;

  return defineConfig({
    base: "./",
    root: exampleRoot,
    envDir: exampleRoot,
    define: {
      __HONUA_SAMPLE_SDK_MODE__: JSON.stringify(mode),
      __HONUA_SDK_VERSION__: JSON.stringify(resolved.manifest.version),
      ...options.define,
    },
    resolve: { alias: resolved.aliases },
    plugins: [
      {
        name: "honua-sample-declared-entrypoints",
        enforce: "pre",
        resolveId(source) {
          if (
            (source === packageName || source.startsWith(`${packageName}/`)) &&
            !options.sdkEntrypoints.includes(source)
          ) {
            throw new Error(`sample imported undeclared public SDK entrypoint: ${source}`);
          }
          return null;
        },
      },
      {
        name: "honua-sample-sdk-resolution",
        buildEnd(error) {
          buildFailed = error !== undefined;
        },
        renderError() {
          buildFailed = true;
        },
        configResolved(config) {
          buildMode = config.command === "build";
          if (buildMode) outputRoot = path.resolve(config.root, config.build.outDir);
        },
        generateBundle(_outputOptions, bundle) {
          emittedBundle = Object.values(bundle).map((entry) => ({ fileName: entry.fileName, kind: entry.type }));
          if (emittedBundle.length === 0 || emittedBundle.length > 1_000)
            throw new Error("sample bundle inventory is invalid");
        },
        closeBundle() {
          if (!buildMode) return;
          // Rollup still calls closeBundle after another hook fails. Preserve
          // that actionable root error instead of replacing it with a missing
          // inventory diagnostic from this evidence plugin.
          if (buildFailed) return;
          if (!outputRoot || !emittedBundle)
            throw new Error("sample bundle closed without a resolved output inventory");
          const finalOutputRoot = outputRoot;
          const hashEntry = (fileName: string, kind: "asset" | "chunk" | "public") => {
            const absolute = path.resolve(finalOutputRoot, fileName);
            if (!absolute.startsWith(`${finalOutputRoot}${path.sep}`)) {
              throw new Error(`sample bundle entry escaped the output root: ${fileName}`);
            }
            const metadata = fs.lstatSync(absolute);
            if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024 * 1024) {
              throw new Error(`sample bundle entry is not a bounded regular file: ${fileName}`);
            }
            const bytes = fs.readFileSync(absolute);
            return {
              fileName,
              kind,
              hashSubject: "final-written-bundle-file",
              bytes: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          };
          const bundleEvidence = emittedBundle.map((entry) => hashEntry(entry.fileName, entry.kind));
          // Vite copies publicDir straight to outDir outside Rollup's bundle
          // graph, so generateBundle's emittedBundle never sees those files
          // (e.g. examples/migration-workbench/public/artifacts/v1's
          // committed migration CLI output). Walk the final output for any
          // regular file the bundle didn't already account for and declare
          // it too -- honua-sdk-js#549 -- so this evidence honestly covers
          // every file the packed-build gate later finds on disk instead of
          // silently under-declaring static passthrough output.
          const declared = new Set(bundleEvidence.map((entry) => entry.fileName));
          const reservedFileNames = new Set(["index.html", "honua-sample-sdk-resolution.json"]);
          const visit = (relativeDirectory: string) => {
            const absoluteDirectory = path.join(finalOutputRoot, ...relativeDirectory.split("/").filter(Boolean));
            for (const dirent of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
              const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
              if (dirent.isSymbolicLink()) {
                throw new Error(`sample dist output contains a symlink: ${relativePath}`);
              }
              if (dirent.isDirectory()) {
                visit(relativePath);
                continue;
              }
              if (!dirent.isFile() || declared.has(relativePath) || reservedFileNames.has(relativePath)) continue;
              bundleEvidence.push(hashEntry(relativePath, "public"));
              declared.add(relativePath);
            }
          };
          visit("");
          fs.writeFileSync(
            path.join(finalOutputRoot, "honua-sample-sdk-resolution.json"),
            `${JSON.stringify(
              {
                format: "honua.sdk.sample-resolution.v1",
                schemaVersion: 1,
                mode,
                package: { name: resolved.manifest.name, version: resolved.manifest.version },
                entrypoints: resolved.resolutions,
                bundle: bundleEvidence,
              },
              null,
              2,
            )}\n`,
          );
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      fs: { allow: [repositoryRoot, resolved.sdkRoot] },
    },
    preview: { host: "127.0.0.1" },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  });
}
