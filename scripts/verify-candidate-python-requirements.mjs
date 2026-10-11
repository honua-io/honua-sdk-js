import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
export const candidatePythonLock = path.join(root, "config/installed-candidate-python-requirements.txt");

export function pythonRequirements(text, requireHashes = false) {
  const entries = new Map();
  for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const content = line.replace(/#.*/, "").trim();
    if (!content) continue;
    const [requirement, ...options] = content.split(/\s+/);
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.+!-]*)$/.exec(requirement);
    assert.ok(match, "candidate Python requirements must use exact package==version pins");
    const name = match[1].toLowerCase().replace(/[-_.]+/g, "-");
    assert.ok(!entries.has(name), `duplicate candidate Python dependency: ${name}`);
    assert.ok(options.every((option) => /^--hash=sha256:[a-f0-9]{64}$/.test(option)),
      `unsupported candidate Python requirement option: ${name}`);
    assert.ok(!requireHashes || options.length > 0, `candidate Python dependency needs a SHA-256 hash: ${name}`);
    entries.set(name, match[2]);
  }
  assert.ok(entries.size > 0, "candidate Python dependency denominator must not be empty");
  return [...entries].sort(([left], [right]) => left.localeCompare(right));
}

export function verifyCandidatePythonRequirements(canonical, locked) {
  assert.deepEqual(pythonRequirements(locked, true), pythonRequirements(canonical),
    "hash-locked Python dependencies differ from the reviewed release requirements");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(process.argv[2], "provide the reviewed release requirements-nightly.txt path");
  verifyCandidatePythonRequirements(await readFile(process.argv[2], "utf8"), await readFile(candidatePythonLock, "utf8"));
  console.log("Hash-locked Python dependency denominator matches the reviewed release requirements.");
}
