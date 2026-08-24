import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { IMAGE_SIZE_EXCEPTION, validateKeplerAudit } from "../scripts/audit.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_REPORT = JSON.parse(
  fs.readFileSync(path.join(TEST_DIRECTORY, "fixtures", "audit-report.allowed.json"), "utf8"),
);
const KEPLER_LOCKFILE = JSON.parse(fs.readFileSync(path.join(TEST_DIRECTORY, "..", "package-lock.json"), "utf8"));

// Derived from the declared window rather than pinned to literals. The dates
// used to be hard-coded in three places, so every renewal of a deliberately
// short-lived exception broke this suite as well as the audit -- which trains
// the reviewer to treat a red audit as a chore rather than as the fresh
// dependency review the short lifetime exists to force.
function offsetDays(isoDate, days) {
  const at = new Date(`${isoDate}T12:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at;
}

/** Comfortably inside the declared window. */
const ACTIVE_DATE = offsetDays(IMAGE_SIZE_EXCEPTION.reviewedOn, 1);
/** The first day the exception must no longer be honoured. */
const LAPSED_DATE = offsetDays(IMAGE_SIZE_EXCEPTION.expiresOn, 1);

function clone(value) {
  return structuredClone(value);
}

test("accepts only the reviewed Kepler image-size advisories before expiry", () => {
  assert.deepEqual(validateKeplerAudit(clone(ALLOWED_REPORT), clone(KEPLER_LOCKFILE), ACTIVE_DATE), {
    status: "accepted-temporary-exception",
    advisories: ["GHSA-5p2g-fcmc-qvqq", "GHSA-w3rx-r6r6-pgpr"],
    expiresOn: IMAGE_SIZE_EXCEPTION.expiresOn,
  });

  // Asserting expiresOn against the constant that produced it would be a
  // tautology on its own, so pin its shape and its relationship to the review
  // date here: a malformed or backdated window must not reach the audit.
  assert.match(IMAGE_SIZE_EXCEPTION.expiresOn, /^\d{4}-\d{2}-\d{2}$/u);
  assert.match(IMAGE_SIZE_EXCEPTION.reviewedOn, /^\d{4}-\d{2}-\d{2}$/u);
  assert.ok(
    Date.parse(IMAGE_SIZE_EXCEPTION.expiresOn) > Date.parse(IMAGE_SIZE_EXCEPTION.reviewedOn),
    "the exception must expire after it was reviewed",
  );
});

test("rejects an unexpected vulnerability instead of weakening npm audit", () => {
  const report = clone(ALLOWED_REPORT);
  report.vulnerabilities["unexpected-package"] = {
    name: "unexpected-package",
    severity: "high",
    isDirect: false,
    via: [],
    effects: [],
    range: "*",
    nodes: ["node_modules/unexpected-package"],
    fixAvailable: false,
  };
  report.metadata.vulnerabilities.high += 1;
  report.metadata.vulnerabilities.total += 1;
  assert.throws(
    () => validateKeplerAudit(report, clone(KEPLER_LOCKFILE), ACTIVE_DATE),
    /vulnerability package names drifted/,
  );
});

test("rejects the reviewed findings after the explicit expiry date", () => {
  assert.throws(
    () => validateKeplerAudit(clone(ALLOWED_REPORT), clone(KEPLER_LOCKFILE), LAPSED_DATE),
    new RegExp(`exception expired after ${IMAGE_SIZE_EXCEPTION.expiresOn}`, "u"),
  );
  // The boundary itself: the expiry date is inclusive, so the exception must
  // still be honoured on it and refused the day after.
  assert.doesNotThrow(() =>
    validateKeplerAudit(
      clone(ALLOWED_REPORT),
      clone(KEPLER_LOCKFILE),
      new Date(`${IMAGE_SIZE_EXCEPTION.expiresOn}T23:59:59.000Z`),
    ),
  );
});

test("rejects advisory identity drift", () => {
  const report = clone(ALLOWED_REPORT);
  report.vulnerabilities["image-size"].via[0].url = "https://github.com/advisories/GHSA-unexpected";
  assert.throws(
    () => validateKeplerAudit(report, clone(KEPLER_LOCKFILE), ACTIVE_DATE),
    /unexpected image-size advisory GHSA-unexpected/,
  );
});

test("rejects package version or path drift in the reviewed chain", () => {
  const lockfile = clone(KEPLER_LOCKFILE);
  lockfile.packages["node_modules/image-size"].version = "0.7.6";
  assert.throws(
    () => validateKeplerAudit(clone(ALLOWED_REPORT), lockfile, ACTIVE_DATE),
    /image-size lock version\/path drifted/,
  );
});

test("keeps the exception lifetime short and explicit", () => {
  const reviewedAt = Date.parse(`${IMAGE_SIZE_EXCEPTION.reviewedOn}T00:00:00.000Z`);
  const expiresAt = Date.parse(`${IMAGE_SIZE_EXCEPTION.expiresOn}T00:00:00.000Z`);
  assert.equal((expiresAt - reviewedAt) / (24 * 60 * 60 * 1000), 14);
});
