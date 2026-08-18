import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditPolicySourceText,
  collectPolicySources,
  findControlByteOffenders,
  isDisallowedControlByte,
  POLICY_SOURCE_EXTENSIONS,
  POLICY_SOURCE_ROOTS,
} from "../../scripts/lib/source-text-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("every CI-policy source stays reviewable as text", () => {
  // The finding this file exists for. It supersedes the two single-path guards
  // that preceded it (scripts/lib/sdk-build-evidence.mjs in #1334,
  // scripts/lib/stranded-merge-detector.mjs in #1332): each named the one file
  // that had already broken, which is the one file that could no longer break.
  it("finds no binary-classified file anywhere under the policy roots", () => {
    const offenders = auditPolicySourceText(root);
    assert.deepEqual(
      offenders.map((result) => `${result.file}: ${result.offenders.join(", ")}`),
      [],
      "a raw control byte makes git classify the file as binary and hides its diff from every reviewer",
    );
  });

  // A guard that scans nothing passes trivially. This asserts the guard has
  // real reach before believing the clean result above.
  it("covers a substantial number of files across every policy root", () => {
    const files = collectPolicySources(root);
    assert.ok(files.length > 100, `expected the guard to scan the policy tree, scanned ${files.length} files`);
    for (const policyRoot of POLICY_SOURCE_ROOTS) {
      assert.ok(
        files.some((file) => file.startsWith(`${policyRoot}/`)),
        `${policyRoot} contributed no files to the scan`,
      );
    }
  });

  it("still covers the two files whose breakage motivated the narrow guards", () => {
    const files = collectPolicySources(root);
    for (const file of ["scripts/lib/sdk-build-evidence.mjs", "scripts/lib/stranded-merge-detector.mjs"]) {
      assert.ok(files.includes(file), `${file} must remain covered by the repository-wide guard`);
    }
  });

  it("reaches sources nested below the top level of a policy root", () => {
    const files = collectPolicySources(root);
    assert.ok(
      files.some((file) => file.split("/").length > 3),
      "a non-recursive scan would miss exactly where a new module lands",
    );
  });
});

describe("the control-byte predicate admits text whitespace and nothing else", () => {
  it("allows tab, newline, vertical tab, form feed, and carriage return", () => {
    for (const byte of [0x09, 0x0a, 0x0b, 0x0c, 0x0d]) {
      assert.equal(isDisallowedControlByte(byte), false, `0x${byte.toString(16)} is legitimate whitespace`);
    }
  });

  it("rejects NUL and the separators that broke the build-evidence diff", () => {
    for (const byte of [0x00, 0x01, 0x08, 0x1f]) {
      assert.equal(isDisallowedControlByte(byte), true, `0x${byte.toString(16)} makes git call the file binary`);
    }
  });

  it("leaves printable and multi-byte UTF-8 alone", () => {
    assert.deepEqual(findControlByteOffenders(Buffer.from("const a = \"ok -- é—😀\";\n")), []);
  });

  it("names the byte and its offset so the fix is locatable", () => {
    const offenders = findControlByteOffenders(Buffer.from("ab\u0000cd"));
    assert.deepEqual(offenders, ["0x00 at offset 2"]);
  });
});

// Belt and braces, in the one direction the guard above cannot cover: it stops a
// control byte being committed, but a diff is binary if EITHER side contains
// one -- so the commit that repairs an already-broken file is itself
// unreviewable without this.
describe("git is told to diff policy sources as text regardless of content", () => {
  it("forces a text diff for every extension the guard scans", () => {
    const attributes = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");
    const forced = new Set(
      attributes
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .filter((line) => line.split(/\s+/u).slice(1).includes("diff"))
        .map((line) => line.split(/\s+/u)[0]),
    );
    for (const extension of POLICY_SOURCE_EXTENSIONS) {
      // .d.mts is covered by the *.mts rule.
      const glob = `*${extension.replace(/^\.d\./u, ".")}`;
      assert.ok(forced.has(glob), `.gitattributes must force a text diff for ${glob}`);
    }
  });
});

describe("the guard actually fails on a file that would be classified binary", () => {
  it("reports a planted control byte rather than passing over it", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "source-text-guard-"));
    try {
      fs.mkdirSync(path.join(scratch, "scripts/lib"), { recursive: true });
      fs.writeFileSync(path.join(scratch, "scripts/lib/clean.mjs"), "export const ok = true;\n");
      // Built from a code point so this fixture does not itself contain the byte
      // it plants -- which would make THIS file the next unreviewable diff.
      const rawControlByte = String.fromCharCode(0x01);
      fs.writeFileSync(
        path.join(scratch, "scripts/lib/dirty.mjs"),
        `export const sep = "${rawControlByte}";\n`,
      );
      // Not a policy extension, so it is out of scope by design.
      fs.writeFileSync(path.join(scratch, "scripts/lib/notes.txt"), String.fromCharCode(0x00));

      const offenders = auditPolicySourceText(scratch, { roots: ["scripts"] });
      assert.deepEqual(
        offenders.map((result) => result.file),
        ["scripts/lib/dirty.mjs"],
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
