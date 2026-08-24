import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertLockfilePinInSync,
  BOUND_PIN_PATHS,
  inspectLockfilePinAt,
  lockfileDependencyDigest,
  lockfileDependencyProjection,
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
 * Normalised to in-sync on the way in, so a mutation test reports the mutation
 * and nothing else. Whether the repository itself is in sync is the subject of
 * its own test; it must not also decide the outcome here.
 */
async function scratchCheckout(t) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "honua-lockfile-pin-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const file of ["package-lock.json", ...BOUND_PIN_PATHS]) {
    await mkdir(path.join(scratch, path.dirname(file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(scratch, file));
  }
  await writeLockfilePinAt(scratch, lockfileDependencyDigest(await readFile(path.join(scratch, "package-lock.json"))));
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

/** What Release Please does to the lockfile when it cuts a release. */
function releaseVersionBump(lockfile, version = "9.9.9-beta.0") {
  lockfile.version = version;
  lockfile.packages[""].version = version;
}

describe("the pinned lockfile digest", () => {
  it("is in sync in this checkout, with both bound copies agreeing", async () => {
    const result = await inspectLockfilePinAt(root);
    assert.equal(result.status, "in-sync", result.message);
    assert.equal(result.pinned[PIN_WORKFLOW_PATH], result.actual);
    assert.equal(result.pinned[PIN_POLICY_PATH], result.actual);
    assert.equal(lockfileDependencyDigest(await readFile(path.join(root, "package-lock.json"))), result.actual);
  });

  // The guard is the whole point of the pin: sample-bundle publication is
  // content-addressed against an exact dependency set, and a fix that made this
  // stop failing would have been worse than the release lane it unblocked
  // (#1357).
  it("still fails when a lockfile change lands without moving the pin", async (t) => {
    const scratch = await scratchCheckout(t);
    const { mutated } = await mutateLockfile(scratch, smuggledDependency);
    const stale = await inspectLockfilePinAt(scratch);
    assert.equal(stale.status, "stale");
    assert.equal(stale.actual, lockfileDependencyDigest(mutated));
    assert.match(stale.message, /^package-lock\.json dependencies now hash to [0-9a-f]{64}\./u);
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
    const policy = path.join(scratch, PIN_POLICY_PATH);
    await writeFile(
      policy,
      writePinnedDigest(await readFile(policy, "utf8"), PIN_POLICY_PATH, lockfileDependencyDigest(mutated)),
    );

    const unbound = await inspectLockfilePinAt(scratch);
    assert.equal(unbound.status, "unbound");
    assert.match(unbound.message, /disagrees between its bound copies/u);
    for (const boundPath of BOUND_PIN_PATHS) assert.ok(unbound.message.includes(boundPath), unbound.message);
  });

  it("passes only once both bound copies move with the dependency set", async (t) => {
    const scratch = await scratchCheckout(t);
    const { mutated } = await mutateLockfile(scratch, smuggledDependency);
    assert.deepEqual(await writeLockfilePinAt(scratch, lockfileDependencyDigest(mutated)), [...BOUND_PIN_PATHS]);
    const synced = await assertLockfilePinInSync(scratch);
    assert.equal(synced.status, "in-sync");
    assert.deepEqual(await writeLockfilePinAt(scratch, synced.actual), []);
  });

  it("rewrites nothing but the digest in each bound file", async (t) => {
    const scratch = await scratchCheckout(t);
    const before = await Promise.all(BOUND_PIN_PATHS.map((p) => readFile(path.join(scratch, p), "utf8")));
    await writeLockfilePinAt(scratch, OTHER_DIGEST);
    const after = await Promise.all(BOUND_PIN_PATHS.map((p) => readFile(path.join(scratch, p), "utf8")));
    BOUND_PIN_PATHS.forEach((boundPath, index) => {
      assert.equal(readPinnedDigest(after[index], boundPath), OTHER_DIGEST);
      assert.equal(after[index].replace(OTHER_DIGEST, readPinnedDigest(before[index], boundPath)), before[index]);
    });
  });

  it("refuses a bound file that does not declare the pin exactly once", () => {
    assert.throws(() => readPinnedDigest("nothing here", PIN_WORKFLOW_PATH), /exactly once; found 0/u);
    const doubled = `          EXPECTED_LOCKFILE_SHA256: ${OTHER_DIGEST}\n`.repeat(2);
    assert.throws(() => readPinnedDigest(doubled, PIN_WORKFLOW_PATH), /exactly once; found 2/u);
    assert.throws(() => writePinnedDigest("nothing here", PIN_POLICY_PATH, OTHER_DIGEST), /exactly once/u);
    assert.throws(
      () =>
        writePinnedDigest(
          `export const EXPECTED_LOCKFILE_SHA256 =\n  "${OTHER_DIGEST}";`,
          PIN_POLICY_PATH,
          "not-a-digest",
        ),
      /64 lowercase hex/u,
    );
  });
});

describe("the lockfile dependency projection", () => {
  const base = `${JSON.stringify(
    {
      name: "@honua/sdk-js",
      version: "0.1.7-beta.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "@honua/sdk-js", version: "0.1.7-beta.0", dependencies: { left: "^1.0.0" } },
        "packages/create-honua-app": { name: "create-honua-app", version: "0.1.7-beta.0" },
        "node_modules/left": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/left/-/left-1.0.0.tgz",
          integrity: `sha512-${"B".repeat(86)}==`,
        },
      },
    },
    null,
    2,
  )}\n`;

  function variant(mutate) {
    const next = JSON.parse(base);
    mutate(next);
    return `${JSON.stringify(next, null, 2)}\n`;
  }

  // This is the property that replaced the release-branch deadlock: the one
  // mechanical lockfile change Release Please makes cannot move the digest, so
  // no job ever has to rewrite the pin -- which is just as well, since
  // GITHUB_TOKEN cannot commit to .github/workflows/** at all (#1357).
  it("is blind to a release version bump, on every first-party package", () => {
    assert.equal(lockfileDependencyDigest(variant(releaseVersionBump)), lockfileDependencyDigest(base));
    assert.equal(
      lockfileDependencyDigest(
        variant((l) => {
          releaseVersionBump(l);
          l.packages["packages/create-honua-app"].version = "9.9.9-beta.0";
        }),
      ),
      lockfileDependencyDigest(base),
    );
  });

  it("matches the real trunk lockfile through a simulated release bump", async () => {
    const trunk = await readFile(path.join(root, "package-lock.json"), "utf8");
    const released = JSON.parse(trunk);
    releaseVersionBump(released);
    assert.notEqual(`${JSON.stringify(released, null, 2)}\n`, trunk);
    assert.equal(lockfileDependencyDigest(`${JSON.stringify(released, null, 2)}\n`), lockfileDependencyDigest(trunk));
  });

  it("is blind to reformatting, which by definition changes no dependency", () => {
    assert.equal(
      lockfileDependencyDigest(JSON.stringify(JSON.parse(base))),
      lockfileDependencyDigest(base),
    );
  });

  // Everything below is what the guard exists to catch. Each of these must move
  // the digest even when a release bump is applied on top of it, or the release
  // path would become the smuggling path.
  const undeclared = [
    [
      "an added dependency",
      (l) => {
        l.packages["node_modules/right"] = {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/right/-/right-1.0.0.tgz",
          integrity: `sha512-${"C".repeat(86)}==`,
        };
      },
    ],
    [
      "a removed dependency",
      (l) => {
        delete l.packages["node_modules/left"];
      },
    ],
    [
      "a dependency version change",
      (l) => {
        l.packages["node_modules/left"].version = "2.0.0";
      },
    ],
    [
      "a re-pointed tarball",
      (l) => {
        l.packages["node_modules/left"].resolved = "https://example.invalid/left-1.0.0.tgz";
      },
    ],
    [
      "a changed integrity hash",
      (l) => {
        l.packages["node_modules/left"].integrity = `sha512-${"D".repeat(86)}==`;
      },
    ],
    [
      "a widened declared range",
      (l) => {
        l.packages[""].dependencies.left = "^2.0.0";
      },
    ],
    [
      "a dependency version disguised as the release bump",
      (l) => {
        l.packages["node_modules/left"].version = "9.9.9-beta.0";
      },
    ],
    [
      "a lockfile format downgrade",
      (l) => {
        l.lockfileVersion = 2;
      },
    ],
  ];

  for (const [label, mutate] of undeclared) {
    it(`moves for ${label}, with or without a release bump`, () => {
      const changed = lockfileDependencyDigest(variant(mutate));
      assert.notEqual(changed, lockfileDependencyDigest(base));
      assert.equal(
        lockfileDependencyDigest(
          variant((l) => {
            mutate(l);
            releaseVersionBump(l);
          }),
        ),
        changed,
      );
    });
  }

  it("keeps every installed package's own version in the projection", () => {
    const projected = lockfileDependencyProjection(base);
    assert.ok(projected.includes('"node_modules/left"'));
    assert.ok(projected.includes('"1.0.0"'));
    // The first-party versions are the only thing normalised away.
    assert.ok(!projected.includes("0.1.7-beta.0"));
  });

  it("refuses a lockfile that is not a JSON object", () => {
    assert.throws(() => lockfileDependencyDigest("[]"), /not a JSON object/u);
    assert.throws(() => lockfileDependencyDigest("null"), /not a JSON object/u);
  });
});
