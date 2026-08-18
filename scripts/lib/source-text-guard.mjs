/**
 * Keeps CI-policy sources reviewable as text (honua-io/honua-sdk-js#1286,
 * #1332).
 *
 * Git decides whether a file is text or binary by looking for control bytes in
 * its first 8000. One raw U+0000 anywhere near the top and the file becomes
 * `Bin 0 -> 13868 bytes` in every diff -- to `gh pr diff`, to the web UI, to
 * every human reviewer, and to every reviewing agent. `grep` goes quiet on it
 * too, without `-a`.
 *
 * This has now bitten this repository twice. In #1332 a raw NUL hid the payload
 * of a stranded merge during the investigation of that very stranding. In #1334
 * `scripts/lib/sdk-build-evidence.mjs` used raw U+0000 and U+0001 as digest
 * separators, so the single most security-sensitive file in a +5006-line change
 * -- the one deciding whether a downloaded build may be trusted -- rendered as
 * a binary blob to everyone asked to review it. Escapes emit identical bytes;
 * only the source representation changes, so there is never a cost to the fix.
 *
 * Both times the countermeasure was a guard naming the one file that had just
 * failed. A guard that only knows about the files that have already broken
 * cannot stop the third instance, which is why this one enumerates the sources
 * instead of being handed them.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Directories whose contents are read as policy: they gate CI, decide what may
 * be trusted, and are reviewed by reading the diff. A binary-classified file
 * here is a file nobody reviewed.
 */
export const POLICY_SOURCE_ROOTS = Object.freeze([".github/workflows", "scripts", "test/scripts"]);

export const POLICY_SOURCE_EXTENSIONS = Object.freeze([".mjs", ".cjs", ".js", ".mts", ".d.mts", ".yml", ".yaml"]);

/**
 * Tab, newline, vertical tab, form feed, and carriage return are the whitespace
 * control characters a text file legitimately contains. Every other byte below
 * 0x20 is what makes git call the file binary.
 */
export function isDisallowedControlByte(byte) {
  return byte < 0x09 || (byte > 0x0d && byte < 0x20);
}

/** Byte offsets, so a failure names where to look rather than only that it exists. */
export function findControlByteOffenders(bytes, { limit = 10 } = {}) {
  const offenders = [];
  for (const [offset, byte] of bytes.entries()) {
    if (!isDisallowedControlByte(byte)) continue;
    offenders.push(`0x${byte.toString(16).padStart(2, "0")} at offset ${offset}`);
    if (offenders.length >= limit) break;
  }
  return offenders;
}

/**
 * Every policy source under `projectRoot`, as repository-relative paths.
 *
 * Recursive, and it descends into directories it does not recognise rather than
 * skipping them: a new subdirectory of scripts/ is exactly where the third
 * instance would land. Symlinks are refused rather than followed, so a link out
 * of the tree cannot be used to present one file under two names.
 */
export function collectPolicySources(projectRoot, { roots = POLICY_SOURCE_ROOTS } = {}) {
  const found = [];

  const visit = (relative) => {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relativePath = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        visit(relativePath);
      } else if (entry.isFile() && POLICY_SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(relativePath);
      }
    }
  };

  for (const root of roots) visit(root);
  return found.sort();
}

/** `{ file, offenders }` for every policy source git would classify as binary. */
export function auditPolicySourceText(projectRoot, options = {}) {
  return collectPolicySources(projectRoot, options)
    .map((file) => ({ file, offenders: findControlByteOffenders(fs.readFileSync(path.join(projectRoot, file))) }))
    .filter((result) => result.offenders.length > 0);
}
