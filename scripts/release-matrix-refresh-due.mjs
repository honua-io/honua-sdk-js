#!/usr/bin/env node
// Decides whether regenerate-derived-artifacts.yml should dispatch
// first-map-release-smoke.yml to renew the release-matrix receipt before it
// expires. The receipt is valid for seven days after observation and only the
// smoke renews it, so between releases nothing else would. Built-ins only: the
// calling job has no npm install.
//
// Usage: node scripts/release-matrix-refresh-due.mjs <receipt.json>
// Prints `due=true` or `due=false` (append it to $GITHUB_OUTPUT) and the reason
// on stderr.
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Two days: several six-hour regeneration passes see the receipt as due before
// it lapses, so one failed or skipped smoke does not turn trunk red.
const HOUR_MS = 3_600_000;
const REFRESH_LEAD_HOURS = 48;
export const RELEASE_MATRIX_REFRESH_LEAD_MS = REFRESH_LEAD_HOURS * HOUR_MS;

export function releaseMatrixRefreshDue(receipt, options = {}) {
  const now = Date.parse(options.now ?? new Date().toISOString());
  const leadMs = options.leadMs ?? RELEASE_MATRIX_REFRESH_LEAD_MS;
  const expiresAt = Date.parse(receipt?.expiresAt ?? "");
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
    return { due: false, reason: "no readable release-matrix receipt expiry" };
  }
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) {
    return { due: true, reason: `release-matrix receipt expired at ${receipt.expiresAt}` };
  }
  const hours = (remainingMs / HOUR_MS).toFixed(1);
  if (remainingMs <= leadMs) {
    return { due: true, reason: `release-matrix receipt expires in ${hours} h (${receipt.expiresAt})` };
  }
  return { due: false, reason: `release-matrix receipt is current for ${hours} h` };
}

function readReceipt(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: release-matrix-refresh-due.mjs <receipt.json>");
    process.exit(2);
  }
  const decision = releaseMatrixRefreshDue(readReceipt(file));
  console.error(decision.reason);
  console.log(`due=${decision.due}`);
}
