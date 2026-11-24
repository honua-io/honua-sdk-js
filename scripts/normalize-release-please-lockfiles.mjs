import process from "node:process";
import { validateTrustedReleasePleaseWorkflowContext } from "./lib/release-please-disposition-check.mjs";
import { normalizeReleasePleaseLockfiles } from "./lib/release-please-lockfiles.mjs";

try {
  const trusted = validateTrustedReleasePleaseWorkflowContext({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    githubSha: process.env.GITHUB_SHA,
    trustedPolicySha: process.env.TRUSTED_POLICY_SHA,
  });
  const results = await normalizeReleasePleaseLockfiles({
    repository: process.env.GITHUB_REPOSITORY,
    trustedPolicySha: trusted.trustedPolicySha,
  });
  console.log(JSON.stringify({ candidates: results }));
} catch (error) {
  console.error(`Release Please lockfile normalization failed: ${error.message}`);
  process.exitCode = 1;
}
