import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planKeplerAuditRenewal, renewKeplerAuditSource } from "../../scripts/lib/kepler-audit-renewal.mjs";

const exception = { reviewedOn: "2026-08-23", expiresOn: "2026-09-06" };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("plans renewal before the exception lapses", () => {
  assert.deepEqual(planKeplerAuditRenewal(exception, "2026-09-01T23:00:00Z"), {
    reviewedOn: "2026-09-01",
    expiresOn: "2026-09-15",
    daysRemaining: 5,
    due: true,
    alert: false,
  });
  assert.equal(planKeplerAuditRenewal(exception, "2026-08-31T00:00:00Z").due, false);
  assert.equal(planKeplerAuditRenewal(exception, "2026-09-04T00:00:00Z").alert, true);
});

test("rewrites only the single reviewed exception date pair", () => {
  const source = 'reviewedOn: "2026-08-23",\nexpiresOn: "2026-09-06",\n';
  const plan = planKeplerAuditRenewal(exception, "2026-09-01T00:00:00Z");
  assert.equal(renewKeplerAuditSource(source, plan), 'reviewedOn: "2026-09-01",\nexpiresOn: "2026-09-15",\n');
  assert.throws(() => renewKeplerAuditSource(`${source}${source}`, plan), /date fields drifted/u);
});

test("schedules renewal before expiry with a narrow automation identity", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/kepler-audit-renewal.yml"), "utf8");
  assert.match(workflow, /cron: "17 16 \* \* \*"/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /automation\/kepler-audit-renewal-\$\{today\}/u);
  assert.match(workflow, /node scripts\/renew-kepler-audit-exception\.mjs --apply/u);
  assert.match(workflow, /Confirm JXL, HEIF, and ICNS parsing remains unreachable/u);
});
