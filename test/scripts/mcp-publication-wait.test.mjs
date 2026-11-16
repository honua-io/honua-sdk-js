import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

const helper = "bash scripts/wait-required-checks.sh";
const regeneration = fs.readFileSync(new URL("../../.github/workflows/regenerate-derived-artifacts.yml", import.meta.url), "utf8");

const workflow = fs.readFileSync(new URL("../../.github/workflows/mcp-cert-scheduled.yml", import.meta.url), "utf8");
const step = workflow.split("      - name: Merge the validated publication pull request\n")[1]
  .split("      - name: Summarize publication")[0];
const script = step.split("        run: |\n")[1].replace(/^          /gmu, "");

it("both publication validators use the shared required-check helper", () => {
  assert.ok(workflow.includes(helper));
  assert.ok(regeneration.includes(helper));
});

const githubStub = `#!/bin/bash
set -eu
if [[ "$1 $2" == "pr checks" ]]; then
  count=0
  [[ ! -f "$STATE/count" ]] || read -r count < "$STATE/count"
  count=$((count + 1))
  echo "$count" > "$STATE/count"
  case "$MODE" in
    late-pass)
      if (( count <= 35 )); then echo '[]'; exit 1; fi
      if (( count == 36 )); then bucket=pending; else bucket=pass; fi ;;
    missing) echo '[]'; exit 1 ;;
    *) bucket="$MODE" ;;
  esac
  printf '[{"name":"one","bucket":"%s"},{"name":"two","bucket":"%s"},{"name":"three","bucket":"%s"}]\\n' "$bucket" "$bucket" "$bucket"
  [[ "$bucket" == pass ]]
else
  printf '%s\\n' "$*" >> "$STATE/operations"
fi
`;

function runPublication(mode, command = script) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-mcp-publication-"));
  try {
    fs.writeFileSync(path.join(temporaryRoot, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(temporaryRoot, "gh"), githubStub, { mode: 0o755 });
    fs.mkdirSync(path.join(temporaryRoot, "scripts"));
    fs.copyFileSync(new URL("../../scripts/wait-required-checks.sh", import.meta.url),
      path.join(temporaryRoot, "scripts/wait-required-checks.sh"));
    const scriptPath = path.join(temporaryRoot, "workflow.sh");
    fs.writeFileSync(scriptPath, command);
    const result = spawnSync("bash", [scriptPath], {
      cwd: temporaryRoot,
      env: { ...process.env, PATH: `${temporaryRoot}:${process.env.PATH}`, STATE: temporaryRoot,
        MODE: mode, PR_NUMBER: "2608", PUBLISHED: "a".repeat(40), GITHUB_REPOSITORY: "honua-io/honua-sdk-js" },
      encoding: "utf8", timeout: 30_000,
    });
    const operationsPath = path.join(temporaryRoot, "operations");
    return { ...result, operations: fs.existsSync(operationsPath) ? fs.readFileSync(operationsPath, "utf8") : "" };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

it("waits for checks attaching after five minutes, then merges only after all pass", () => {
  const result = runPublication("late-pass");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.operations, /pr merge 2608 .*--match-head-commit a{40}/u);
  assert.match(result.operations, /workflow run regenerate-derived-artifacts.yml/u);
});

for (const mode of ["fail", "cancel", "missing", "pending", "skipping"]) {
  it(`refuses publication when required checks report ${mode}`, () => {
    const result = runPublication(mode);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.operations, "");
  });
}

for (const mode of ["late-pass", "fail", "cancel", "missing", "pending", "skipping"]) {
  it(`shared validator handles ${mode}`, () => {
    const result = runPublication(mode, `${helper} "$PR_NUMBER"`);
    assert.equal(result.status, mode === "late-pass" ? 0 : 1, result.stdout + result.stderr);
    assert.equal(result.operations, "");
  });
}
