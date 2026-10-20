#!/usr/bin/env node

/**
 * Prove every `npx` command the documentation tells a reader to copy can resolve
 * an executable.
 *
 * `npx` does not take a command name. It takes a *package* spec, fetches it, and
 * then derives which of that package's bins to run. Two documented shapes look
 * correct and cannot run:
 *
 *   npx @honua/sdk-js honua <command>   the package publishes `honua` and
 *                                       `honua-plugin-certify`; neither is named
 *                                       `sdk-js`, so npm cannot pick one and
 *                                       fails with "could not determine
 *                                       executable to run" before `honua` -- an
 *                                       argument, not a command -- is ever read.
 *   npx honua-plugin-certify            no npm package has that name, so the
 *                                       fetch 404s for any reader who has not
 *                                       already installed the package that
 *                                       publishes the bin.
 *
 * Both fail only for the reader, never for the author, who already has the bin
 * on PATH. So this gate reimplements npm's own derivation (libnpmexec's
 * `getBinFromManifest`) against the real `bin` maps in this workspace and in
 * `node_modules`, and answers the question the author cannot ask locally.
 *
 * It is offline and deterministic, which is what makes it a per-pull-request
 * gate: it reads manifests that are already on disk and never contacts a
 * registry. A documented package whose manifest is not on disk is reported as
 * `unverified` rather than guessed at -- proving those is the job of the
 * scheduled `scripts/check-documented-packages.py`, which may fail on a registry
 * outage and therefore must not block a merge.
 *
 * Exit codes: 0 every documented invocation resolves, 1 at least one does not.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverMarkdownFiles, extractFencedBlocks } from "./lib/markdown-fences.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHELL_LANGUAGES = new Set(["bash", "console", "sh", "shell", "shell-session", "zsh"]);

// Manifests that describe a package this documentation may tell a reader to
// fetch. Workspace manifests are the packages this repository itself publishes;
// `node_modules` covers every third-party bin a contributor-facing block runs.
const WORKSPACE_MANIFESTS = ["package.json", "mcp/package.json", "packages/create-honua-app/package.json"];

// npx flags that consume the following token as their value. A flag whose value
// is attached with `=` is one token and needs no entry here.
const VALUE_FLAGS = new Set([
  "-c",
  "--call",
  "-n",
  "--node-arg",
  "--node-options",
  "-p",
  "--package",
  "--loglevel",
  "--prefix",
  "--registry",
  "-w",
  "--workspace",
]);

const PACKAGE_FLAGS = new Set(["-p", "--package"]);

/** A package spec's name: `@honua/sdk-js@0.1.9-beta.0` names `@honua/sdk-js`. */
export function packageNameFromSpec(spec) {
  if (typeof spec !== "string" || spec.length === 0) return undefined;
  if (/^[./~]|^[a-z+]+:/i.test(spec)) return undefined; // a path, URL, or `git+`/`file:` spec
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at > 0 ? spec.slice(0, at) : spec;
  return /^(?:@[\w.-]+\/)?[A-Za-z][\w.-]*$/.test(name) ? name : undefined;
}

/** A manifest's `bin` map, normalising the `"bin": "./cli.js"` shorthand. */
export function binMap(manifest) {
  const { bin, name } = manifest;
  if (typeof bin === "string") return { [String(name).replace(/^@[^/]+\//, "")]: bin };
  if (bin && typeof bin === "object") return bin;
  return {};
}

/**
 * npm's own rule, from libnpmexec's `getBinFromManifest`: if every bin points at
 * the same file (which covers the single-bin case) take the first key, otherwise
 * take the bin named after the package without its scope, otherwise refuse.
 * Reimplemented rather than approximated as "exactly one bin", because two keys
 * aliasing one file do resolve and would be a false positive.
 */
export function binFromManifest(manifest) {
  const bin = binMap(manifest);
  const keys = Object.keys(bin);
  if (keys.length === 0) return undefined;
  if (new Set(Object.values(bin)).size === 1) return keys[0];
  const unscoped = String(manifest.name).replace(/^@[^/]+\//, "");
  return bin[unscoped] ? unscoped : undefined;
}

function readManifest(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return typeof manifest?.name === "string" ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every package manifest readable from this checkout, keyed by package name: the
 * packages this repository publishes, plus every declared dependency. That set
 * is what the bin index is built from, so the question "which package publishes
 * this bin" is answered only from manifests a reader would also get.
 *
 * Package *existence*, asked in `packageIndex.get`, is a weaker question and is
 * also answered from an undeclared, hoisted `node_modules` entry: a transitive
 * copy still proves a package by that name is published, which is all a bare
 * `npx <name>` needs.
 */
export function packageIndex(projectRoot = ROOT) {
  const declared = new Map();
  const add = (manifest, origin) => {
    if (manifest && !declared.has(manifest.name)) declared.set(manifest.name, { bin: binMap(manifest), manifest, origin });
  };
  for (const relative of WORKSPACE_MANIFESTS) {
    add(readManifest(path.join(projectRoot, relative)), relative);
  }
  const root = readManifest(path.join(projectRoot, "package.json"));
  for (const name of [
    ...Object.keys(root?.dependencies ?? {}),
    ...Object.keys(root?.devDependencies ?? {}),
    ...Object.keys(root?.optionalDependencies ?? {}),
  ]) {
    add(readManifest(path.join(projectRoot, "node_modules", ...name.split("/"), "package.json")), `node_modules/${name}`);
  }

  const bins = new Map();
  for (const [name, entry] of declared) {
    for (const binName of Object.keys(entry.bin)) {
      if (!bins.has(binName)) bins.set(binName, []);
      bins.get(binName).push(name);
    }
  }

  const hoisted = new Map();
  const get = (name) => {
    if (declared.has(name)) return declared.get(name);
    if (!hoisted.has(name)) {
      const manifest = readManifest(path.join(projectRoot, "node_modules", ...name.split("/"), "package.json"));
      hoisted.set(name, manifest && manifest.name === name ? { bin: binMap(manifest), manifest, origin: `node_modules/${name}` } : undefined);
    }
    return hoisted.get(name);
  };
  return { bins, declared, get };
}

/** Split a shell line into words, honouring quotes so an argument cannot be torn apart. */
export function tokenize(line) {
  const tokens = [];
  let current = "";
  let quote;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\" && index + 1 < line.length) {
      current += line[index + 1];
      started = true;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * The individual commands on one documented line. A block's lines are joined on
 * a trailing backslash first, so a wrapped command is read as the one command a
 * reader would run; `#` starts a comment only at a word boundary, so a fragment
 * identifier inside a URL survives.
 *
 * A trailing comment is read too, from its first `npx` word onward, because
 * `# or: npx ...` offers the reader a second command rather than explaining the
 * first, and an alternative nobody checks is exactly where an unrunnable one
 * survives -- #1596 lived in such a comment. The consequence is deliberate: a
 * code-block comment cannot quote a command in order to warn against it, and
 * must move that warning to the prose around the block, which is where a reader
 * about to copy the block will actually read it.
 */
export function shellCommands(blockContent) {
  const joined = blockContent.replace(/\\\r?\n\s*/g, " ");
  const commands = [];
  const push = (text, inComment) => {
    for (const part of text.split(/&&|\|\||[;|]/)) {
      const tokens = tokenize(part);
      // Drop a `FOO=bar` environment prefix: it is not the command being run.
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
      if (tokens.length > 0) commands.push({ inComment, tokens });
    }
  };
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[$>]\s+/, "");
    const comment = /(?:^|\s)#(.*)$/.exec(line);
    push(comment ? line.slice(0, comment.index) : line, false);
    if (!comment) continue;
    const offered = /(?:^|\s)(npx\s.*)$/.exec(comment[1]);
    if (offered) push(offered[1], true);
  }
  return commands;
}

/** The `-p`/`--package` specs and the positional arguments of one `npx` command. */
export function parseNpxInvocation(tokens) {
  const packages = [];
  const positional = [];
  let index = 1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    const [flag, attached] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
    if (PACKAGE_FLAGS.has(flag)) {
      packages.push(attached ?? tokens[index + 1]);
      if (attached === undefined) index += 1;
      continue;
    }
    if (attached === undefined && VALUE_FLAGS.has(flag)) index += 1;
  }
  positional.push(...tokens.slice(index));
  return { packages: packages.filter((spec) => typeof spec === "string"), positional };
}

/**
 * What npx would do with one documented invocation: `ok`, `unverified` when no
 * manifest on disk describes the package, or `failed` with the reason a reader
 * would see.
 */
export function resolveNpxInvocation({ packages, positional }, index, { installedBins = new Set() } = {}) {
  if (packages.length > 0) {
    const command = positional[0];
    if (!command) return { status: "failed", reason: "`--package` was given without a command to run" };
    const named = packages.map((spec) => packageNameFromSpec(spec)).filter(Boolean);
    const known = named.filter((name) => index.get(name));
    if (known.length === 0) return { status: "unverified", reason: `no manifest on disk for ${named.join(", ") || "the named package"}` };
    const provider = known.find((name) => command in index.get(name).bin);
    if (provider) return { status: "ok", executable: command, package: provider };
    if (known.length < named.length) return { status: "unverified", reason: `${command} is not published by ${known.join(", ")}, and the remaining packages have no manifest on disk` };
    return { status: "failed", reason: `${known.join(", ")} publishes ${Object.keys(index.get(known[0]).bin).join(", ") || "no bin"}, not ${command}` };
  }

  const spec = positional[0];
  if (!spec) return { status: "unverified", reason: "no package or command given" };
  const name = packageNameFromSpec(spec);
  if (!name) return { status: "unverified", reason: `${spec} is a path or URL spec, not a registry package` };

  const entry = index.get(name);
  if (!entry) {
    // The trap worth failing on: npx fetches its first argument as a package, so
    // a bin name typed there is a registry 404 unless the reader has already
    // installed the package that publishes it.
    if (installedBins.has(name)) return { status: "ok", executable: name, via: "local-install" };
    const providers = index.bins.get(name);
    if (providers) {
      return {
        status: "failed",
        reason: `npx fetches its first argument as a package; ${name} is a bin published by ${providers.join(", ")} and no package has that name`,
        suggestion: `npx -p ${providers[0]} ${name}`,
      };
    }
    return { status: "unverified", reason: `no manifest on disk for ${name}` };
  }

  const manifest = entry.manifest;
  const command = binFromManifest(manifest);
  if (!command) {
    const published = Object.keys(binMap(manifest));
    return {
      status: "failed",
      reason: published.length === 0
        ? `${name} publishes no bin, so npx has nothing to run`
        : `npx cannot determine an executable: ${name} publishes ${published.join(", ")} and none is named ${name.replace(/^@[^/]+\//, "")}`,
      suggestion: published.length > 0 ? `npx -p ${name} ${positional[1] && published.includes(positional[1]) ? positional[1] : published[0]}` : undefined,
    };
  }
  // Resolution succeeds, but a reader who wrote the bin name after the package
  // spec gets it swallowed as the bin's first argument rather than run.
  if (positional[1] && positional[1] === command) {
    return {
      status: "failed",
      reason: `${name} resolves to ${command}, so the ${command} written after it is passed to ${command} as an argument, not run as the command`,
      suggestion: `npx -p ${name} ${command}`,
    };
  }
  return { status: "ok", executable: command, package: name };
}

/**
 * The bins a reader has on PATH after the `npm install` lines earlier in a
 * block. A bare `npx <bin>` is runnable once the package publishing it is a
 * local dependency, so a block that installs before it invokes is correct as
 * written -- but only that block: an install in the prose around it is not a
 * command a reader who copies the block ever runs.
 */
function installedBinsFor(commands, upTo, index) {
  const bins = new Set();
  for (let position = 0; position < upTo; position += 1) {
    const { tokens } = commands[position];
    if (tokens[0] !== "npm" || !["add", "i", "install"].includes(tokens[1])) continue;
    for (const token of tokens.slice(2)) {
      if (token.startsWith("-")) continue;
      const name = packageNameFromSpec(token);
      const entry = name && index.get(name);
      if (entry) for (const binName of Object.keys(entry.bin)) bins.add(binName);
    }
  }
  return bins;
}

export function checkMarkdown(markdown, sourcePath, index) {
  const results = [];
  for (const block of extractFencedBlocks(markdown, sourcePath)) {
    if (!SHELL_LANGUAGES.has(block.language)) continue;
    const commands = shellCommands(block.content);
    for (let position = 0; position < commands.length; position += 1) {
      const { inComment, tokens } = commands[position];
      if (tokens[0] !== "npx") continue;
      results.push({
        command: tokens.join(" "),
        location: `${sourcePath}:${block.startLine}`,
        tokens,
        ...(inComment ? { inComment } : {}),
        ...resolveNpxInvocation(parseNpxInvocation(tokens), index, { installedBins: installedBinsFor(commands, position, index) }),
      });
    }
  }
  return results;
}

export function checkDocumentedCommands(projectRoot = ROOT, files = discoverMarkdownFiles(projectRoot)) {
  const index = packageIndex(projectRoot);
  const results = [];
  for (const sourcePath of files) {
    results.push(...checkMarkdown(fs.readFileSync(path.join(projectRoot, sourcePath), "utf8"), sourcePath, index));
  }
  const summary = {
    checked: results.length,
    failed: results.filter((result) => result.status === "failed").length,
    ok: results.filter((result) => result.status === "ok").length,
    unverified: results.filter((result) => result.status === "unverified").length,
  };
  return { files: files.length, results, summary };
}

export function formatFailures(results) {
  return results
    .filter((result) => result.status === "failed")
    .map((result) => `  - ${result.location}${result.inComment ? " (offered in a comment)" : ""}: ${result.command}\n      ${result.reason}${result.suggestion ? `\n      use: ${result.suggestion}` : ""}`)
    .join("\n");
}

function main() {
  const report = checkDocumentedCommands(ROOT);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1]) {
    const output = path.resolve(process.argv[jsonIndex + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.summary.failed > 0) {
    throw new Error(`documented npx commands cannot resolve an executable:\n${formatFailures(report.results)}`);
  }
  const { checked, ok, unverified } = report.summary;
  process.stdout.write(`docsExecutableCommands=ok files=${report.files} checked=${checked} resolved=${ok} unverified=${unverified}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
