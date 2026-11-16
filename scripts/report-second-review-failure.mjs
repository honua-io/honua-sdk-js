import { join } from "node:path";
import { readSecondReviewFailure } from "./lib/second-review-failure.mjs";

// The action output contains untrusted review text and may contain credentials.
// Only a fixed category may cross into workflow logs; this is an advisory hint.
const category = process.env.RUNNER_TEMP
  ? readSecondReviewFailure(join(process.env.RUNNER_TEMP, "claude-execution-output.json"))
  : "unavailable";
console.log(`Second-pass review failed; error category hint: ${category}. Raw output withheld.`);
