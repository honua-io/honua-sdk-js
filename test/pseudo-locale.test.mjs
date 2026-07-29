import assert from "node:assert/strict";
import test from "node:test";

import { expansionRatio, pseudoLocalize } from "./helpers/pseudo-locale.mjs";

test("pseudo locale is deterministic and expands every non-empty message by at least 35%", () => {
  const messages = ["Save", "No features found", "Approximate scale", "Übertragung läuft"];
  for (const message of messages) {
    const first = pseudoLocalize(message);
    assert.equal(first, pseudoLocalize(message));
    assert.notEqual(first, message);
    assert.match(first, /[áëïöüÁËÏÖÜ]/u);
    assert.ok(expansionRatio(message, first) >= 1.35, `${message} did not expand enough`);
  }
});

test("pseudo locale preserves whitespace-only nodes", () => {
  assert.equal(pseudoLocalize("  \n  "), "  \n  ");
});

