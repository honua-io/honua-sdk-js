import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/docs-site.yml", import.meta.url), "utf8");
const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const disposition = readFileSync(new URL("../../.github/workflows/pr-issue-disposition.yml", import.meta.url), "utf8");
const regeneration = readFileSync(
  new URL("../../.github/workflows/regenerate-derived-artifacts.yml", import.meta.url),
  "utf8",
);
const TITLE = "Docs site deployment failure";

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = end === undefined ? source.length : source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${JSON.stringify(start)}`);
  return source.slice(from, to);
}

function job(id) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  assert.ok(start >= 0, id);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-z0-9-]+:$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const triggers = section(workflow, "\non:\n", "\npermissions:\n");
const build = job("build");
const deploy = job("deploy");
const reporter = job("report-failure");

function runScript(jobText) {
  const runAt = jobText.indexOf("\n        run: |\n");
  assert.ok(runAt >= 0, "reporter run block");
  const lines = jobText.slice(runAt + "\n        run: |\n".length).split("\n");
  const body = [];
  for (const line of lines) {
    if (line === "") {
      body.push("");
      continue;
    }
    if (!line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  assert.ok(body.length > 0);
  return body.join("\n");
}

function assertOrder(source, parts) {
  let cursor = -1;
  for (const part of parts) {
    const at = source.indexOf(part, cursor + 1);
    assert.ok(at > cursor, `missing or reordered: ${part}`);
    cursor = at;
  }
}

const reporterScript = runScript(reporter);

test("docs site runs daily and on manual dispatch, not on push", () => {
  assert.match(triggers, /schedule:\n(?:    #[^\n]*\n)?    - cron: "47 9 \* \* \*"/u);
  assert.match(triggers, /^  workflow_dispatch:\n$/mu);
  assert.equal(triggers.includes("inputs:"), false);
  assert.equal(triggers.includes("\n  push:"), false);
  assert.equal(triggers.includes("pull_request"), false);
  assert.match(
    regeneration,
    /gh workflow run docs-site\.yml --repo "\$GITHUB_REPOSITORY" --ref trunk/u,
  );
});

test("publication gates stay present and strict", () => {
  assert.equal(workflow.includes("HONUA_DERIVED_ARTIFACTS_RELAX"), false);
  assert.equal(ci.split("HONUA_DERIVED_ARTIFACTS_RELAX:").length - 1, 3);
  assert.equal(
    ci.split(
      "HONUA_DERIVED_ARTIFACTS_RELAX: ${{ (github.event_name == 'pull_request' && github.base_ref == 'trunk' || github.event_name == 'push' && github.ref == 'refs/heads/trunk' || github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/release-please--branches--trunk' && inputs.release_head_sha == github.sha) && '1' || '' }}",
    ).length - 1,
    2,
  );
  assertOrder(build, [
    "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "fetch-depth: 0",
    "uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7",
    "run: npm ci",
    "run: npm run verify:llms",
    "run: npm run docs:comparison:check",
    "run: npm run docs:npm-search:check",
    "run: npm run docs:mcp-scorecard:check",
    "run: npm run docs:versions:check",
    "run: node scripts/check-docs-release.mjs registry",
    'HONUA_DOCS_TAG_VERIFY_ATTEMPTS: "12"',
    "run: npm run docs:versions:verify-tags",
    "npm run samples:verify",
    "npm run docs:site:gallery:test",
    "run: npm run docs:api",
    "run: npm run docs:site",
    "run: npm run docs:site:linkcheck",
    "run: npm run docs:site:versions",
    "uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0",
    "uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0",
    "path: dist/docs-site",
  ]);
  assertOrder(deploy, [
    "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7",
    "uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1",
    'HONUA_DOCS_DEPLOY_VERIFY_ATTEMPTS: "12"',
    "HONUA_DOCS_EXPECT_SOURCE_REVISION: ${{ github.sha }}",
    "run: node scripts/check-docs-release.mjs hosted",
  ]);
});

test("required SDK, MCP, and disposition checks stay named", () => {
  assert.equal(ci.includes("\n    name: JS SDK\n"), true);
  assert.equal(ci.includes("\n    name: MCP SDK\n"), true);
  assert.equal(disposition.includes("\n    name: PR Issue Disposition\n"), true);
  assert.equal(ci.split("node --test test/scripts/docs-site-workflow.test.mjs").length - 1, 2);
  const verification = readFileSync(new URL("../../.github/workflows/sdk-verification.yml", import.meta.url), "utf8");
  assert.equal(verification.split("node --test test/scripts/docs-site-workflow.test.mjs").length - 1, 1);
  for (const jobId of ["pr-fast", "js-sdk"]) {
    const lines = ci.split("\n");
    const start = lines.indexOf(`  ${jobId}:`);
    assert.ok(start >= 0, jobId);
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^  [a-z0-9-]+:$/u.test(lines[index])) {
        end = index;
        break;
      }
    }
    const jobText = lines.slice(start, end).join("\n");
    assert.equal(jobText.split("node --test test/scripts/docs-site-workflow.test.mjs").length - 1, 1, jobId);
  }
});

test("only the reporter may write issues, and it does not execute repository code", () => {
  assert.equal(workflow.match(/^      issues: write$/gmu)?.length, 1);
  assert.equal(build.includes("issues:"), false);
  assert.equal(deploy.includes("issues:"), false);
  assert.match(build, /permissions:\n      contents: read\n      pages: write\n      id-token: write\n/u);
  assert.match(deploy, /permissions:\n      contents: read\n      pages: write\n      id-token: write\n/u);
  assert.match(reporter, /permissions:\n      issues: write\n/u);
  assert.equal(reporter.includes("contents:"), false);
  assert.equal(reporter.includes("pages:"), false);
  assert.equal(reporter.includes("id-token:"), false);
  assert.equal(reporter.includes("uses:"), false);
  assert.equal(reporter.includes("actions/checkout"), false);
  assert.equal(reporterScript.includes("${{"), false);
  assert.equal(reporterScript.includes("npm"), false);
  assert.equal(reporterScript.includes("node "), false);
  assert.equal(workflow.match(/actions\/checkout@/gu).length, 2);
  assert.match(reporter, /needs: \[build, deploy\]/u);
  assert.match(
    reporter,
    /if: "\$\{\{ !cancelled\(\) && \(needs\.build\.result == 'failure' \|\| needs\.deploy\.result == 'failure'\) \}\}"/u,
  );
  assert.equal(reporter.includes("always()"), false);
  assert.match(workflow, /^concurrency:\n  group: pages\n  cancel-in-progress: false\n/mu);
  assert.match(
    reporter,
    /concurrency:\n      group: docs-site-failure-report\n      cancel-in-progress: false\n/u,
  );
  assert.equal(reporter.includes("github.run_id"), false);
  assert.equal(reporterScript.includes(TITLE), true);
  assert.equal(reporterScript.includes("search/issues"), false);
  assert.equal(reporterScript.includes("search"), false);
  assert.equal(workflow.includes("search/issues"), false);
});

const REPO = "honua-io/honua-sdk-js";
const FIRST_PAGE = `repos/${REPO}/issues?state=all&per_page=100&page=1`;
const NEXT_URL =
  "https://api.github.com/repositories/1171771524/issues?state=all&per_page=100&page=2&after=Y3Vyc29yOnYyOpLPAAABoaw1SkDPAAAAAXMTsjE%3D";
const SECOND_PAGE =
  "repositories/1171771524/issues?state=all&per_page=100&page=2&after=Y3Vyc29yOnYyOpLPAAABoaw1SkDPAAAAAXMTsjE%3D";

const fakeGh = `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" != "api" ]]; then
  echo "unexpected gh command: $*" >&2
  exit 2
fi
shift
method="GET"
endpoint=""
input=""
fields=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --method|-X) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --raw-field|-f) fields+=("$2"); shift 2 ;;
    --include|-i) shift ;;
    *)
      if [[ "$1" == -* ]]; then
        echo "unexpected gh flag: $1" >&2
        exit 2
      fi
      endpoint="$1"
      shift
      ;;
  esac
done
body=""
if [[ "\${input}" == "-" ]]; then
  body="$(cat)"
fi
field_json="[]"
if [[ \${#fields[@]} -gt 0 ]]; then
  field_json=$(printf '%s\\n' "\${fields[@]}" | jq -R . | jq -s .)
fi
jq -nc --arg method "$method" --arg endpoint "$endpoint" --arg body "$body" --argjson fields "$field_json" \\
  '{method:$method, endpoint:$endpoint, body:$body, fields:$fields}' >> "$GH_FAKE_LOG"
if [[ "$endpoint" == *search* ]]; then
  echo "search endpoint used: $endpoint" >&2
  exit 2
fi
if [[ "$method" == "GET" ]]; then
  page_file="$GH_PAGES_DIR/$endpoint"
  [[ -f "$page_file" ]] || { echo "unscripted issue page: $endpoint" >&2; exit 2; }
  cat "$page_file"
  exit 0
fi
if [[ "$method" == "POST" || "$method" == "PATCH" ]]; then
  printf '%s\\n' '{"number":1}'
  exit 0
fi
echo "unexpected gh api call: $method $endpoint" >&2
exit 2
`;

function issuePage(issues, nextUrl) {
  const link = nextUrl === undefined ? "" : `Link: <${nextUrl}>; rel="next"\n`;
  return `HTTP/2.0 200 OK\n${link}Content-Type: application/json\n\n${JSON.stringify(issues)}\n`;
}

function runReport(env, pages) {
  const dir = mkdtempSync(path.join(tmpdir(), "docs-site-report-"));
  const bin = path.join(dir, "gh");
  const log = path.join(dir, "calls.jsonl");
  const pagesDir = path.join(dir, "pages");
  writeFileSync(bin, fakeGh);
  chmodSync(bin, 0o755);
  writeFileSync(log, "");
  for (const [endpoint, raw] of Object.entries(pages)) {
    const file = path.join(pagesDir, endpoint);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, raw);
  }
  const result = spawnSync("bash", ["-c", reporterScript], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GH_FAKE_LOG: log,
      GH_PAGES_DIR: pagesDir,
      GH_TOKEN: "test-token",
      ...env,
    },
  });
  const raw = readFileSync(log, "utf8").trim();
  const calls = raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line));
  return { status: result.status, stderr: result.stderr, calls };
}

const identity = {
  GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
  GITHUB_RUN_ID: "4242",
  GITHUB_SERVER_URL: "https://github.com",
};

function assertNoSearch(report) {
  assert.equal(
    report.calls.some((call) => call.endpoint.includes("search")),
    false,
  );
}

test("a failed build opens one exact-title issue with both results and the run URL", () => {
  const report = runReport(
    { ...identity, BUILD_RESULT: "failure", DEPLOY_RESULT: "skipped" },
    { [FIRST_PAGE]: issuePage([{ number: 9, title: "Docs site notes", state: "open" }]) },
  );
  assert.equal(report.status, 0, report.stderr);
  assert.equal(report.calls.length, 2);
  assert.equal(report.calls[0].method, "GET");
  assert.equal(report.calls[0].endpoint, FIRST_PAGE);
  assert.deepEqual(report.calls[0].fields, []);
  assert.equal(report.calls[1].method, "POST");
  assert.equal(report.calls[1].endpoint, "repos/honua-io/honua-sdk-js/issues");
  assert.deepEqual(JSON.parse(report.calls[1].body), {
    title: TITLE,
    body: "Build result: failure\nDeploy result: skipped\nRun: https://github.com/honua-io/honua-sdk-js/actions/runs/4242",
  });
  assertNoSearch(report);
});

test("a failed deploy updates the oldest exact-title issue and does not create another", () => {
  const report = runReport(
    { ...identity, BUILD_RESULT: "success", DEPLOY_RESULT: "failure" },
    {
      [FIRST_PAGE]: issuePage([
        { number: 15, title: TITLE, state: "open", pull_request: { url: "https://github.com/example/1" } },
        { number: 40, title: TITLE, state: "closed" },
        { number: 12, title: TITLE, state: "closed" },
      ]),
    },
  );
  assert.equal(report.status, 0, report.stderr);
  assert.equal(report.calls.length, 2);
  assert.equal(report.calls[1].method, "PATCH");
  assert.equal(report.calls[1].endpoint, "repos/honua-io/honua-sdk-js/issues/12");
  assert.deepEqual(JSON.parse(report.calls[1].body), {
    title: TITLE,
    body: "Build result: success\nDeploy result: failure\nRun: https://github.com/honua-io/honua-sdk-js/actions/runs/4242",
    state: "open",
  });
  assertNoSearch(report);
});

test("a match on a later issue page updates that issue and does not use search", () => {
  const report = runReport(
    { ...identity, BUILD_RESULT: "failure", DEPLOY_RESULT: "failure" },
    {
      [FIRST_PAGE]: issuePage([{ number: 90, title: "Docs site notes" }], NEXT_URL),
      [SECOND_PAGE]: issuePage([{ number: 7, title: TITLE, state: "closed" }]),
    },
  );
  assert.equal(report.status, 0, report.stderr);
  assert.deepEqual(
    report.calls.slice(0, 2).map((call) => call.endpoint),
    [FIRST_PAGE, SECOND_PAGE],
  );
  assert.equal(report.calls[2].method, "PATCH");
  assert.equal(report.calls[2].endpoint, "repos/honua-io/honua-sdk-js/issues/7");
  const body = JSON.parse(report.calls[2].body);
  assert.equal(body.state, "open");
  assert.equal(body.body.includes("Build result: failure"), true);
  assert.equal(body.body.includes("Deploy result: failure"), true);
  assertNoSearch(report);
});

test("the oldest exact title on a later page wins over a newer match", () => {
  const report = runReport(
    { ...identity, BUILD_RESULT: "failure", DEPLOY_RESULT: "skipped" },
    {
      [FIRST_PAGE]: issuePage(
        [
          { number: 4, title: TITLE, pull_request: { url: "https://github.com/example/4" } },
          { number: 40, title: TITLE, state: "open" },
        ],
        NEXT_URL,
      ),
      [SECOND_PAGE]: issuePage([
        { number: 12, title: TITLE, state: "closed" },
        { number: 18, title: "other" },
      ]),
    },
  );
  assert.equal(report.status, 0, report.stderr);
  assert.equal(report.calls.length, 3);
  assert.equal(report.calls[2].method, "PATCH");
  assert.equal(report.calls[2].endpoint, "repos/honua-io/honua-sdk-js/issues/12");
  assertNoSearch(report);
});

test("a malformed later page refuses to create a duplicate", () => {
  const report = runReport(
    { ...identity, BUILD_RESULT: "failure", DEPLOY_RESULT: "skipped" },
    {
      [FIRST_PAGE]: issuePage([{ number: 3, title: "other" }], NEXT_URL),
      [SECOND_PAGE]: "HTTP/2.0 200 OK\nContent-Type: application/json\n\n{\"message\":\"unavailable\"}\n",
    },
  );
  assert.notEqual(report.status, 0);
  assert.deepEqual(report.calls.map((call) => call.method), ["GET", "GET"]);
  assert.deepEqual(
    report.calls.map((call) => call.endpoint),
    [FIRST_PAGE, SECOND_PAGE],
  );
  assertNoSearch(report);
});

test("an untrusted next link refuses to create a duplicate", () => {
  const report = runReport(
    { ...identity, BUILD_RESULT: "failure", DEPLOY_RESULT: "skipped" },
    {
      [FIRST_PAGE]: issuePage(
        [{ number: 3, title: "other" }],
        "https://evil.example/repos/honua-io/honua-sdk-js/issues?state=all&per_page=100&page=2",
      ),
    },
  );
  assert.equal(report.status, 1);
  assert.match(report.stderr, /invalid next issue page link/u);
  assert.deepEqual(report.calls.map((call) => call.method), ["GET"]);
  assertNoSearch(report);
});

test("rejected API inputs never reach gh", () => {
  const pages = { [FIRST_PAGE]: issuePage([]) };
  const cases = [
    { BUILD_RESULT: "failed", DEPLOY_RESULT: "skipped" },
    { BUILD_RESULT: "failure", DEPLOY_RESULT: "error" },
    { GITHUB_REPOSITORY: "honua-io/honua-sdk-js?x=1" },
    { GITHUB_REPOSITORY: "../evil" },
    { GITHUB_RUN_ID: "4242;rm" },
    { GITHUB_SERVER_URL: "https://github.com.evil" },
  ];
  for (const override of cases) {
    const report = runReport(
      { ...identity, BUILD_RESULT: "failure", DEPLOY_RESULT: "skipped", ...override },
      pages,
    );
    assert.equal(report.status, 1, `${JSON.stringify(override)}\n${report.stderr}`);
    assert.deepEqual(report.calls, []);
  }
});

test("an issue list response without an issue array fails closed", () => {
  const report = runReport(
    { ...identity, BUILD_RESULT: "failure", DEPLOY_RESULT: "failure" },
    { [FIRST_PAGE]: "HTTP/2.0 200 OK\nContent-Type: application/json\n\n{\"message\":\"unavailable\"}\n" },
  );
  assert.notEqual(report.status, 0);
  assert.deepEqual(report.calls.map((call) => call.method), ["GET"]);
  assert.equal(report.calls[0].endpoint, FIRST_PAGE);
  assertNoSearch(report);
});
