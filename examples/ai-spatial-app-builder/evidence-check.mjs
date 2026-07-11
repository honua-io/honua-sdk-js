import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";
import { startAiSpatialAppBuilderFixtureServer } from "./mock-server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const fixture = validateEvidenceEnvelope(await readJson("evidence/fixture.v1.json"));
const live = validateEvidenceEnvelope(await readJson("evidence/live-skipped.v1.json"));
const presentation = await readJson("presentation.v1.json");

const server = await startAiSpatialAppBuilderFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(server.url);
  const effectsBeforeValidation = Number(await page.locator("#effect-count").textContent());
  await page.getByRole("button", { name: "Validate against policy" }).click();
  const effectsBeforeApproval = Number(await page.locator("#effect-count").textContent());
  await page.getByRole("button", { name: "Approve 5-row read" }).click();
  await page.waitForFunction(() => window.__HONUA_SAFE_AGENT__?.state === "approved");
  const effectsAfterApproval = Number(await page.locator("#effect-count").textContent());
  await page.getByRole("button", { name: "Execute approved read" }).click();
  await page.waitForFunction(() => window.__HONUA_SAFE_AGENT__?.state === "executed");
  const receipt = JSON.parse((await page.locator("#receipt-json").textContent()) ?? "null");
  const observed = {
    effectsBeforeValidation,
    effectsBeforeApproval,
    effectsAfterApproval,
    effectsAfterExecution: Number(await page.locator("#effect-count").textContent()),
    rowCount: Number(await page.locator("#row-count").textContent()),
    receiptVerified: (await page.locator("#receipt-integrity").textContent()) === "true",
    receipt,
  };
  if (errors.length > 0) throw new Error(`Fixture browser errors: ${errors.join(" | ")}`);
  if (
    observed.effectsBeforeValidation !== 0 ||
    observed.effectsBeforeApproval !== 0 ||
    observed.effectsAfterApproval !== 0 ||
    observed.effectsAfterExecution !== 1
  )
    throw new Error("Executable fixture evidence did not preserve the zero-effects-before-approval invariant.");
  if (
    !observed.receiptVerified ||
    observed.rowCount !== fixture.semantics.itemCount ||
    observed.receipt.kind !== "honua.agent-execution-receipt" ||
    observed.receipt.outcome !== "succeeded" ||
    observed.receipt.rows !== observed.rowCount ||
    typeof observed.receipt.signature !== "string" ||
    typeof observed.receipt.consumption?.token !== "string"
  )
    throw new Error("Executable fixture did not produce a signed, consumed, verified receipt matching evidence.");
} finally {
  await browser.close();
  await server.close();
}

if (
  !fixture.semantics.assertions.includes("zero-effects-before-approval") ||
  !fixture.semantics.assertions.includes("exactly-one-approved-source-read")
)
  throw new Error("Fixture evidence must claim zero pre-approval effects and one approved effect.");
if (live.status !== "skipped" || !live.reason.includes("no fixture data was substituted"))
  throw new Error("Unavailable live/model evidence must be an honest structured skip.");
if (presentation.format !== "honua.sdk.sample-presentation.v1" || presentation.sampleId !== fixture.sampleId)
  throw new Error("Presentation manifest does not match the sample evidence.");
for (const relative of presentation.evidence) await readFile(path.join(root, relative));
process.stdout.write("Safe-agent executable fixture, signed receipt, live skip, and presentation evidence verified.\n");
