import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const HARDCODED_IAM_ROLE_ARN = /arn:aws:iam::[0-9]{12}:role\//;

test("no workflow hardcodes a live AWS IAM role ARN", () => {
  const offenders = readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .filter((name) => HARDCODED_IAM_ROLE_ARN.test(readFileSync(path.join(WORKFLOWS_DIR, name), "utf8")));

  assert.deepEqual(offenders, [], `Hardcoded AWS IAM role ARN found in: ${offenders.join(", ")}`);
});

test("mcp-eval-live.yml reads Bedrock OIDC role from vars.HONUA_MCP_EVAL_BEDROCK_ROLE_ARN and fails closed", () => {
  const source = readFileSync(path.join(WORKFLOWS_DIR, "mcp-eval-live.yml"), "utf8").replaceAll("\r\n", "\n");
  assert.match(
    source,
    /role-to-assume:\s*\$\{\{\s*vars\.HONUA_MCP_EVAL_BEDROCK_ROLE_ARN\s*\}\}/,
    "mcp-eval-live.yml must source role-to-assume from vars.HONUA_MCP_EVAL_BEDROCK_ROLE_ARN",
  );

  const match = source.match(
    /- name: Require Bedrock OIDC role\n\s+env:\n\s+ROLE_ARN:\s*\$\{\{\s*vars\.HONUA_MCP_EVAL_BEDROCK_ROLE_ARN\s*\}\}\n\s+run:\s*\|\n((?: {10}.*\n)+)/,
  );
  assert.ok(match, "mcp-eval-live.yml must include a 'Require Bedrock OIDC role' validation step");

  const scriptBody = match[1].replace(/^ {10}/gm, "");
  const scratchDir = mkdtempSync(path.join(tmpdir(), "honua-oidc-role-"));
  const scriptPath = path.join(scratchDir, "check-role.sh");
  try {
    writeFileSync(scriptPath, scriptBody, "utf8");

    const emptyRes = spawnSync("bash", [scriptPath], {
      env: { PATH: process.env.PATH ?? "", ROLE_ARN: "" },
      encoding: "utf8",
    });
    assert.equal(emptyRes.error, undefined, `failed to spawn bash: ${emptyRes.error}`);
    assert.notEqual(emptyRes.status, 0, "empty ROLE_ARN must fail closed");

    const wrongRoleRes = spawnSync("bash", [scriptPath], {
      env: {
        PATH: process.env.PATH ?? "",
        ROLE_ARN: "arn:aws:iam::123456789012:role/other-role",
      },
      encoding: "utf8",
    });
    assert.equal(wrongRoleRes.error, undefined, `failed to spawn bash: ${wrongRoleRes.error}`);
    assert.notEqual(wrongRoleRes.status, 0, "unexpected role name must fail closed");

    const validRes = spawnSync("bash", [scriptPath], {
      env: {
        PATH: process.env.PATH ?? "",
        ROLE_ARN: "arn:aws:iam::123456789012:role/honua-sdk-js-gha-bedrock-eval",
      },
      encoding: "utf8",
    });
    assert.equal(validRes.error, undefined, `failed to spawn bash: ${validRes.error}`);
    assert.equal(validRes.status, 0, `valid ROLE_ARN failed: ${validRes.stdout}${validRes.stderr}`);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
