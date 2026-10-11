import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESOLUTION_RELAXING_FLAGS,
  coInstallArgs,
  parseArgs,
  publicResolverEnv,
  verifyPair,
} from "../../scripts/verify-client-pair-install.mjs";

test("the co-install command carries no flag that relaxes peer resolution", () => {
  const args = coInstallArgs(["/tmp/honua-sdk-js-0.0.0.tgz", "@honua/mcp-server@0.1.9-beta.0"]);
  for (const flag of RESOLUTION_RELAXING_FLAGS) {
    assert.ok(!args.includes(flag), `${flag} must never appear in the co-install proof`);
  }
  // The gate's whole value is that it resolves peers the way a customer's npm
  // does. `verify:packed-sdk` installs with --legacy-peer-deps for the SDK's own
  // dependency tree, which is exactly why it could not observe #1529.
  assert.ok(args.includes("install"));
  assert.ok(args.includes("/tmp/honua-sdk-js-0.0.0.tgz"));
  assert.ok(args.includes("@honua/mcp-server@0.1.9-beta.0"));
});

test("a relaxing flag smuggled in as a specifier is refused", () => {
  // Someone facing a red gate will reach for --legacy-peer-deps; make that a
  // hard error rather than a silent downgrade of the proof.
  for (const flag of RESOLUTION_RELAXING_FLAGS) {
    assert.throws(
      () => coInstallArgs(["@honua/sdk-js@0.1.9-beta.0", "@honua/mcp-server@0.1.9-beta.0", flag]),
      /relaxes npm peer resolution/,
    );
  }
});

test("a co-install proof needs both halves of the pair", () => {
  assert.throws(() => coInstallArgs(["@honua/sdk-js@0.1.9-beta.0"]), /at least two specifiers/);
  assert.throws(() => coInstallArgs([]), /at least two specifiers/);
});

test("the SDK source defaults to the packed tree and accepts only known lanes", () => {
  assert.deepEqual(parseArgs([]), { sdkSource: "packed", mcpSource: "registry" });
  assert.deepEqual(parseArgs(["--sdk-source", "registry"]), { sdkSource: "registry", mcpSource: "registry" });
  assert.deepEqual(parseArgs(["--sdk-source", "packed"]), { sdkSource: "packed", mcpSource: "registry" });
  assert.throws(() => parseArgs(["--sdk-source", "workspace"]), /must be 'packed' or 'registry'/);
  assert.throws(() => parseArgs(["--legacy-peer-deps"]), /unrecognised argument/);
});


test("packed MCP requires the public SDK and rejects duplicate or invalid options", () => {
  assert.deepEqual(parseArgs(["--sdk-source", "registry", "--mcp-source", "packed"]), { sdkSource: "registry", mcpSource: "packed" });
  assert.throws(() => parseArgs(["--mcp-source", "packed"]), /requires the registry SDK/);
  assert.throws(() => parseArgs(["--mcp-source", "workspace"]), /must be/);
  assert.throws(() => parseArgs(["--mcp-source"]), /must be/);
  assert.throws(() => parseArgs(["--sdk-source", "registry", "--sdk-source", "packed"]), /only be supplied once/);
});

test("public admission ignores inherited npm relaxation and configuration files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-publish-env-"));
  try {
    const env = publicResolverEnv({ PATH: "/bin", NPM_CONFIG_LEGACY_PEER_DEPS: "true", npm_config_force: "true", NPM_CONFIG_USERCONFIG: "/private/npmrc", npm_config_registry: "https://private.invalid", npm_config_strict_peer_deps: "false" }, root);
    assert.equal(env.PATH, "/bin");
    assert.equal(env.NPM_CONFIG_LEGACY_PEER_DEPS, undefined);
    assert.equal(env.npm_config_force, undefined);
    assert.equal(env.npm_config_strict_peer_deps, undefined);
    assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(env.npm_config_registry, "https://registry.npmjs.org");
    assert.equal(env.npm_config_cache, path.join(root, "npm-cache"));
    assert.equal(fs.readFileSync(env.npm_config_userconfig, "utf8"), "");
    assert.equal(fs.readFileSync(env.npm_config_globalconfig, "utf8"), "");
    assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fixture(t, { peer = "^0.1.15", installedSdk = "0.1.15", installedMcp = "0.1.16", missingSdk = false, wrongName = false } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-publish-proof-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, "mcp"));
  fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "@honua/sdk-js", version: "0.1.15", type: "module" }));
  fs.writeFileSync(path.join(projectRoot, "mcp/package.json"), JSON.stringify({ name: "@honua/mcp-server", version: "0.1.16", peerDependencies: { "@honua/sdk-js": peer } }));
  fs.mkdirSync(path.join(projectRoot, "dist/src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist/src/local-install.js"), 'export const LOCAL_INSTALL_MCP_PACKAGE_NAME="@honua/mcp-server"; export const LOCAL_INSTALL_MCP_PACKAGE_VERSION="0.1.16";');
  const calls = [];
  const runNpm = (args, options) => {
    calls.push({ args, ...options });
    if (args[0] === "pack") return { status: 0, stdout: JSON.stringify([{ filename: "candidate.tgz" }]) };
    assert.equal(args[0], "install");
    if (missingSdk) return { status: 1, stdout: "", stderr: "ETARGET public SDK version is not published" };
    for (const [name, version] of [["@honua/sdk-js", installedSdk], ["@honua/mcp-server", installedMcp]]) {
      const root = path.join(options.cwd, "node_modules", name);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: wrongName ? "wrong-package" : name, version, peerDependencies: name === "@honua/mcp-server" ? { "@honua/sdk-js": peer } : undefined }));
    }
    return { status: 0, stdout: "installed" };
  };
  return { projectRoot, runNpm, calls };
}

const publishArgs = ["--sdk-source", "registry", "--mcp-source", "packed"];

test("MCP admission packs only MCP and requests the exact public SDK without fallback", async (t) => {
  const f = fixture(t);
  await verifyPair(publishArgs, f);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].args.at(-1), path.join(f.projectRoot, "mcp"));
  assert.ok(f.calls[0].args.includes("--ignore-scripts"));
  assert.ok(f.calls[1].args.includes("@honua/sdk-js@0.1.15"));
  assert.ok(f.calls[1].args.at(-1).endsWith("candidate.tgz"));
  assert.equal(f.calls[1].env.npm_config_registry, "https://registry.npmjs.org");
  assert.equal(fs.existsSync(f.calls[1].cwd), false, "temporary consumer is removed after success");
});

test("missing public SDK refuses publication with an actionable exact-tag retry and cleanup", async (t) => {
  const f = fixture(t, { missingSdk: true });
  await assert.rejects(verifyPair(publishArgs, f), /retry the same MCP tag after SDK publication.*failed[\s\S]*ETARGET/);
  assert.equal(f.calls.length, 2, "no legacy-peer retry or workspace fallback");
  assert.equal(fs.existsSync(f.calls[1].cwd), false);
});

for (const [name, options, error] of [
  ["incompatible peer", { peer: "^0.2.0" }, /peer|compatible/],
  ["wrong SDK version", { installedSdk: "0.1.14" }, /not the 0.1.15/],
  ["wrong MCP version", { installedMcp: "0.1.15" }, /not the expected 0.1.16/],
  ["wrong package name", { wrongName: true }, /name mismatch/],
]) test(`MCP admission rejects ${name}`, async (t) => {
  const f = fixture(t, options);
  await assert.rejects(verifyPair(publishArgs, f), error);
  assert.equal(fs.existsSync(f.calls.at(-1).cwd), false);
});

for (const sdkSource of ["packed", "registry"]) test(`existing ${sdkSource} SDK and pinned registry MCP lane retains its identities`, async (t) => {
  const f = fixture(t);
  await verifyPair(["--sdk-source", sdkSource], f);
  assert.ok(f.calls.at(-1).args.includes("@honua/mcp-server@0.1.16"));
  assert.equal(f.calls.filter(c => c.args[0] === "pack").length, sdkSource === "packed" ? 1 : 0);
});

test("the publish workflow requires public-peer admission before any npm publication", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/publish-mcp-server.yml"), "utf8");
  const guard = workflow.indexOf("- name: Prove packed MCP installs with its published SDK peer");
  const publish = workflow.indexOf("- name: Publish package");
  assert.ok(guard > 0 && guard < publish);
  const step = workflow.slice(guard, publish);
  assert.ok(step.includes("--sdk-source registry --mcp-source packed"));
  assert.ok(!step.includes("if:"), "dry-run publication must exercise the same admission");
});
