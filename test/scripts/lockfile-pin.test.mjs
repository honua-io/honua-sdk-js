import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertLockfilePinInSync,
  assertMechanicalVersionBump,
  BOUND_PIN_PATHS,
  inspectLockfilePinAt,
  lockfileDigest,
  manifestVersion,
  PIN_POLICY_PATH,
  PIN_WORKFLOW_PATH,
  readPinnedDigest,
  writeLockfilePinAt,
  writePinnedDigest,
} from "../../scripts/lib/lockfile-pin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OTHER_DIGEST = "0".repeat(64);

/**
 * A checkout copy carrying only what the pin binds, so a test can mutate a real
 * lockfile and a real pair of bound files without touching the repository.
 *
 * Normalised to in-sync on the way in, so that a mutation test reports the
 * mutation and nothing else. Whether the repository itself is in sync is the
 * subject of its own test, and of the guard in the sample-bundle attestation
 * suite; it must not also decide the outcome here.
 */
async function scratchCheckout(t) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "honua-lockfile-pin-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const file of ["package-lock.json", ...BOUND_PIN_PATHS]) {
    await mkdir(path.join(scratch, path.dirname(file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(scratch, file));
  }
  await writeLockfilePinAt(scratch, lockfileDigest(await readFile(path.join(scratch, "package-lock.json"))));
  assert.equal((await inspectLockfilePinAt(scratch)).status, "in-sync");
  return scratch;
}

async function mutateLockfile(scratch, mutate) {
  const text = await readFile(path.join(scratch, "package-lock.json"), "utf8");
  const lockfile = JSON.parse(text);
  mutate(lockfile);
  const mutated = `${JSON.stringify(lockfile, null, 2)}\n`;
  // A mutation test that mutated nothing would pass vacuously.
  assert.notEqual(mutated, text);
  await writeFile(path.join(scratch, "package-lock.json"), mutated);
  return { pristine: text, mutated };
}

let smuggleCounter = 0;

/** One more installed dependency, nothing else: the plausible smuggle. */
function smuggledDependency(lockfile) {
  smuggleCounter += 1;
  const name = `honua-undeclared-dependency-${smuggleCounter}`;
  lockfile.packages[`node_modules/${name}`] = {
    version: "1.0.0",
    resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    integrity: `sha512-${"A".repeat(86)}==`,
  };
}

describe("the pinned lockfile digest", () => {
  it("is in sync in this checkout, with both bound copies agreeing", async () => {
    const result = await inspectLockfilePinAt(root);
    assert.equal(result.status, "in-sync", result.message);
    assert.equal(result.pinned[PIN_WORKFLOW_PATH], result.actual);
    assert.equal(result.pinned[PIN_POLICY_PATH], result.actual);
    assert.equal(lockfileDigest(await readFile(path.join(root, "package-lock.json"))), result.actual);
  });

  // The guard is the whole point of the pin: sample-bundle publication is
  // content-addressed against an exact lockfile, and a fix that made this stop
  // failing would be worse than the release lane it unblocked (#1357).
  it("still fails when a lockfile change lands without moving the pin", async (t) => {
    const scratch = await scratchCheckout(t);
    assert.equal((await inspectLockfilePinAt(scratch)).status, "in-sync");

    const { mutated } = await mutateLockfile(scratch, smuggledDependency);
    const stale = await inspectLockfilePinAt(scratch);
    assert.equal(stale.status, "stale");
    assert.equal(stale.actual, lockfileDigest(Buffer.from(mutated)));
    assert.match(stale.message, /^package-lock\.json now hashes to [0-9a-f]{64}\./u);
    await assert.rejects(() => assertLockfilePinInSync(scratch), { message: stale.message });
  });

  it("names both bound files when it fails", async (t) => {
    const scratch = await scratchCheckout(t);
    await mutateLockfile(scratch, smuggledDependency);
    const { message } = await inspectLockfilePinAt(scratch);
    for (const boundPath of BOUND_PIN_PATHS) assert.ok(message.includes(boundPath), message);
    assert.match(message, /sample-bundle publication will fail at dispatch/u);
  });

  it("fails when only one of the two bound copies is updated", async (t) => {
    const scratch = await scratchCheckout(t);
    const { mutated } = await mutateLockfile(scratch, smuggledDependency);
    const digest = lockfileDigest(Buffer.from(mutated));
    const policy = path.join(scratch, PIN_POLICY_PATH);
    await writeFile(policy, writePinnedDigest(await readFile(policy, "utf8"), PIN_POLICY_PATH, digest));

    const unbound = await inspectLockfilePinAt(scratch);
    assert.equal(unbound.status, "unbound");
    assert.match(unbound.message, /disagrees between its bound copies/u);
    for (const boundPath of BOUND_PIN_PATHS) assert.ok(unbound.message.includes(boundPath), unbound.message);
  });

  it("passes only once both bound copies move with the lockfile", async (t) => {
    const scratch = await scratchCheckout(t);
    const { mutated } = await mutateLockfile(scratch, smuggledDependency);
    const changed = await writeLockfilePinAt(scratch, lockfileDigest(Buffer.from(mutated)));
    assert.deepEqual(changed, [...BOUND_PIN_PATHS]);
    const synced = await assertLockfilePinInSync(scratch);
    assert.equal(synced.status, "in-sync");
    // Rewriting is idempotent, so a re-run of the synchroniser is a no-op.
    assert.deepEqual(await writeLockfilePinAt(scratch, synced.actual), []);
  });

  it("rewrites nothing but the digest in each bound file", async (t) => {
    const scratch = await scratchCheckout(t);
    const before = await Promise.all(BOUND_PIN_PATHS.map((p) => readFile(path.join(scratch, p), "utf8")));
    await writeLockfilePinAt(scratch, OTHER_DIGEST);
    const after = await Promise.all(BOUND_PIN_PATHS.map((p) => readFile(path.join(scratch, p), "utf8")));
    BOUND_PIN_PATHS.forEach((boundPath, index) => {
      assert.equal(readPinnedDigest(after[index], boundPath), OTHER_DIGEST);
      assert.equal(
        after[index].replace(OTHER_DIGEST, readPinnedDigest(before[index], boundPath)),
        before[index],
      );
    });
  });

  it("refuses a bound file that does not declare the pin exactly once", () => {
    assert.throws(() => readPinnedDigest("nothing here", PIN_WORKFLOW_PATH), /exactly once; found 0/u);
    const doubled = `          EXPECTED_LOCKFILE_SHA256: ${OTHER_DIGEST}\n`.repeat(2);
    assert.throws(() => readPinnedDigest(doubled, PIN_WORKFLOW_PATH), /exactly once; found 2/u);
    assert.throws(() => writePinnedDigest("nothing here", PIN_POLICY_PATH, OTHER_DIGEST), /exactly once/u);
    assert.throws(() => writePinnedDigest(`export const EXPECTED_LOCKFILE_SHA256 =\n  "${OTHER_DIGEST}";`, PIN_POLICY_PATH, "not-a-digest"), /64 lowercase hex/u);
  });
});

describe("the release version-bump gate", () => {
  const base = JSON.stringify(
    {
      name: "@honua/sdk-js",
      version: "0.1.7-beta.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "@honua/sdk-js", version: "0.1.7-beta.0", dependencies: { left: "^1.0.0" } },
        "node_modules/left": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/left/-/left-1.0.0.tgz",
          integrity: `sha512-${"B".repeat(86)}==`,
        },
      },
    },
    null,
    2,
  );

  function bumped(mutate = () => {}) {
    const next = JSON.parse(base);
    next.version = "0.1.8-beta.0";
    next.packages[""].version = "0.1.8-beta.0";
    mutate(next);
    return JSON.stringify(next, null, 2);
  }

  const bump = { baseVersion: "0.1.7-beta.0", headVersion: "0.1.8-beta.0" };

  it("accepts a lockfile that differs from trunk only in first-party versions", () => {
    const result = assertMechanicalVersionBump({ baseLockfileText: base, headLockfileText: bumped(), ...bump });
    assert.deepEqual(
      result.differences.map((difference) => difference.path.join(".")),
      ["packages..version", "version"],
    );
  });

  // This is what stops the release branch becoming the smuggling path that
  // "derive the digest on release branches only" would have opened.
  it("rejects an added dependency riding along with the version bump", () => {
    assert.throws(
      () => assertMechanicalVersionBump({ baseLockfileText: base, headLockfileText: bumped(smuggledDependency), ...bump }),
      /undeclared lockfile change/u,
    );
  });

  it("rejects a removed dependency", () => {
    assert.throws(
      () =>
        assertMechanicalVersionBump({
          baseLockfileText: base,
          headLockfileText: bumped((next) => {
            delete next.packages["node_modules/left"];
          }),
          ...bump,
        }),
      /undeclared lockfile change/u,
    );
  });

  it("rejects a re-pointed dependency tarball or integrity value", () => {
    for (const mutate of [
      (next) => {
        next.packages["node_modules/left"].resolved = "https://example.invalid/left-1.0.0.tgz";
      },
      (next) => {
        next.packages["node_modules/left"].integrity = `sha512-${"C".repeat(86)}==`;
      },
      (next) => {
        next.packages[""].dependencies.left = "^2.0.0";
      },
    ]) {
      assert.throws(
        () => assertMechanicalVersionBump({ baseLockfileText: base, headLockfileText: bumped(mutate), ...bump }),
        /undeclared lockfile change/u,
      );
    }
  });

  it("rejects a dependency version moved to look like the release bump", () => {
    // Same from/to strings as the legitimate bump, but on an installed package
    // rather than a package local to this repository.
    const headLockfileText = bumped((next) => {
      next.packages["node_modules/left"].version = "0.1.8-beta.0";
    });
    const baseLockfileText = JSON.parse(base);
    baseLockfileText.packages["node_modules/left"].version = "0.1.7-beta.0";
    assert.throws(
      () =>
        assertMechanicalVersionBump({
          baseLockfileText: JSON.stringify(baseLockfileText, null, 2),
          headLockfileText,
          ...bump,
        }),
      /installed dependency, not a package local to this repository/u,
    );
  });

  it("rejects a bump that leaves the lockfile untouched, or no bump at all", () => {
    assert.throws(
      () => assertMechanicalVersionBump({ baseLockfileText: base, headLockfileText: base, ...bump }),
      /left package-lock\.json untouched/u,
    );
    assert.throws(
      () =>
        assertMechanicalVersionBump({
          baseLockfileText: base,
          headLockfileText: bumped(),
          baseVersion: "0.1.8-beta.0",
          headVersion: "0.1.8-beta.0",
        }),
      /same version as trunk/u,
    );
    assert.throws(
      () => assertMechanicalVersionBump({ baseLockfileText: base, headLockfileText: bumped(), ...bump, headVersion: "latest" }),
      /two exact semantic versions/u,
    );
  });

  it("reads the release version from a package manifest", () => {
    assert.equal(manifestVersion('{"version":"0.1.8-beta.0"}', "manifest"), "0.1.8-beta.0");
    assert.throws(() => manifestVersion('{"version":"latest"}', "manifest"), /exact semantic version/u);
    assert.throws(() => manifestVersion("{}", "manifest"), /exact semantic version/u);
  });
});
