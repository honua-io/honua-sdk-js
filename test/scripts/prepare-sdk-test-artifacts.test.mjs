import assert from "node:assert/strict";
import test from "node:test";

import { resolveNpmRunInvocation } from "../../scripts/lib/npm-run-invocation.mjs";

test("resolves npm invocation for script build on Windows", () => {
  const invocation = resolveNpmRunInvocation("build", { platform: "win32" });
  assert.equal(invocation.command, "npm");
  assert.deepEqual(invocation.args, ["run", "build", "--silent"]);
  assert.equal(invocation.shell, true);
});

test("resolves npm invocation for script compile on Windows", () => {
  const invocation = resolveNpmRunInvocation("compile", { platform: "win32" });
  assert.equal(invocation.command, "npm");
  assert.deepEqual(invocation.args, ["run", "compile", "--silent"]);
  assert.equal(invocation.shell, true);
});

test("falls back to npm command on non-Windows", () => {
  const invocation = resolveNpmRunInvocation("build", { platform: "linux" });
  assert.equal(invocation.command, "npm");
  assert.deepEqual(invocation.args, ["run", "build", "--silent"]);
  assert.equal(invocation.shell, false);
});

test("rejects unsupported script names", () => {
  assert.throws(() => resolveNpmRunInvocation("test"));
});
