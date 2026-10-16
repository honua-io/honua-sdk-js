import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { evaluateCompletedFirstPassSummary } from "./lib/second-review-summary.mjs";

const result = evaluateCompletedFirstPassSummary({
  comments: JSON.parse(readFileSync("comments.json", "utf8")).flat(),
  headSha: JSON.parse(readFileSync("pull-request.json", "utf8")).data.repository.pullRequest.headRefOid,
  firstPassReviewer: process.env.FIRST_PASS_REVIEWER,
  resolveCommit: (commitPrefix) =>
    execFileSync("gh", ["api", `repos/${process.env.REPOSITORY}/commits/${commitPrefix}`, "--jq", ".sha"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
});
console.log(JSON.stringify(result));
