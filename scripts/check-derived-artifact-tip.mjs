#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

import { evaluateDerivedArtifactTip } from "./lib/derived-artifact-loop-guard.mjs";

function git(args, { optional = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (optional) return "";
    throw error;
  }
}

const decision = evaluateDerivedArtifactTip({
  releaseMatrixReceiptRunId: process.env.RELEASE_MATRIX_RECEIPT_RUN_ID ?? "",
  firstParent: git(["rev-parse", "--verify", "HEAD^1"], { optional: true }),
  secondParent: git(["rev-parse", "--verify", "HEAD^2"], { optional: true }),
  readCommit: (revision) => ({
    subject: git(["log", "-1", "--format=%s", revision]),
    parent: git(["rev-parse", "--verify", `${revision}^`], { optional: true }),
  }),
});

console.log(decision.reason);
const output = `skip=${decision.skip}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output, "utf8");
else process.stdout.write(output);
