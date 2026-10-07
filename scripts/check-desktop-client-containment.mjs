#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ALLOWED_LINE_HASHES, inspectDesktopClientContainment } from "./lib/desktop-client-containment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trackedPaths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const files = trackedPaths.map((file) => ({ path: file, content: fs.readFileSync(path.join(root, file), "utf8") }));
const result = inspectDesktopClientContainment(files);

if (result.unexpected.length > 0 || result.missing.length > 0) {
  for (const finding of result.unexpected) {
    console.error(`${finding.path}:${finding.line}: desktop-client detail is not in the R30 nominative allowlist`);
  }
  for (const finding of result.missing) {
    console.error(`${finding.path}: expected R30 nominative reference is missing or changed (${finding.hash})`);
  }
  process.exitCode = 1;
} else {
  const nominativeCount = [...ALLOWED_LINE_HASHES.values()].reduce((count, hashes) => count + hashes.size, 0);
  console.log(`Desktop-client containment verified: ${nominativeCount} nominative references, no testing detail.`);
}
