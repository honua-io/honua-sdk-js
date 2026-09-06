import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeCandidateFixture } from "../../scripts/installed-candidate-fixture.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const candidate = { server: { image: "ghcr.io/honua-io/honua@sha256:0000000000000000000000000000000000000000000000000000000000000000" } };

// certify() writes a failed fixture's error.message into install.diagnostic, and that receipt
// is uploaded by CI under `if: always()`. A docker that echoes the argument vector back on
// failure is therefore a publication channel for the ephemeral fixture secrets.
test("a failing container start redacts the ephemeral fixture secrets from the diagnostic", async () => {
  const secrets = new Set();
  const named = (args) => args[args.indexOf("--name") + 1] ?? "";
  const spawn = (command, args) => {
    if (command !== "docker") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "run" && named(args).endsWith("-server")) {
      for (const value of args) {
        const match = /^-?-?e?=?(?:POSTGRES_PASSWORD|HONUA_ADMIN_PASSWORD|Security__ConnectionEncryption__(?:MasterKey|Salt))=(.+)$/.exec(value);
        if (match) secrets.add(match[1].startsWith("Aa1!") ? match[1].slice(4) : match[1]);
      }
      return { status: 1, stdout: "", stderr: `failed to start: ${args.join(" ")}` };
    }
    if (args[0] === "logs") return { status: 0, stdout: [...secrets].map((s) => `Unhandled exception: ${s}`).join("\n"), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };

  const error = await executeCandidateFixture({ candidate, work: root, root, spawn }).then(() => null, (thrown) => thrown);
  assert.ok(error, "the fixture must reject when the candidate container fails to start");
  assert.equal(secrets.size, 3, "the fixture must pass a password, a master key and a salt to the candidate");
  assert.match(error.message, /candidate fixture docker run failed/, "the diagnostic must name the failing subcommand");
  for (const secret of secrets) {
    assert.ok(!error.message.includes(secret), `ephemeral fixture secret leaked into the published diagnostic: ${error.message}`);
  }
  assert.match(error.message, /\[redacted\]/, "the redaction must be visible in the diagnostic");
});
