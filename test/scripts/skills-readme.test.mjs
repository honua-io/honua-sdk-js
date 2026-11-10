import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSkillsBlock } from "../../scripts/skills-readme.mjs";

test("reports no supporting or terminal skills when none are shipped", () => {
  const rendered = renderSkillsBlock([], { release: "2026.1", stages: [] });
  assert.match(rendered, /### Terminal-journey skills\n\nNone\./);
  assert.match(rendered, /### Supporting skills\n\nNone\./);
  assert.doesNotMatch(rendered, /SKILL\.md/);
});
