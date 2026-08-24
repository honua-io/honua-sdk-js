const DAY_MS = 24 * 60 * 60 * 1000;

export const KEPLER_AUDIT_RENEWAL_POLICY = Object.freeze({ renewWithinDays: 5, lifetimeDays: 14 });

function utcDay(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function planKeplerAuditRenewal(exception, now = new Date(), policy = KEPLER_AUDIT_RENEWAL_POLICY) {
  const today = utcDay(now, "now");
  const expires = utcDay(`${exception.expiresOn}T00:00:00Z`, "expiresOn");
  const daysRemaining = (expires - today) / DAY_MS;
  return {
    reviewedOn: new Date(today).toISOString().slice(0, 10),
    expiresOn: new Date(today + policy.lifetimeDays * DAY_MS).toISOString().slice(0, 10),
    daysRemaining,
    due: daysRemaining <= policy.renewWithinDays,
    alert: daysRemaining <= 2,
  };
}

export function renewKeplerAuditSource(source, plan) {
  if (!plan.due) throw new Error(`Kepler audit exception is not due (${plan.daysRemaining} days remain)`);
  const reviewedPattern = /reviewedOn: "\d{4}-\d{2}-\d{2}"/gu;
  const expiresPattern = /expiresOn: "\d{4}-\d{2}-\d{2}"/gu;
  if ((source.match(reviewedPattern) ?? []).length !== 1 || (source.match(expiresPattern) ?? []).length !== 1) {
    throw new Error("Kepler audit exception date fields drifted; refusing a broad rewrite");
  }
  return source
    .replace(reviewedPattern, `reviewedOn: "${plan.reviewedOn}"`)
    .replace(expiresPattern, `expiresOn: "${plan.expiresOn}"`);
}
