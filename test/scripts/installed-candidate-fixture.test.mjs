import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeCandidateFixture } from "../../scripts/installed-candidate-fixture.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const candidate = { server: { image: "ghcr.io/honua-io/honua@sha256:0000000000000000000000000000000000000000000000000000000000000000" } };

// certify() writes a failed fixture's error.message into install.diagnostic, and that receipt
// is uploaded by CI under `if: always()`. A docker that echoes the argument vector back on
// failure is therefore a publication channel for the ephemeral fixture secrets.
test("a failing container start redacts the ephemeral fixture secrets from the diagnostic", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "installed-candidate-fixture-test-"));
  try {
    const secrets = new Set();
    const named = (args) => args[args.indexOf("--name") + 1] ?? "";
    const spawn = (command, args) => {
      if (command !== "docker") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "run" && named(args).endsWith("-server")) {
        for (const value of args) {
          const match = /^-?-?e?=?(?:POSTGRES_PASSWORD|HONUA_ADMIN_PASSWORD|Security__ConnectionEncryption__(?:MasterKey|Salt)|Operations__SecretChannel__KeyRingCertificatePassword)=(.+)$/.exec(value);
          if (match) secrets.add(match[1].startsWith("Aa1!") ? match[1].slice(4) : match[1]);
        }
        return { status: 1, stdout: "", stderr: `failed to start: ${args.join(" ")}` };
      }
      if (args[0] === "logs") return { status: 0, stdout: [...secrets].map((s) => `Unhandled exception: ${s}`).join("\n"), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    const error = await executeCandidateFixture({ candidate, work, root, spawn }).then(() => null, (thrown) => thrown);
    assert.ok(error, "the fixture must reject when the candidate container fails to start");
    assert.equal(secrets.size, 4, "the fixture must pass a password, a master key, a salt and a key-ring password to the candidate");
    assert.match(error.message, /candidate fixture docker run failed/, "the diagnostic must name the failing subcommand");
    for (const secret of secrets) {
      assert.ok(!error.message.includes(secret), `ephemeral fixture secret leaked into the published diagnostic: ${error.message}`);
    }
    assert.match(error.message, /\[redacted\]/, "the redaction must be visible in the diagnostic");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("the candidate server is given a mounted PKCS#12 key-ring certificate", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "installed-candidate-fixture-test-"));
  try {
    let serverArgs;
    const named = (args) => args[args.indexOf("--name") + 1] ?? "";
    const spawn = (command, args) => {
      if (command !== "docker") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "run" && named(args).endsWith("-server")) {
        serverArgs = args;
        return { status: 1, stdout: "", stderr: "failed to start" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    await executeCandidateFixture({ candidate, work, root, spawn }).then(() => null, () => null);
    assert.ok(serverArgs, "the candidate server run must have been attempted");
    assert.ok(serverArgs.includes("Operations__SecretChannel__KeyRingCertificatePath=/app/keyring.p12"));
    assert.ok(serverArgs.some((arg) => /^\/tmp\/.*keyring\.p12:\/app\/keyring\.p12:ro$/.test(arg) || arg.endsWith("keyring.p12:/app/keyring.p12:ro")));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

for (const rejectedPhase of [undefined, "first boot", "seeded restart"]) {
  test(`server owns migrations before seeding; readiness rejection: ${rejectedPhase ?? "none"}`, async () => {
    const work = await mkdtemp(path.join(tmpdir(), "installed-candidate-fixture-test-"));
    const events = [];
    let restarted = false;
    const spawn = (command, args, options = {}) => {
      if (command === process.execPath) {
        events.push("consumer");
        writeFileSync(args[1], JSON.stringify([{ id: "unexecuted", verdict: "blocked" }]));
        return { status: 0, stdout: "", stderr: "" };
      }
      assert.equal(command, "docker");
      assert.ok(!args.some((arg) => arg.includes("HONUA_APPROVE_CONTRACT_MIGRATIONS")));
      if (args[0] === "exec" && args.includes("psql")) {
        events.push(options.input ? "seed" : "extensions");
        if (!options.input) assert.match(args.at(-1), /postgis;.*postgis_raster/);
      }
      if (args[0] === "run" && args.includes(candidate.server.image)) events.push("boot");
      if (args[0] === "restart") { events.push("restart"); restarted = true; }
      if (args[0] === "image" || (args[0] === "inspect" && args.includes("{{.Image}}"))) return { status: 0, stdout: "sha256:fixture", stderr: "" };
      if (args[0] === "inspect") {
        const rejected = rejectedPhase === (restarted ? "seeded restart" : "first boot");
        return { status: 0, stdout: JSON.stringify({ Running: !rejected, ExitCode: rejected ? 1 : 0, OOMKilled: false }), stderr: "" };
      }
      if (args[0] === "logs") return { status: 0, stdout: "Migration safety gate blocked pending contract-phase migration(s) on an existing database: migration.sql. These reviewed (annotated) contract migrations", stderr: "" };
      if (args[0] === "port") return { status: 0, stdout: "127.0.0.1:12345", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    try {
      const execute = () => executeCandidateFixture({ candidate, work, root, spawn,
        fetch: async () => { events.push("ready"); return { ok: true }; } });
      if (rejectedPhase) await assert.rejects(execute, (error) => error.message.includes(`before readiness (${rejectedPhase})`));
      else await execute();
      assert.deepEqual(events, rejectedPhase === "first boot" ? ["extensions", "boot"]
        : rejectedPhase === "seeded restart" ? ["extensions", "boot", "ready", "seed", "restart"]
          : ["extensions", "boot", "ready", "seed", "restart", "ready", "consumer"]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
}
