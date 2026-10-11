import assert from "node:assert/strict";
import test from "node:test";
import { packedSdkFilename, assertComparisonDependencies } from "../../scripts/lib/installed-consumer-lock.mjs";

test("packed SDK filenames bind bytes even when the package version is unchanged", () => {
  const first = packedSdkFilename(Buffer.from("first SDK 0.1.14"));
  assert.match(first, /^sdk-[a-f0-9]{64}\.tgz$/);
  assert.equal(first, packedSdkFilename(Buffer.from("first SDK 0.1.14")));
  assert.notEqual(first, packedSdkFilename(Buffer.from("next SDK 0.1.14")));
});

test("comparison permits only SDK identity changes", () => {
  const previous = { packages: {
    "": { dependencies: { "@honua/sdk-js": "file:old.tgz" } },
    "node_modules/@honua/sdk-js": { version: "0.1.14", integrity: "old" },
    "node_modules/maplibre-gl": { version: "6.13.0", integrity: "renderer" },
    "node_modules/other": { version: "1.0.0", integrity: "dependency" },
  } };
  const current = structuredClone(previous);
  current.packages["node_modules/@honua/sdk-js"].integrity = "new";
  assertComparisonDependencies(previous, current, "@honua/sdk-js");
  for (const field of ["version", "integrity"]) {
    const changed = structuredClone(current);
    changed.packages["node_modules/other"][field] = "changed";
    assert.throws(() => assertComparisonDependencies(previous, changed, "@honua/sdk-js"), /every dependency/);
  }
  delete current.packages["node_modules/other"];
  assert.throws(() => assertComparisonDependencies(previous, current, "@honua/sdk-js"), /every dependency/);
});

test("npm refreshes same-version packed bytes with a seeded comparison lock", async () => {
  const { mkdtemp, mkdir, readFile, rename, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { runNpmSync } = await import("../../scripts/lib/npm-cli.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "honua-consumer-lock-"));
  const runNpm = (args, cwd) => {
    const result = runNpmSync(args, { cwd, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    const artifacts = path.join(directory, "artifacts");
    await mkdir(artifacts);
    async function pack(name, payload, suffix) {
      const source = path.join(directory, suffix);
      await mkdir(source);
      await writeFile(path.join(source, "package.json"), JSON.stringify({ name, version: "1.0.0", files: ["payload.txt"] }));
      await writeFile(path.join(source, "payload.txt"), payload);
      const [packed] = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], source));
      const original = path.join(artifacts, packed.filename);
      const addressed = path.join(artifacts, packedSdkFilename(await readFile(original)));
      await rename(original, addressed);
      return { spec: pathToFileURL(addressed).href, integrity: packed.integrity };
    }
    const companion = await pack("honua-lock-companion-fixture", "unchanged", "companion");
    const first = await pack("honua-lock-sdk-fixture", "before", "before");
    const next = await pack("honua-lock-sdk-fixture", "after", "after");
    const consumer = path.join(directory, "consumer");
    await mkdir(consumer);
    async function install(sdk) {
      await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, dependencies: {
        "honua-lock-sdk-fixture": sdk.spec, "honua-lock-companion-fixture": companion.spec,
      } }));
      runNpm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
      runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
      return JSON.parse(await readFile(path.join(consumer, "package-lock.json"), "utf8"));
    }
    const previous = await install(first);
    const current = await install(next);
    assert.notEqual(first.integrity, next.integrity);
    assert.equal(current.packages["node_modules/honua-lock-sdk-fixture"].integrity, next.integrity);
    assert.equal(await readFile(path.join(consumer, "node_modules/honua-lock-sdk-fixture/payload.txt"), "utf8"), "after");
    assertComparisonDependencies(previous, current, "honua-lock-sdk-fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
