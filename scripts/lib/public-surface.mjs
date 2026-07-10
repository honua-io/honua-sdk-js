import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PUBLIC_SURFACE_FILE = path.join(PROJECT_ROOT, "config", "public-surface.json");

export function loadPublicSurface() {
  return JSON.parse(fs.readFileSync(PUBLIC_SURFACE_FILE, "utf8"));
}

export function packageSubpath(specifier) {
  if (specifier === "@honua/sdk-js") return ".";
  if (!specifier.startsWith("@honua/sdk-js/")) {
    throw new Error(`Not an @honua/sdk-js package specifier: ${specifier}`);
  }
  return `.${specifier.slice("@honua/sdk-js".length)}`;
}

export function entrypointsInTier(surface, tier) {
  return surface.entrypoints.filter((entrypoint) => entrypoint.tier === tier);
}

export function sourceFileForExport(packageJson, subpath) {
  const exported = packageJson.exports?.[subpath];
  const types = exported && typeof exported === "object" ? exported.types : undefined;
  if (typeof types !== "string") {
    throw new Error(`package.json export "${subpath}" has no types declaration`);
  }
  const relative = types.replace(/^\.\/dist\//, "").replace(/\.d\.ts$/, ".ts");
  return path.join(PROJECT_ROOT, relative);
}
