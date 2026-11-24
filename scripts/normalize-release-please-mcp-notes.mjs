import process from "node:process";
import { validateTrustedReleasePleaseWorkflowContext } from "./lib/release-please-disposition-check.mjs";
import { normalizeMcpComponentReleaseNotes } from "./lib/release-please-workspace-notes.mjs";

try {
  const trusted = validateTrustedReleasePleaseWorkflowContext({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    githubSha: process.env.GITHUB_SHA,
    trustedPolicySha: process.env.TRUSTED_POLICY_SHA,
  });
  const result = await normalizeMcpComponentReleaseNotes({
    repository: process.env.GITHUB_REPOSITORY,
    trustedPolicySha: trusted.trustedPolicySha,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Release Please MCP note normalization failed: ${error.message}`);
  process.exitCode = 1;
}
