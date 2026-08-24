#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_SIZE_EXCEPTION } from "../examples/kepler-analytics/scripts/audit.mjs";
import { planKeplerAuditRenewal, renewKeplerAuditSource } from "./lib/kepler-audit-renewal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_PATH = path.join(ROOT, "examples/kepler-analytics/scripts/audit.mjs");
const apply = process.argv.includes("--apply");
const plan = planKeplerAuditRenewal(IMAGE_SIZE_EXCEPTION, process.env.HONUA_KEPLER_RENEWAL_NOW ?? new Date());

if (!plan.due) {
  console.log(JSON.stringify({ status: "not-due", ...plan }));
  process.exit(0);
}

if (!apply) {
  console.log(JSON.stringify({ status: "due", ...plan }));
  process.exit(plan.alert ? 2 : 0);
}

run("node", [AUDIT_PATH]);
const upstream = JSON.parse(run("npm", ["view", "texture-compressor@latest", "version", "dependencies.image-size", "--json"]));
if (upstream.version !== "1.0.2" || upstream["dependencies.image-size"] !== "^0.7.4") {
  throw new Error(`texture-compressor dependency changed; review an upgrade instead of renewing: ${JSON.stringify(upstream)}`);
}
const latestImageSize = JSON.parse(run("npm", ["view", "image-size", "version", "--json"]));
if (latestImageSize !== "2.0.2") {
  throw new Error(`image-size latest release changed to ${latestImageSize}; review an upgrade instead of renewing`);
}

const source = readFileSync(AUDIT_PATH, "utf8");
writeFileSync(AUDIT_PATH, renewKeplerAuditSource(source, plan));
console.log(JSON.stringify({ status: "renewed", ...plan }));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
