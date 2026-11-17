import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repairApiHref, repairPublishedApiDocs } from "../../scripts/lib/repair-api-doc-links.mjs";

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
  fs.rmSync(root, { recursive: true, force: true });
});
