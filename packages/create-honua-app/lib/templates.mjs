// Template manifest reader for `create-honua-app`.
//
// `templates.manifest.json` is the single source of truth for which starters
// exist, which published SDK version they pin, and where their zero-install
// playgrounds live. The CLI, the repository verifier
// (scripts/verify-create-honua-app.mjs) and the generated playground page
// (scripts/playgrounds.mjs) all read it through this module so a template can
// never be advertised in one place and missing in another.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_FILE = "templates.manifest.json";
export const MANIFEST_FORMAT = "honua.sdk.create-honua-app-templates.v1";
export const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  throw new Error(`${MANIFEST_FILE} is invalid: ${message}`);
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

/** Read and validate the template manifest that ships inside the package. */
export function loadTemplateManifest(packageRoot = PACKAGE_ROOT) {
  const manifestPath = path.join(packageRoot, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== MANIFEST_FORMAT) fail(`format must be ${MANIFEST_FORMAT}`);
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
  nonEmptyString(manifest.sdk?.package, "sdk.package");
  nonEmptyString(manifest.sdk?.version, "sdk.version");
  for (const field of ["owner", "name", "branch"]) nonEmptyString(manifest.repository?.[field], `repository.${field}`);
  if (!Array.isArray(manifest.playgroundProviders) || manifest.playgroundProviders.length === 0) {
    fail("playgroundProviders must be a non-empty array");
  }
  for (const provider of manifest.playgroundProviders) {
    nonEmptyString(provider?.id, "playgroundProviders[].id");
    nonEmptyString(provider?.title, "playgroundProviders[].title");
    nonEmptyString(provider?.urlTemplate, "playgroundProviders[].urlTemplate");
  }
  if (!Array.isArray(manifest.templates) || manifest.templates.length === 0)
    fail("templates must be a non-empty array");
  const seen = new Set();
  for (const template of manifest.templates) {
    const id = nonEmptyString(template?.id, "templates[].id");
    if (!TEMPLATE_ID_PATTERN.test(id)) fail(`template id ${JSON.stringify(id)} must be a lowercase slug`);
    if (seen.has(id)) fail(`duplicate template id ${JSON.stringify(id)}`);
    seen.add(id);
    nonEmptyString(template.title, `templates[${id}].title`);
    nonEmptyString(template.summary, `templates[${id}].summary`);
    nonEmptyString(template.path, `templates[${id}].path`);
    nonEmptyString(template.entryFile, `templates[${id}].entryFile`);
    if (template.dataLane !== "fixture") fail(`templates[${id}].dataLane must be "fixture"`);
    if (typeof template.default !== "boolean") fail(`templates[${id}].default must be a boolean`);
    if (!Array.isArray(template.dependencies) || template.dependencies.length === 0) {
      fail(`templates[${id}].dependencies must be a non-empty array`);
    }
    if (!template.path.endsWith(`/${id}`)) fail(`templates[${id}].path must end with the template id`);
  }
  if (manifest.templates.filter((template) => template.default).length !== 1) {
    fail("exactly one template must be marked default");
  }
  return manifest;
}

/** Ids of every declared template, in manifest order. */
export function templateIds(manifest) {
  return manifest.templates.map((template) => template.id);
}

/** The template a bare `create-honua-app <dir>` invocation uses. */
export function defaultTemplate(manifest) {
  return manifest.templates.find((template) => template.default);
}

/** Look up one template, throwing a caller-friendly error for unknown ids. */
export function templateById(manifest, id) {
  const template = manifest.templates.find((entry) => entry.id === id);
  if (!template) {
    throw new Error(
      `Unknown template ${JSON.stringify(id)}. Available templates: ${templateIds(manifest).join(", ")}.`,
    );
  }
  return template;
}

/** Absolute directory holding a template's files inside the installed package. */
export function templateRoot(manifest, id, packageRoot = PACKAGE_ROOT) {
  const template = templateById(manifest, id);
  return path.join(packageRoot, "templates", template.id);
}

/**
 * Expand one provider's URL template for one repository-relative project path.
 * Playground links stay plain, query-free https URLs so they remain safe for
 * documentation surfaces that reject query strings and fragments.
 */
export function playgroundUrl(provider, { owner, repository, branch, path: projectPath }) {
  const url = provider.urlTemplate
    .replaceAll("{owner}", owner)
    .replaceAll("{repository}", repository)
    .replaceAll("{branch}", branch)
    .replaceAll("{path}", projectPath);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`playground URL must be https: ${url}`);
  if (parsed.search !== "" || parsed.hash !== "")
    throw new Error(`playground URL must not carry a query or fragment: ${url}`);
  return url;
}

/** Every provider link for one template, derived from the manifest. */
export function playgroundLinks(manifest, template) {
  return manifest.playgroundProviders.map((provider) => ({
    providerId: provider.id,
    title: provider.title,
    url: playgroundUrl(provider, {
      owner: manifest.repository.owner,
      repository: manifest.repository.name,
      branch: manifest.repository.branch,
      path: template.path,
    }),
  }));
}
