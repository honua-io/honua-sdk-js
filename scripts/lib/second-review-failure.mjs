import { openSync, readFileSync, closeSync, fstatSync } from "node:fs";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CATEGORIES = [
  ["authentication", /authentication_failed|unauthorized|invalid (?:api key|token)|oauth.{0,30}(?:expired|invalid)|\b401\b/i],
  ["access-or-model", /billing_error|permission_denied|model.{0,40}(?:not found|unavailable|access)|\b403\b/i],
  ["rate-limit", /rate_limit|rate limit|too many requests|\b429\b/i],
  ["network-or-service", /server_error|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|connection error|\b50[0234]\b/i],
];

function errorText(message) {
  if (message?.type === "result" && message.is_error === true) {
    return [message.result, ...(Array.isArray(message.errors) ? message.errors : [])]
      .filter((value) => typeof value === "string").join("\n");
  }
  if (message?.type !== "assistant" || typeof message.error !== "string") return "";
  const content = message.message?.content;
  return [message.error, ...(Array.isArray(content) ? content.map((part) => part?.text) : [])]
    .filter((value) => typeof value === "string").join("\n");
}

export function classifySecondReviewFailure(messages) {
  if (!Array.isArray(messages)) return "unavailable";
  const text = messages.map(errorText).join("\n");
  const matches = CATEGORIES.filter(([, pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0][0] : "unknown";
}

export function readSecondReviewFailure(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_OUTPUT_BYTES) return "unavailable";
    return classifySecondReviewFailure(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch {
    return "unavailable";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
