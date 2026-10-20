import assert from "node:assert/strict";
import test from "node:test";

import { tokenize } from "../../scripts/docs-executable-commands.mjs";
import { candidateInvocations, classifyProbe, pinnedCommand, probeFor } from "../../scripts/docs-commands-registry.mjs";

// The shape `config/installed-package-certification.v1.json` supplies, reduced
// to the fields this lane reads.
const CANDIDATE = {
  names: new Set(["@honua/sdk-js", "@honua/sdk"]),
  package: { coordinate: "@honua/sdk-js", registry: "https://registry.npmjs.org", version: "0.1.9-beta.0" },
  packages: [
    { coordinate: "@honua/sdk-js", version: "0.1.9-beta.0" },
    { coordinate: "@honua/sdk", version: "0.1.9-beta.0" },
  ],
  release: "2026.1",
};

test("only commands naming a candidate package are executed, and each one once", () => {
  const report = {
    results: [
      { command: "npx -p @honua/sdk-js honua", executable: "honua", package: "@honua/sdk-js", status: "ok" },
      { command: "npx -p @honua/sdk-js honua", executable: "honua", package: "@honua/sdk-js", status: "ok" },
      { command: "npx vitest run", executable: "vitest", package: "vitest", status: "ok" },
      { command: "npx create-vite app", reason: "no manifest on disk", status: "unverified" },
    ],
  };
  assert.deepEqual(
    candidateInvocations(report, CANDIDATE).map((entry) => entry.command),
    ["npx -p @honua/sdk-js honua"],
  );
});

test("a candidate package named in a command is pinned to the candidate version", () => {
  assert.deepEqual(pinnedCommand(["npx", "-p", "@honua/sdk-js", "honua"], CANDIDATE), ["npx", "-p", "@honua/sdk-js@0.1.9-beta.0", "honua"]);
  // A package outside the candidate set is not this release's to pin.
  assert.deepEqual(pinnedCommand(["npx", "-p", "vitest", "vitest"], CANDIDATE), ["npx", "-p", "vitest", "vitest"]);
  // An already-pinned spec is left exactly as the page wrote it.
  assert.deepEqual(pinnedCommand(["npx", "@honua/sdk-js@0.1.8", "honua"], CANDIDATE), ["npx", "@honua/sdk-js@0.1.8", "honua"]);
});

test("the probe keeps what decides the executable and drops what does not", () => {
  // `-p` form: the package is pinned and the command word is kept; the arguments
  // -- including the `<command>` placeholder a shell would read as a redirection
  // -- are replaced, and the receipt says so.
  assert.deepEqual(probeFor(tokenize("npx -p @honua/sdk-js honua <command>"), CANDIDATE), {
    args: ["--yes", "--package", "@honua/sdk-js@0.1.9-beta.0", "honua", "--help"],
    argumentsElided: true,
    probe: "npx --yes --package @honua/sdk-js@0.1.9-beta.0 honua --help",
  });
  assert.deepEqual(probeFor(tokenize("npx -p @honua/sdk-js honua-plugin-certify --verify ./report.json"), CANDIDATE), {
    args: ["--yes", "--package", "@honua/sdk-js@0.1.9-beta.0", "honua-plugin-certify", "--help"],
    argumentsElided: true,
    probe: "npx --yes --package @honua/sdk-js@0.1.9-beta.0 honua-plugin-certify --help",
  });
  // Bare form: the package spec is the whole resolution input.
  assert.deepEqual(probeFor(tokenize("npx @honua/sdk-js honua --help"), CANDIDATE), {
    args: ["--yes", "@honua/sdk-js@0.1.9-beta.0", "--help"],
    argumentsElided: true,
    probe: "npx --yes @honua/sdk-js@0.1.9-beta.0 --help",
  });
  assert.equal(probeFor(tokenize("npx -p @honua/sdk-js honua"), CANDIDATE).argumentsElided, false);
});

test("a probe passes only on positive evidence that the right executable ran", () => {
  assert.deepEqual(classifyProbe({ exitCode: 0, stderr: "", stdout: "honua — command-line client for Honua geospatial servers" }, "honua"), { resolved: true });

  // The failure #1596 reported: npm gives up before the bin is spawned.
  assert.deepEqual(classifyProbe({ exitCode: 1, stderr: "npm error could not determine executable to run", stdout: "" }, "honua"), {
    reason: "npm could not choose a bin from the package",
    resolved: false,
  });
  // A bin name written where npx expects a package.
  assert.equal(classifyProbe({ exitCode: 1, stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/honua-plugin-certify", stdout: "" }, "honua-plugin-certify").resolved, false);
  // Default resolution refusing the coordinated pins is a failure of this lane's
  // premise, not a passing run.
  assert.equal(classifyProbe({ exitCode: 1, stderr: "npm error ERESOLVE could not resolve", stdout: "" }, "honua").resolved, false);

  // The unsound pass this lane was built to avoid: the shell rejected the line
  // before npm ran, so no npm error exists to match. Silence is not evidence.
  assert.deepEqual(classifyProbe({ exitCode: 1, stderr: "The syntax of the command is incorrect.", stdout: "" }, "honua"), {
    reason: "the probe exited 1 without resolving honua",
    resolved: false,
  });
  // A clean exit that produced nothing identifying the executable is not
  // evidence that the executable is the one that produced it.
  assert.deepEqual(classifyProbe({ exitCode: 0, stderr: "", stdout: "" }, "honua"), {
    reason: "the probe exited 0 but nothing identified honua in its output",
    resolved: false,
  });
  assert.equal(classifyProbe({ error: new Error("spawn ENOENT"), exitCode: null, stderr: "", stdout: "" }, "honua").resolved, false);
});
