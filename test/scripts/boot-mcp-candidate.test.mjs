import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const LOCAL_SHA = "87966c3f7b6c840ffc4d4da0b451714ab717b18a";
const CONTRACT_SHA = "93cad86ec4fb28fba3ff0b9358059d86aa55dde5";
const IMAGE = `ghcr.io/honua-io/honua-server@sha256:${"a".repeat(64)}`;

async function boot(t, actualSha) {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-mcp-boot-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["mcp/scripts", "dist/src/cli", "dist/src/control-plane/generated", "bin"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await copyFile(new URL("../../mcp/scripts/boot-candidate.sh", import.meta.url), path.join(root, "mcp/scripts/boot-candidate.sh"));
  await writeFile(path.join(root, "dist/src/control-plane/generated/admin-operations.js"),
    `export const ADMIN_LOCAL_SERVER_IMAGE = ${JSON.stringify(IMAGE)};\nexport const ADMIN_LOCAL_SERVER_SHA = "${LOCAL_SHA}";\nexport const ADMIN_RELEASE_SERVER_SHA = "${CONTRACT_SHA}";\n`);
  await writeFile(path.join(root, "dist/src/cli/bin.js"), `
    import { mkdirSync, writeFileSync } from "node:fs";
    import path from "node:path";
    const dir = process.argv[process.argv.indexOf("--directory") + 1];
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".env"), "HONUA_ADMIN_KEY=private-fixture-key\\n");
    writeFileSync(path.join(dir, "compose.yaml"), "services: {}\\n");
    console.log(JSON.stringify({ status: "ready", serverImage: ${JSON.stringify(IMAGE)}, baseUrl: "http://localhost:8080" }));
  `);
  await writeFile(path.join(root, "bin/docker"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "compose" && " $* " == *" ps -q honua "* ]]; then echo fixture-container
elif [[ "$1" == "inspect" ]]; then echo "$MOCK_SERVER_SHA"
else echo "Unexpected docker command" >&2; exit 42
fi
`);
  await chmod(path.join(root, "bin/docker"), 0o755);
  const output = path.join(root, "outputs");
  const result = spawnSync("bash", [path.join(root, "mcp/scripts/boot-candidate.sh"), path.join(root, "owned install")], {
    env: { ...process.env, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`, MOCK_SERVER_SHA: actualSha, GITHUB_OUTPUT: output, GITHUB_ACTIONS: "" },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { ...result, outputs: await readFile(output, "utf8").catch(() => "") };
}

test("boot reports verified local binary identity even when the compatibility contract is newer", async (t) => {
  const result = await boot(t, LOCAL_SHA);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.outputs, new RegExp(`server_sha=${LOCAL_SHA}`));
  assert.ok(!result.outputs.includes(CONTRACT_SHA));
  assert.ok(!`${result.stdout}${result.stderr}${result.outputs}`.includes("private-fixture-key"));
});

for (const [name, actualSha] of [["different binary", CONTRACT_SHA], ["missing OCI revision", ""]]) {
  test(`boot refuses certification output for ${name}`, async (t) => {
    const result = await boot(t, actualSha);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /running server revision .* does not match installer pin/);
    assert.equal(result.outputs, "");
  });
}
