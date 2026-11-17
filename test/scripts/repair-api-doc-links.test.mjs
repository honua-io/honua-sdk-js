import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditDocsSite } from "../../scripts/check-docs-site-links.mjs";
import {
  dropMissingHierarchySummaries,
  repairApiHref,
  repairPublishedApiDocs,
} from "../../scripts/lib/repair-api-doc-links.mjs";

const context = {
  pageDir: "",
  siteExists: (sitePath) => sitePath === "interfaces/kept.html",
  repoKind: (repoPath) => (repoPath === "LICENSE" || repoPath === "package.json" ? "file" : null),
};

test("API index keeps a link whose target is published", () => {
  const href = "interfaces/kept.html";
  assert.equal(repairApiHref(href, context), href);
});

test("API index sends unpublished LICENSE and package.json links to the repository", () => {
  assert.equal(
    repairApiHref("./LICENSE", context),
    "https://github.com/honua-io/honua-sdk-js/blob/trunk/LICENSE",
  );
  assert.equal(
    repairApiHref("./package.json", context),
    "https://github.com/honua-io/honua-sdk-js/blob/trunk/package.json",
  );
  assert.equal(repairApiHref("media/evals", context), "media/evals");
});

test("API index sends the rewritten MCP evals link to the repository directory", () => {
  const evals = {
    ...context,
    repoKind: (repoPath) => (repoPath === "mcp/evals" ? "dir" : context.repoKind(repoPath)),
  };
  assert.equal(
    repairApiHref("media/evals", evals),
    "https://github.com/honua-io/honua-sdk-js/tree/trunk/mcp/evals",
  );
  assert.equal(repairApiHref("media/coding-agent-evals.md", { ...evals, siteExists: () => true }), "media/coding-agent-evals.md");
});

test("repairing a published API tree rewrites only the missing root files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-docs-"));
  const repo = path.join(root, "repo");
  const api = path.join(root, "api");
  fs.mkdirSync(path.join(api, "interfaces"), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "LICENSE"), "license\n");
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  fs.writeFileSync(path.join(api, "interfaces", "kept.html"), "<p id=\"kept\"></p>\n");
  fs.writeFileSync(
    path.join(api, "index.html"),
    '<a href="./LICENSE"></a><a href="./package.json"></a><a href="interfaces/kept.html"></a>\n',
  );
  assert.equal(repairPublishedApiDocs(api, repo), 1);
  const html = fs.readFileSync(path.join(api, "index.html"), "utf8");
  assert.match(html, /href="https:\/\/github.com\/honua-io\/honua-sdk-js\/blob\/trunk\/LICENSE"/);
  assert.match(html, /href="https:\/\/github.com\/honua-io\/honua-sdk-js\/blob\/trunk\/package.json"/);
  assert.match(html, /href="interfaces\/kept.html"/);
  fs.mkdirSync(path.join(repo, "mcp", "evals"), { recursive: true });
  fs.writeFileSync(path.join(api, "index.html"), '<a href="media/evals">mcp/evals/runs/</a>\n');
  assert.equal(repairPublishedApiDocs(api, repo), 1);
  assert.match(
    fs.readFileSync(path.join(api, "index.html"), "utf8"),
    /href="https:\/\/github.com\/honua-io\/honua-sdk-js\/tree\/trunk\/mcp\/evals"/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a hierarchy summary with no anchor is removed and a real anchor stays", () => {
  const ids = new Set(["runtime.RuntimeSelectionInteractionOptions"]);
  const html = [
    '<h4>Hierarchy (<a href="../hierarchy.html#runtime.RuntimePointerInteractionOptions">View Summary</a>)</h4>',
    '<h4>Hierarchy (<a href="../hierarchy.html#runtime.RuntimeSelectionInteractionOptions">View Summary</a>)</h4>',
  ].join("");
  const next = dropMissingHierarchySummaries(html, ids);
  assert.equal(next.includes("RuntimePointerInteractionOptions"), false);
  assert.match(next, /href="\.\.\/hierarchy.html#runtime.RuntimeSelectionInteractionOptions"/);
});

test("the API link check fails a missing hierarchy anchor and passes after repair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-docs-"));
  const repo = path.join(root, "repo");
  const site = path.join(root, "site");
  const api = path.join(site, "api");
  fs.mkdirSync(path.join(api, "interfaces"), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "LICENSE"), "license\n");
  fs.writeFileSync(
    path.join(api, "hierarchy.html"),
    '<ul class="tsd-full-hierarchy"><li id="runtime.RuntimeSelectionInteractionOptions"></li></ul>\n',
  );
  fs.writeFileSync(
    path.join(api, "interfaces", "runtime.RuntimePointerInteractionOptions.html"),
    '<h4>Hierarchy (<a href="../hierarchy.html#runtime.RuntimePointerInteractionOptions">View Summary</a>)</h4>\n',
  );
  const before = auditDocsSite(site);
  assert.equal(before.broken.length, 1);
  assert.match(before.broken[0].href, /RuntimePointerInteractionOptions/);
  repairPublishedApiDocs(api, repo);
  const after = auditDocsSite(site);
  assert.deepEqual(after.broken, []);
  fs.rmSync(root, { recursive: true, force: true });
});
