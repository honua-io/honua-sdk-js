import assert from "node:assert/strict";
import test from "node:test";

import {
  RESOLUTION_RELAXING_FLAGS,
  coInstallArgs,
  parseArgs,
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
  assert.deepEqual(parseArgs([]), { sdkSource: "packed" });
  assert.deepEqual(parseArgs(["--sdk-source", "registry"]), { sdkSource: "registry" });
  assert.deepEqual(parseArgs(["--sdk-source", "packed"]), { sdkSource: "packed" });
  assert.throws(() => parseArgs(["--sdk-source", "workspace"]), /must be 'packed' or 'registry'/);
  assert.throws(() => parseArgs(["--legacy-peer-deps"]), /unrecognised argument/);
});
