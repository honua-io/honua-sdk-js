import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { evidenceIdentity } from "./evidence-identity.mjs";

if (process.env.HONUA_NL_LIVE_EVIDENCE !== "true")
  throw new Error("Opt in explicitly with HONUA_NL_LIVE_EVIDENCE=true.");
const {
  HONUA_NL_APP_ORIGIN: origin,
  HONUA_NL_SESSION_TOKEN: token,
  HONUA_NL_MODEL_ID: model,
  HONUA_NL_MODEL_ENDPOINT: endpoint,
  HONUA_NL_EVIDENCE_PATH: output,
} = process.env;
if (!origin || !token || !model || !endpoint || !output)
  throw new Error("Configure the authenticated app origin, session token, model identity and evidence output path.");
const source = evidenceIdentity();
if (source.sourceDirty) throw new Error("Live evidence requires a clean committed source tree.");
const identity = { provider: new URL(endpoint).origin, model, ...source };
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "honua_nl_session",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
      secure: new URL(origin).protocol === "https:",
    },
  ]);
  const page = await context.newPage();
  await page.goto(origin);
  const served = await page.evaluate(async () => (await fetch("/ask-map-source.json", { cache: "no-store" })).json());
  if (
    served.sourceDirty ||
    served.sourceCommit !== source.sourceCommit ||
    served.harnessSha256 !== source.harnessSha256
  )
    throw new Error("Served source/harness identity does not match the reviewed clean candidate.");
  await page.locator("#startup").filter({ hasText: "Ready." }).waitFor({ timeout: 45000 });
  const report = await page.evaluate(async (liveIdentity) => {
    const { evaluateRecordedQueriesInBrowser } = await import("/src/evaluation.ts");
    return evaluateRecordedQueriesInBrowser(liveIdentity);
  }, identity);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `Live evaluation: ${report.results.filter((entry) => entry.passed).length}/${report.results.length}; receipt written.\n`,
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser.close();
}
