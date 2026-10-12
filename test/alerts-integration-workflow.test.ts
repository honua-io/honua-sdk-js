import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/integration.yml", import.meta.url), "utf8"));
const steps = workflow.jobs.integration.steps as Array<{ name: string; run?: string }>;
const alerts = steps.find((step) => step.name === "Run Pro alerts integration surface");

// Execute the actual workflow shell with disposable command doubles. This
// proves both modes run and failures survive the loop, without a live server.
function runFixture(failingMode = "") {
  const directory = mkdtempSync(join(tmpdir(), "honua-alerts-workflow-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    mkdirSync(join(directory, "test-results"));
    const stub = join(bin, "command.mjs");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const mode = process.env.HONUA_INTEGRATION_ALERTS_ENABLED;
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({name, args, mode}) + "\n");
if (name === "npx") {
  const output = args.find(arg => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
  writeFileSync(output, JSON.stringify({success: mode !== process.env.FAILING_MODE}));
  process.exit(mode === process.env.FAILING_MODE ? 1 : 0);
}
`,
      { mode: 0o755 },
    );
    for (const name of ["docker", "curl", "npx"]) symlinkSync(stub, join(bin, name));
    const scriptPath = join(directory, "workflow.sh");
    writeFileSync(scriptPath, alerts?.run ?? "exit 99");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COMMAND_LOG: join(directory, "commands.jsonl"),
        FAILING_MODE: failingMode,
        SELF_CONTAINED_KEYRING_CERTIFICATE: "/fixture/keyring.pfx",
        SELF_CONTAINED_ADMIN_PASSWORD: "fixture-password",
        SELF_CONTAINED_PG_PASSWORD: "fixture-password",
        SELF_CONTAINED_ENC_MASTER_KEY: "fixture-master-key",
        SELF_CONTAINED_ENC_SALT: "fixture-salt",
        SELF_CONTAINED_KEYRING_PASSWORD: "fixture-password",
        HONUA_INTEGRATION_SERVER_IMAGE: `ghcr.io/honua-io/honua-server@sha256:${"a".repeat(64)}`,
      },
    });
    if (result.error) throw result.error;
    const commands = readFileSync(join(directory, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; args: string[]; mode?: string });
    return { status: result.status, commands };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Preview alerts integration fixture", () => {
  it.each(["", "false", "true"])("retains both modes and propagates a failure in %j", (failingMode) => {
    const { status, commands } = runFixture(failingMode);
    expect(status).toBe(failingMode ? 1 : 0);
    const tests = commands.filter((command) => command.name === "npx");
    expect(tests.map((command) => command.mode)).toEqual(["false", "true"]);
    const boots = commands.filter((command) => command.name === "docker" && command.args[0] === "run");
    expect(boots).toHaveLength(2);
    for (const [index, mode] of ["false", "true"].entries()) {
      expect(boots[index]?.args).toEqual(
        expect.arrayContaining([
          "honua-server-alerts",
          "Licensing__DevGrantEdition=Pro",
          "MultiTenancy__Enabled=false",
          "MultiTenancy__SchemaRouting__Enabled=false",
          `Capabilities__Experimental__alerts.geofence__Enabled=${mode}`,
          `ghcr.io/honua-io/honua-server@sha256:${"a".repeat(64)}`,
        ]),
      );
      expect(tests[index]?.args).toContain(`--outputFile=test-results/integration-alerts-${mode}-vitest.json`);
    }
    // The opt-in is the only difference between the two container commands.
    expect(
      boots[0]?.args.map((arg) =>
        arg.replace(
          "Capabilities__Experimental__alerts.geofence__Enabled=false",
          "Capabilities__Experimental__alerts.geofence__Enabled=true",
        ),
      ),
    ).toEqual(
      boots[1]?.args.map((arg) =>
        arg.replace(
          "Capabilities__Experimental__alerts.geofence__Enabled=false",
          "Capabilities__Experimental__alerts.geofence__Enabled=true",
        ),
      ),
    );
  });

  it("uses the reviewed literal identity for both fixtures while preserving external target overrides", () => {
    expect(workflow.env.HONUA_INTEGRATION_SERVER_IMAGE).toBe(
      "ghcr.io/honua-io/honua-server@sha256:3ef3bd41a2f84d1f3a6194c11db496f741cc4d869b54bf57e9d7067dd9cf3d39",
    );
    expect(workflow.env.HONUA_INTEGRATION_SERVER_COMMIT).toBe("ff5f5671903e96e13cffac7b73546c3ed0f853c5");
    expect(workflow.env.HONUA_CANDIDATE_CUT_AT).toBe("2026-10-04T08:09:54Z");
    const environment = workflow.jobs.integration.env;
    expect(environment.HONUA_INTEGRATION_SERVER_COMMIT_OVERRIDE).toContain("github.event.inputs.server_commit");
    expect(environment.HONUA_INTEGRATION_EXTERNAL_SERVER_IMAGE).toContain("github.event.inputs.server_image");
    expect(environment.HONUA_CANDIDATE_CUT_AT_OVERRIDE).toContain("github.event.inputs.candidate_cut_at");
    const community = steps.find((step) => step.name === "Start self-contained Honua Server")?.run;
    expect(community).toContain('"$HONUA_INTEGRATION_SERVER_IMAGE"');
    expect(alerts?.run).toContain('"$HONUA_INTEGRATION_SERVER_IMAGE"');
  });

  it("keeps the Community fixture separate and requires both raw reports in the merge", () => {
    const community = steps.find((step) => step.name === "Start self-contained Honua Server")?.run;
    expect(community).toBeDefined();
    expect(community).not.toContain("Capabilities__Experimental__alerts.geofence__Enabled");
    expect(community).not.toContain("Licensing__DevGrantEdition=Pro");
    const merge = steps.find((step) => step.name === "Merge integration surface reports")?.run;
    expect(merge).toContain("integration-alerts-false-vitest.json");
    expect(merge).toContain("integration-alerts-true-vitest.json");
  });
});
