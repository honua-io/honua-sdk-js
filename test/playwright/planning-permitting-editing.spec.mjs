/**
 * Real-browser coverage for the fixture-backed `<honua-feature-editor>` wired
 * into the planning and permitting workbench (issue #680, acceptance criteria
 * 2 and 3).
 *
 * The golden `planning-permitting-workbench.spec.mjs` keeps its single
 * gate-attested execution; this file carries the deterministic conflict,
 * attachment-failure, cancellation, and retry flows that were previously proven
 * only in jsdom. It attaches no `honua-gate:` evidence of its own, so the
 * sample's qualification report stays exactly one execution.
 *
 * Every failure is produced by the fixture service, never simulated in the
 * browser: the mock server enforces optimistic concurrency on `applyEdits`,
 * exposes `POST /__fixture__/concurrent-edit` and
 * `POST /__fixture__/arm-update-fault`, and rejects the oversized site plan.
 * Each test owns a freshly seeded, loopback-bound fixture server.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { startPlanningWorkbenchFixtureServer } from "../../examples/planning-permitting-workbench/mock-server.mjs";

const expectedSdkMode = process.env.HONUA_SAMPLE_SDK_MODE ?? "source";

test.setTimeout(90_000);

/**
 * The fixture build is shared across this file's tests: it is the same `dist/`
 * for every one of them, and rebuilding per test would multiply a Vite build by
 * four for no additional proof.
 */
let fixtureBuilt = false;

async function startFixture() {
  const server = await startPlanningWorkbenchFixtureServer({ build: !fixtureBuilt });
  fixtureBuilt = true;
  return server;
}

async function fixtureState(request, baseUrl) {
  const response = await request.get(`${baseUrl}/__fixture__/state`);
  expect(response.ok()).toBe(true);
  return response.json();
}

function storedApplication(state, objectId) {
  return state.features.find((feature) => feature.objectId === objectId);
}

/** Opens the sample, waits for metadata discovery, and shows the editing module. */
async function openEditingModule(page, baseUrl) {
  await page.goto(baseUrl);
  await expect
    .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.ready === true))
    .toBe(true);
  const runtime = await page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__);
  expect(runtime.workflowState).toBe("ready");
  expect(runtime.sdkMode).toBe(expectedSdkMode);
  await page.getByRole("tab", { name: "Permit Editing" }).click();
  await expect(page.locator("#source-editor-state")).toHaveText("3 on file");
}

/** A locator inside the editor's open shadow root. */
function editor(page, selector) {
  return page.locator(`#application-editor ${selector}`);
}

/**
 * Types into a field and commits it. The widget deliberately binds `change`
 * rather than `input`, so a value is recorded when focus leaves the control —
 * exactly as it is for a person tabbing through the form.
 */
async function fillField(page, fieldName, value) {
  const control = editor(page, `[data-field='${fieldName}']`);
  await control.fill(value);
  await control.blur();
}

async function selectApplication(page, objectId) {
  await page.locator(`#application-list button[data-application="${objectId}"]`).click();
  await expect
    .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.selectedApplicationId))
    .toBe(objectId);
}

function watchConsole(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test("planning editor creates and updates a fixture-backed application through the contract apply-edits seam", async ({
  page,
}) => {
  const fixtureServer = await startFixture();
  const consoleErrors = watchConsole(page);
  try {
    await openEditingModule(page, fixtureServer.url);

    // A create draft needs the searched parcel's authoritative context.
    await page.getByRole("button", { name: "Find parcel" }).click();
    await expect(page.locator("#search-status")).toHaveText("parcel selected");

    await page.getByRole("button", { name: "New application for this parcel" }).click();
    await expect(editor(page, "[data-state]")).toContainText("draft");

    // The form is derived from the advertised field metadata, not hand-authored.
    await expect(editor(page, "select[data-field='permit_type']")).toContainText("Residential");
    await expect(editor(page, "input[data-field='proposed_height_ft']")).toHaveAttribute("min", "0");
    await expect(editor(page, "input[data-field='proposed_height_ft']")).toHaveAttribute("max", "60");
    await expect(editor(page, "[data-field='OBJECTID']")).toBeDisabled();
    await expect(editor(page, "[data-geometry-state]")).toContainText("Geometry ready");

    // Metadata domains are enforced before anything is transported.
    await fillField(page, "proposed_height_ft", "120");
    await expect(editor(page, "[data-validation]")).toContainText("need attention");
    await expect(editor(page, "[data-error-for='proposed_height_ft']")).toContainText("60");
    await expect(editor(page, "[data-action='submit']")).toBeDisabled();

    await fillField(page, "proposed_height_ft", "32");
    await fillField(page, "description", "Two-story tenant improvement, counter intake.");
    await editor(page, "select[data-field='status']").selectOption("intake");
    await expect(editor(page, "[data-action='submit']")).toBeEnabled();

    await editor(page, "[data-action='submit']").click();
    await expect(editor(page, "[data-state]")).toContainText("committed");
    await expect(editor(page, "[data-status]")).toContainText("Feature created (id 6001)");

    await expect(page.locator("#source-editor-state")).toHaveText("4 on file");
    await expect(page.locator("#reconciliation-state")).toHaveText("create: committed");
    await expect(page.locator("#reconciliation-list")).toContainText("6001");
    await expect(page.locator("#reconciliation-message")).toContainText("version 1");
    await expect(page.locator("#reconciliation-message")).toHaveAttribute("data-degraded", "false");

    let state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 6001)).toMatchObject({
      status: "intake",
      proposed_height_ft: 32,
      version: 1,
      description: "Two-story tenant improvement, counter intake.",
    });

    // The same widget updates the record it just created.
    await selectApplication(page, 6001);
    await editor(page, "[data-operation='update']").click();
    await expect(editor(page, "[data-state]")).toContainText("draft");
    await editor(page, "select[data-field='status']").selectOption("under-review");
    await fillField(page, "description", "Routed to the plans examiner.");

    // Starting a new application must not discard unsaved work, the same rule
    // the selection path enforces.
    await expect(editor(page, "[data-state]")).toContainText("unsaved");
    await page.getByRole("button", { name: "New application for this parcel" }).click();
    await expect(page.locator("#reconciliation-message")).toContainText(
      "Submit or cancel the open draft before starting a new application",
    );
    await expect(page.locator("#reconciliation-message")).toHaveAttribute("data-degraded", "true");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.editorOperation))
      .toBe("update");
    await expect(editor(page, "select[data-field='status']")).toHaveValue("under-review");
    await expect(editor(page, "input[data-field='description']")).toHaveValue("Routed to the plans examiner.");

    await editor(page, "[data-action='submit']").click();

    await expect(editor(page, "[data-state]")).toContainText("committed");
    await expect(page.locator("#reconciliation-state")).toHaveText("update: committed");
    await expect(page.locator("#reconciliation-message")).toContainText("version 2");
    await expect(page.locator("#reconciliation-message")).toContainText("status under-review");

    state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 6001)).toMatchObject({
      status: "under-review",
      version: 2,
      description: "Routed to the plans examiner.",
    });
    expect(state.featureCount).toBe(4);

    // Reconciliation rebound the editor selection to the re-read record, so
    // Edit again — without touching the list — opens on the fresh token rather
    // than the one the commit consumed.
    await editor(page, "[data-operation='update']").click();
    await expect(editor(page, "input[data-field='version']")).toHaveValue("2");
    await fillField(page, "description", "Examiner comments returned.");
    await editor(page, "[data-action='submit']").click();
    await expect(editor(page, "[data-state]")).toContainText("committed");
    await expect(editor(page, "[data-conflict-panel]")).toHaveCount(0);
    await expect(editor(page, "[data-failures]")).toHaveCount(0);

    state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 6001)).toMatchObject({
      version: 3,
      description: "Examiner comments returned.",
    });

    // The editing module — widget shadow DOM included — stays accessible.
    const accessibility = await new AxeBuilder({ page }).include("#permit-editing-module").analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
  expect(consoleErrors).toEqual([]);
});

test("planning editor parks a concurrent reviewer conflict and fails closed on a stale token", async ({ page }) => {
  const fixtureServer = await startFixture();
  const consoleErrors = watchConsole(page);
  try {
    await openEditingModule(page, fixtureServer.url);

    await selectApplication(page, 5001);
    await editor(page, "[data-operation='update']").click();
    await fillField(page, "description", "Shoreline setback verified on site.");

    // Another reviewer commits while the draft is open.
    await page.getByRole("button", { name: "Simulate concurrent reviewer edit" }).click();
    await expect(page.locator("#rehearsal-status")).toContainText("reconciled as “conflict”");
    await expect(editor(page, "[data-conflict-panel]")).toBeVisible();
    await expect(editor(page, "[data-conflict-reason]")).toContainText("changed on the server");
    await expect(editor(page, "[data-conflict-detail]")).toContainText("version: yours 3, theirs 4");
    await expect(editor(page, "[data-action='submit']")).toBeDisabled();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.editorConflict))
      .toBe(true);

    // Only the other reviewer's write is on file: the parked draft transported
    // nothing.
    let state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 5001)).toMatchObject({
      version: 4,
      status: "approved",
      description: "Concurrent reviewer decision recorded by the permit counter.",
    });

    // An explicit decision to overwrite adopts the observed server token.
    await editor(page, "[data-conflict='keep-mine']").click();
    await expect(editor(page, "[data-conflict-panel]")).toHaveCount(0);
    await expect(editor(page, "[data-status]")).toContainText("overwrite the other edit");
    await editor(page, "[data-action='submit']").click();
    await expect(editor(page, "[data-state]")).toContainText("committed");
    await expect(page.locator("#reconciliation-message")).toContainText("version 5");

    state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 5001)).toMatchObject({
      version: 5,
      description: "Shoreline setback verified on site.",
    });

    // Now prove the service-side precondition: reopen a draft, let another
    // reviewer win again, discard the local edit so the draft keeps its stale
    // token, and submit it anyway.
    await selectApplication(page, 5001);
    await editor(page, "[data-operation='update']").click();
    await fillField(page, "description", "Stale draft that must not win.");
    await page.getByRole("button", { name: "Simulate concurrent reviewer edit" }).click();
    await expect(editor(page, "[data-conflict-panel]")).toBeVisible();
    await editor(page, "[data-conflict='discard-mine']").click();
    await expect(editor(page, "[data-conflict-panel]")).toHaveCount(0);

    await editor(page, "[data-action='submit']").click();
    await expect(editor(page, "[data-state]")).toContainText("conflict");
    await expect(editor(page, "[data-failures] li")).toContainText("version conflict");
    await expect(page.locator("#reconciliation-message")).toContainText("version conflict");
    await expect(page.locator("#reconciliation-message")).toHaveAttribute("data-degraded", "true");

    state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 5001)).toMatchObject({
      version: 6,
      description: "Concurrent reviewer decision recorded by the permit counter.",
    });

    // Reloading closes the draft on server truth instead of guessing.
    await editor(page, "[data-conflict='reload']").click();
    await expect(editor(page, "[data-status]")).toContainText("Reload the feature");
    await expect(editor(page, "[data-state]")).toContainText("idle");
  } finally {
    await fixtureServer.close();
  }
  expect(consoleErrors).toEqual([]);
});

test("planning editor reports an attachment failure without claiming the edit fully applied", async ({ page }) => {
  const fixtureServer = await startFixture();
  const consoleErrors = watchConsole(page);
  try {
    await openEditingModule(page, fixtureServer.url);

    await selectApplication(page, 5002);
    await editor(page, "[data-operation='update']").click();
    await fillField(page, "description", "Site plan attached for hydrology review.");

    await editor(page, "[data-attachment-input]").setInputFiles({
      name: "too-large-site-plan.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7 deterministic oversized site plan"),
    });
    await expect(editor(page, "[data-attachment-index='0']")).toHaveAttribute("data-attachment-status", "staged");
    await expect(editor(page, "[data-attachment-index='0']")).toContainText("too-large-site-plan.pdf");

    await editor(page, "[data-action='submit']").click();

    await expect(editor(page, "[data-attachment-index='0']")).toHaveAttribute("data-attachment-status", "failed");
    await expect(editor(page, "[data-attachment-index='0']")).toContainText("exceeds the fixture upload limit");
    await expect(editor(page, "[data-state]")).toContainText("rejected");
    await expect(editor(page, "[data-status]")).toContainText("only partly applied");
    await expect(editor(page, "[data-failures] li")).toContainText("exceeds the fixture upload limit");

    // Honest partial: the feature edit really did commit, and the sample says so.
    await expect(page.locator("#reconciliation-state")).toHaveText("update: rejected");
    await expect(page.locator("#reconciliation-message")).toContainText("too-large-site-plan.pdf was rejected");
    await expect(page.locator("#reconciliation-message")).toHaveAttribute("data-degraded", "true");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.lastCommitTransported))
      .toBe(true);

    let state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 5002)).toMatchObject({
      version: 4,
      description: "Site plan attached for hydrology review.",
    });
    expect(state.attachmentCount).toBe(0);

    // The record on file moved, so the still-open draft adopts the new token —
    // without that, the enabled Retry would collide with a version the accepted
    // write already consumed.
    await expect(page.locator("#reconciliation-message")).toContainText("now at version 4");
    await expect(editor(page, "input[data-field='version']")).toHaveValue("4");
    await expect(page.locator("#reconciliation-list")).toContainText("4");
    // Adopting server truth must not retract the rejection it follows.
    await expect(editor(page, "[data-state]")).toContainText("rejected");
    await expect(editor(page, "[data-failures] li")).toContainText("exceeds the fixture upload limit");
    await expect(editor(page, "[data-attachment-index='0']")).toHaveAttribute("data-attachment-status", "failed");
    await expect(editor(page, "[data-action='retry']")).toBeEnabled();

    // Retry reaches the service: the feature edit applies again and only the
    // oversized site plan is refused. It is never a version conflict.
    await editor(page, "[data-action='retry']").click();
    await expect(editor(page, "[data-failures] li")).toContainText("exceeds the fixture upload limit");
    await expect(editor(page, "[data-failures]")).not.toContainText("version conflict");
    await expect(editor(page, "[data-conflict-panel]")).toHaveCount(0);
    await expect(editor(page, "input[data-field='version']")).toHaveValue("5");

    state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 5002)).toMatchObject({ version: 5 });
    expect(state.attachmentCount).toBe(0);
  } finally {
    await fixtureServer.close();
  }
  expect(consoleErrors).toEqual([]);
});

test("planning editor cancels a draft without transporting it and retries a rejected submit", async ({ page }) => {
  const fixtureServer = await startFixture();
  const consoleErrors = watchConsole(page);
  try {
    await openEditingModule(page, fixtureServer.url);

    // ── cancellation ───────────────────────────────────────────────────────
    await selectApplication(page, 5003);
    await editor(page, "[data-operation='update']").click();
    await fillField(page, "description", "Draft the reviewer abandons.");
    await fillField(page, "proposed_height_ft", "41");
    await expect(editor(page, "[data-state]")).toContainText("unsaved");

    await editor(page, "[data-action='cancel']").click();
    await expect(editor(page, "[data-state]")).toContainText("cancelled");
    await expect(editor(page, "[data-status]")).toHaveText("Edit cancelled. Nothing was sent to the service.");

    const requests = await (await page.request.get(`${fixtureServer.url}/__fixture__/requests`)).json();
    expect(requests.requests.filter((entry) => entry.pathname.endsWith("/applyEdits"))).toEqual([]);
    let state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 5003)).toMatchObject({
      version: 3,
      proposed_height_ft: 24,
      description: "Seeded planning application for deterministic review.",
    });

    // ── retry after a service rejection ────────────────────────────────────
    await selectApplication(page, 5003);
    await editor(page, "[data-operation='update']").click();
    await fillField(page, "proposed_height_ft", "33");
    await page.getByRole("button", { name: "Arm one-shot service outage" }).click();
    await expect(page.locator("#rehearsal-status")).toContainText("one-shot service outage is armed");

    await editor(page, "[data-action='submit']").click();
    await expect(editor(page, "[data-state]")).toContainText("rejected");
    await expect(editor(page, "[data-failures] li")).toContainText("temporarily unavailable");
    await expect(editor(page, "[data-action='retry']")).toBeEnabled();

    state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 5003)).toMatchObject({ version: 3, proposed_height_ft: 24 });

    await editor(page, "[data-action='retry']").click();
    await expect(editor(page, "[data-state]")).toContainText("committed");
    await expect(page.locator("#reconciliation-message")).toContainText("version 4");

    state = await fixtureState(page.request, fixtureServer.url);
    expect(storedApplication(state, 5003)).toMatchObject({ version: 4, proposed_height_ft: 33 });
    expect(state.armedUpdateFault).toBe(false);
  } finally {
    await fixtureServer.close();
  }
  expect(consoleErrors).toEqual([]);
});
