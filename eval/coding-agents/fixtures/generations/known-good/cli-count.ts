import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
const cliPath = process.env.HONUA_EVAL_CLI;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");
if (!cliPath) throw new Error("HONUA_EVAL_CLI is required");

const { stdout } = await execFileAsync(process.execPath, [
  cliPath,
  "query",
  "EvalIncidents/0",
  "--count",
  "--json",
  "--base-url",
  baseUrl,
]);

const parsed = JSON.parse(stdout.trim()) as { count: number };
process.stdout.write(`${JSON.stringify({ count: parsed.count })}\n`);
