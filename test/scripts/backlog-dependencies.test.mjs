import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BacklogDependencyError,
  parseBacklogDependencies,
  planBacklogReconciliation,
} from "../../scripts/lib/backlog-dependencies.mjs";
import {
  GitHubBacklogMetadataError,
  githubBacklogRequest,
  loadGitHubBacklogSnapshot,
} from "../../scripts/lib/github-backlog-dependencies.mjs";

const repository = "honua-io/honua-sdk-js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(root, "test/fixtures/backlog-dependencies");
const cli = path.join(root, "scripts/reconcile-backlog-dependencies.mjs");
const parserCases = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "parser-cases.json"), "utf8"));
const stableSnapshot = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "stable-snapshot.json"), "utf8"));

function body(section, type = "Feature") {
  const prefix = `## Specifica\n\nType: ${type}\n\n## Context\n\nFixture.`;
  return section === null ? prefix : `${prefix}\n\n## Backlog Dependencies\n\n${section}`;
}

function automatic(dependencies = []) {
  const declaration =
    dependencies.length === 0
      ? "Dependencies: none"
      : `Dependencies:\n${dependencies.map((ref) => `- ${ref}`).join("\n")}`;
  return body(`Mode: automatic\n${declaration}`);
}

function issue(number, overrides = {}) {
  return {
    repository,
    number,
    state: "open",
    body: automatic(),
    labels: ["blocked"],
    target: true,
    ...overrides,
  };
}

function expectDependencyError(code, action) {
  assert.throws(action, (error) => error instanceof BacklogDependencyError && error.code === code);
}

function expectMetadataError(code, action) {
  return assert.rejects(action, (error) => error instanceof GitHubBacklogMetadataError && error.code === code);
}

function assertNoTaint(value, taints) {
  for (const taint of taints) assert.equal(value.includes(taint), false, `Output contained taint: ${taint}`);
}

function restIssue(number, overrides = {}) {
  const issueRepository = overrides.repository ?? repository;
  return {
    number,
    state: "open",
    body: automatic(),
    labels: [{ name: "blocked" }],
    updated_at: "2026-07-15T03:00:00Z",
    repository_url: `https://api.github.com/repos/${issueRepository}`,
    ...overrides,
    repository: undefined,
  };
}

describe("backlog dependency grammar", () => {
  it("accepts exact same-repository, cross-repository, empty, and manual fixtures", () => {
    for (const fixture of parserCases.valid) {
      const result = parseBacklogDependencies(body(fixture.section), {
        repository: parserCases.repository,
        issueNumber: fixture.issueNumber,
      });
      assert.equal(result.mode, fixture.mode, fixture.name);
      assert.deepEqual(
        result.dependencies.map(({ key }) => key),
        fixture.dependencies,
        fixture.name,
      );
    }
  });

  it("rejects adversarial malformed, duplicate, self-cycle, and epic fixtures", () => {
    for (const fixture of parserCases.invalid) {
      expectDependencyError(fixture.code, () =>
        parseBacklogDependencies(body(fixture.section, fixture.type ?? "Feature"), {
          repository: parserCases.repository,
          issueNumber: fixture.issueNumber,
        }),
      );
    }
  });

  it("uses valid Markdown fence semantics and ignores headings in HTML comments", () => {
    const fenced =
      "   ````md\n## Backlog Dependencies\n\nMode: automatic\nDependencies:\n- #999\n" +
      "```\n~~~\n````suffix\n`````\n\n";
    const comments =
      "<!--\n## Backlog Dependencies\n\nMode: automatic\nDependencies:\n- #998\n-->\n" +
      "<!-- ## Backlog Dependencies -->\n\n";
    const parsed = parseBacklogDependencies(
      `## Specifica\n\nType: Feature\n\n${fenced}${comments}## Backlog Dependencies\n\nMode: automatic\nDependencies:\n- #1`,
      {
        repository,
        issueNumber: 2,
      },
    );
    assert.deepEqual(
      parsed.dependencies.map(({ key }) => key),
      [`${repository}#1`],
    );

    const fourSpaceFence =
      "## Specifica\n\nType: Feature\n\n    ```md\n" +
      "## Backlog Dependencies\n\nMode: automatic\nDependencies: none\n\n## End";
    assert.deepEqual(parseBacklogDependencies(fourSpaceFence, { repository, issueNumber: 2 }).dependencies, []);

    const invalidBacktickInfo =
      "## Specifica\n\nType: Feature\n\n```bad`info\n" +
      "## Backlog Dependencies\n\nMode: automatic\nDependencies: none\n\n## End";
    assert.deepEqual(parseBacklogDependencies(invalidBacktickInfo, { repository, issueNumber: 2 }).dependencies, []);

    expectDependencyError("missing-dependency-section", () =>
      parseBacklogDependencies(
        "## Specifica\n\nType: Feature\n\n<!-- unclosed\n" +
          "## Backlog Dependencies\n\nMode: automatic\nDependencies: none",
        { repository, issueNumber: 2 },
      ),
    );
  });

  it("enforces bounded bodies and dependency counts", () => {
    const parsed = parseBacklogDependencies(automatic(["#1"]), {
      repository,
      issueNumber: 2,
    });
    assert.deepEqual(
      parsed.dependencies.map(({ key }) => key),
      [`${repository}#1`],
    );

    expectDependencyError("too-many-dependencies", () =>
      parseBacklogDependencies(body("Mode: automatic\nDependencies:\n- #1\n- #2"), {
        repository,
        issueNumber: 3,
        maxDependencies: 1,
      }),
    );
    expectDependencyError("body-bound-exceeded", () =>
      parseBacklogDependencies(
        `${"x".repeat(100_001)}\n\n## Backlog Dependencies\n\nMode: automatic\nDependencies: none`,
        {
          repository,
          issueNumber: 3,
        },
      ),
    );
  });
});

describe("pure backlog reconciliation planner", () => {
  it("produces deterministic transitions from the stabilized fixture", () => {
    const first = planBacklogReconciliation(stableSnapshot);
    const second = planBacklogReconciliation(stableSnapshot);
    assert.deepEqual(first, second);
    assert.equal(first.mutationsPerformed, false);
    assert.deepEqual(first.counts, {
      "blocked-to-ready": 2,
      "ready-to-blocked": 1,
      "unchanged-blocked": 1,
      "unchanged-ready": 1,
      manual: 1,
      missing: 1,
      malformed: 0,
      inaccessible: 0,
      cycle: 0,
      drift: 0,
    });
    assert.deepEqual(
      first.dispositions.map(({ number, kind }) => [number, kind]),
      [
        [10, "blocked-to-ready"],
        [11, "unchanged-blocked"],
        [12, "manual"],
        [13, "missing"],
        [14, "unchanged-ready"],
        [15, "ready-to-blocked"],
        [16, "blocked-to-ready"],
      ],
    );
    assert.deepEqual(first.dispositions[0].proposedLabels, {
      remove: ["blocked"],
      add: ["ready-to-start"],
    });
    assert.equal(first.dispositions.find(({ kind }) => kind === "manual")?.proposedLabels, null);
    assert.equal(first.dispositions.find(({ kind }) => kind === "missing")?.proposedLabels, null);
  });

  it("plans blocked-to-ready when adversarial dependency sections are hidden Markdown", () => {
    const hiddenSections =
      "## Specifica\n\nType: Feature\n\n" +
      "<!--\n## Backlog Dependencies\n\nMode: automatic\nDependencies:\n- #998\n-->\n\n" +
      "~~~md\n## Backlog Dependencies\n\nMode: automatic\nDependencies:\n- #999\n~~~~\n\n" +
      "## Backlog Dependencies\n\nMode: automatic\nDependencies: none";
    const plan = planBacklogReconciliation({
      repository,
      issues: [issue(20, { body: hiddenSections })],
    });
    assert.equal(plan.dispositions[0].kind, "blocked-to-ready");
    assert.deepEqual(plan.dispositions[0].proposedLabels, {
      remove: ["blocked"],
      add: ["ready-to-start"],
    });
  });

  it("detects dependency cycles, self-cycles, and duplicate declarations", () => {
    const snapshot = {
      repository,
      issues: [
        issue(30, { body: automatic(["#31"]), labels: ["ready-to-start"] }),
        issue(31, { body: automatic(["#32"]), target: false }),
        issue(32, { body: automatic(["#31"]), target: false }),
        issue(33, { body: automatic(["#33"]), labels: ["ready-to-start"] }),
        issue(34, {
          body: body("Mode: automatic\nDependencies:\n- #35\n- honua-io/honua-sdk-js#35"),
        }),
        issue(35, { target: false }),
      ],
    };
    const plan = planBacklogReconciliation(snapshot);
    assert.deepEqual(
      plan.dispositions.map(({ number, kind }) => [number, kind]),
      [
        [30, "cycle"],
        [33, "cycle"],
        [34, "malformed"],
      ],
    );
    assert.equal(plan.dispositions[0].reason, "A dependency cycle was detected.");
    assert.deepEqual(plan.dispositions[0].proposedLabels, {
      remove: ["ready-to-start"],
      add: ["blocked"],
    });
    assert.deepEqual(plan.dispositions[1].proposedLabels, {
      remove: ["ready-to-start"],
      add: ["blocked"],
    });
    assert.equal(plan.dispositions[2].proposedLabels, null);
    assert.match(plan.dispositions[2].reason, /duplicate-dependency/u);
  });

  it("fails closed for inaccessible, drifting, pull-request, and ambiguous readiness metadata", () => {
    const siteRepository = "honua-io/honua-site";
    const snapshot = {
      repository,
      issues: [
        issue(40, { body: automatic([`${siteRepository}#120`]), labels: ["ready-to-start"] }),
        issue(41, { body: automatic(["#42"]), labels: ["ready-to-start"] }),
        issue(42, { target: false, stable: false, driftReason: "fixture dependency drift" }),
        issue(43, { stable: false, driftReason: "fixture target drift", labels: ["ready-to-start"] }),
        issue(44, { body: automatic(["#45"]), labels: ["ready-to-start"] }),
        issue(45, { target: false, isPullRequest: true }),
        issue(46, { labels: ["blocked", "ready-to-start"] }),
        issue(47, { labels: [] }),
      ],
      unavailable: [{ repository: siteRepository, number: 120, reason: "fixture inaccessible" }],
    };
    const plan = planBacklogReconciliation(snapshot);
    assert.deepEqual(
      plan.dispositions.map(({ number, kind }) => [number, kind]),
      [
        [40, "inaccessible"],
        [41, "drift"],
        [43, "drift"],
        [44, "malformed"],
        [46, "malformed"],
        [47, "malformed"],
      ],
    );
    assert.deepEqual(plan.dispositions[0].proposedLabels, {
      remove: ["ready-to-start"],
      add: ["blocked"],
    });
    assert.equal(plan.dispositions[1].proposedLabels, null);
    assert.equal(plan.dispositions[2].proposedLabels, null);
    assert.deepEqual(plan.dispositions[3].proposedLabels, {
      remove: ["ready-to-start"],
      add: ["blocked"],
    });
    assert.equal(plan.dispositions[4].proposedLabels, null);
    assert.equal(plan.dispositions[5].proposedLabels, null);
  });

  it("uses issue state only and ignores merged partial-PR metadata", () => {
    const dependency = issue(50, {
      target: false,
      labels: ["ready-to-start"],
      mergedPullRequestReferences: [{ number: 900, disposition: "Refs #50 (S1; S2 remains)" }],
    });
    const plan = planBacklogReconciliation({
      repository,
      issues: [dependency, issue(51, { body: automatic(["#50"]) })],
    });
    assert.equal(plan.dispositions[0].kind, "unchanged-blocked");
    assert.equal(plan.dispositions[0].reason, "At least one exact dependency remains open.");
    assert.deepEqual(plan.dispositions[0].dependencies, [{ reference: "#50", state: "open" }]);
  });
});

describe("bounded GitHub metadata reader", () => {
  it("loads exact dependencies and double-reads every accessible issue", async () => {
    const enterpriseRepositoryUrl = `https://github.example/api/v3/repos/${repository}`;
    const target = restIssue(60, { body: automatic(["#1"]), repository_url: enterpriseRepositoryUrl });
    const dependency = restIssue(1, {
      state: "closed",
      body: "",
      labels: [],
      repository_url: enterpriseRepositoryUrl,
    });
    const requests = [];
    const request = async (url) => {
      requests.push(url);
      if (url.includes("/issues?")) return [target];
      if (url.endsWith("/issues/1")) return dependency;
      if (url.endsWith("/issues/60")) return target;
      throw new Error(`Unexpected request: ${url}`);
    };
    const snapshot = await loadGitHubBacklogSnapshot(
      { repository, concurrency: 1, apiRoot: "https://github.example/api/v3" },
      request,
    );
    assert.equal(snapshot.metadata.doubleRead, true);
    assert.equal(snapshot.issues.length, 2);
    assert.equal(requests.filter((url) => url.endsWith("/issues/1")).length, 2);
    assert.equal(requests.filter((url) => url.endsWith("/issues/60")).length, 1);
    assert.equal(planBacklogReconciliation(snapshot).dispositions[0].kind, "blocked-to-ready");
  });

  it("parses the final repos/owner/name triplet for GitHub.com and GitHub Enterprise", async () => {
    const reposRepository = "repos/repos";
    for (const [apiRoot, repositoryUrl] of [
      ["https://api.github.com", "https://api.github.com/repos/repos/repos"],
      ["https://github.example/api/v3", "https://github.example/api/v3/repos/repos/repos"],
    ]) {
      const target = restIssue(63, { repository: reposRepository, repository_url: repositoryUrl });
      const snapshot = await loadGitHubBacklogSnapshot(
        { repository: reposRepository, concurrency: 1, apiRoot },
        async (url) => (url.includes("/issues?") ? [target] : target),
      );
      assert.equal(snapshot.repository, reposRepository);
      assert.equal(snapshot.issues[0].repository, reposRepository);
    }
  });

  it("marks target and dependency drift instead of planning from reordered metadata", async () => {
    const target = restIssue(61, { body: automatic(["#2"]) });
    const dependency = restIssue(2, { state: "closed", body: "", labels: [] });
    let targetReads = 0;
    let dependencyReads = 0;
    const request = async (url) => {
      if (url.includes("/issues?")) return [target];
      if (url.endsWith("/issues/2")) {
        dependencyReads += 1;
        return dependencyReads === 1 ? dependency : { ...dependency, updated_at: "2026-07-15T03:01:00Z" };
      }
      if (url.endsWith("/issues/61")) {
        targetReads += 1;
        return { ...target, body: automatic(), updated_at: `2026-07-15T03:0${targetReads + 1}:00Z` };
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const snapshot = await loadGitHubBacklogSnapshot({ repository, concurrency: 1 }, request);
    const plan = planBacklogReconciliation(snapshot);
    assert.equal(plan.dispositions[0].kind, "drift");
    assert.equal(snapshot.issues.filter(({ stable }) => stable === false).length, 2);
  });

  it("reports inaccessible dependencies and enforces issue and pagination bounds", async () => {
    const target = restIssue(62, { body: automatic(["honua-io/private#9"]) });
    const inaccessibleRequest = async (url) => {
      if (url.includes("/issues?")) return [target];
      if (url.endsWith("/repos/honua-io/private/issues/9")) {
        throw new GitHubBacklogMetadataError("not-found", 404);
      }
      if (url.endsWith("/issues/62")) return target;
      throw new Error(`Unexpected request: ${url}`);
    };
    const snapshot = await loadGitHubBacklogSnapshot({ repository, concurrency: 1 }, inaccessibleRequest);
    const inaccessiblePlan = planBacklogReconciliation(snapshot).dispositions[0];
    assert.equal(inaccessiblePlan.kind, "inaccessible");
    assert.equal(inaccessiblePlan.proposedLabels, null);

    await expectMetadataError(
      "issue-bound-exceeded",
      loadGitHubBacklogSnapshot({ repository, maxIssues: 1 }, async (url) =>
        url.includes("/issues?") ? [target] : restIssue(9, { repository: "honua-io/private" }),
      ),
    );

    const fullPage = Array.from({ length: 100 }, (_, index) => restIssue(index + 1000));
    await expectMetadataError(
      "pagination-bound-exceeded",
      loadGitHubBacklogSnapshot({ repository, maxPages: 1, maxIssues: 200 }, async () => fullPage),
    );
    await expectMetadataError(
      "invalid-bound",
      loadGitHubBacklogSnapshot({ repository, concurrency: 11 }, async () => []),
    );
    await expectMetadataError(
      "invalid-api-root",
      loadGitHubBacklogSnapshot({ repository, apiRoot: "https://secret@api.github.com" }, async () => []),
    );
    await expectMetadataError(
      "degraded-api",
      loadGitHubBacklogSnapshot({ repository }, async () => {
        throw new GitHubBacklogMetadataError("degraded-api", 429);
      }),
    );
  });

  it("sanitizes token, header, fetch, body, and injected-reader failures", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE_private_issue_text";
    const originalToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    const originalHeaders = globalThis.Headers;
    const originalFetch = globalThis.fetch;
    try {
      process.env.GH_TOKEN = "";
      process.env.GITHUB_TOKEN = `ghp_valid_${secret}\n`;
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error(secret);
      };
      await assert.rejects(githubBacklogRequest("https://api.github.com/repos/o/r/issues/1"), (error) => {
        assert.equal(error.code, "invalid-token");
        assertNoTaint(`${error}\n${error.stack}`, [secret]);
        return true;
      });
      assert.equal(fetchCalled, false);

      process.env.GITHUB_TOKEN = "a".repeat(1025);
      await assert.rejects(githubBacklogRequest("https://api.github.com/repos/o/r/issues/1"), (error) => {
        assert.equal(error.code, "invalid-token");
        return true;
      });
      assert.equal(fetchCalled, false);

      process.env.GITHUB_TOKEN = `ghp_${"a".repeat(40)}`;
      globalThis.Headers = class {
        constructor() {
          throw new Error(secret);
        }
      };
      await assert.rejects(githubBacklogRequest("https://api.github.com/repos/o/r/issues/1"), (error) => {
        assert.equal(error.code, "request-setup-failed");
        assertNoTaint(`${error}\n${error.stack}`, [secret]);
        return true;
      });

      globalThis.Headers = originalHeaders;
      globalThis.fetch = async () => {
        throw new Error(secret);
      };
      await assert.rejects(githubBacklogRequest("https://api.github.com/repos/o/r/issues/1"), (error) => {
        assert.equal(error.code, "degraded-api");
        assertNoTaint(`${error}\n${error.stack}`, [secret]);
        return true;
      });

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json() {
          throw new Error(secret);
        },
      });
      await assert.rejects(githubBacklogRequest("https://api.github.com/repos/o/r/issues/1"), (error) => {
        assert.equal(error.code, "degraded-api");
        assertNoTaint(`${error}\n${error.stack}`, [secret]);
        return true;
      });

      await assert.rejects(
        loadGitHubBacklogSnapshot({ repository }, async () => {
          throw new Error(secret);
        }),
        (error) => {
          assert.equal(error.code, "degraded-api");
          assertNoTaint(`${error}\n${error.stack}`, [secret]);
          return true;
        },
      );
    } finally {
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      if (originalGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalGhToken;
      globalThis.Headers = originalHeaders;
      globalThis.fetch = originalFetch;
    }
  });
});

describe("read-only dry-run CLI", () => {
  it("prints byte-deterministic JSON and never reports a mutation", () => {
    const args = [
      cli,
      "--repository",
      repository,
      "--metadata",
      path.join(fixtureRoot, "stable-snapshot.json"),
      "--json",
    ];
    const first = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    const second = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    const result = JSON.parse(first.stdout);
    assert.equal(result.mode, "dry-run");
    assert.equal(result.mutationsPerformed, false);
  });

  it("omits the taint corpus from JSON, human, and stderr output", () => {
    const taints = [
      "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "AKIAIOSFODNN7EXAMPLE",
      "https://private.example.invalid/object?sig=private-signature",
      "private issue investigation notes",
    ];
    const newlineToken = `ghp_valid_${taints[0]}\n`;
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "honua-backlog-taint-"));
    const snapshotPath = path.join(tempDirectory, "snapshot.json");
    const malformedPath = path.join(tempDirectory, "malformed.json");
    const snapshot = {
      repository,
      issues: [
        issue(70, { body: body(`Mode: manual\nReason: ${taints[0]}`) }),
        issue(71, { body: body(`Mode: automatic\nDependencies:\n- ${taints[1]}`) }),
        issue(72, { body: automatic(["#80"]) }),
        issue(73, { body: automatic(["#81"]), labels: ["ready-to-start"] }),
        issue(81, {
          target: false,
          stable: false,
          driftReason: taints[3],
          labels: ["blocked", taints[0]],
        }),
      ],
      unavailable: [{ repository, number: 80, reason: taints[2] }],
    };
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    fs.writeFileSync(malformedPath, `{"private":"${taints[3]}"`);
    try {
      const commonArguments = [cli, "--repository", repository, "--metadata", snapshotPath];
      const json = spawnSync(process.execPath, [...commonArguments, "--json"], {
        cwd: root,
        encoding: "utf8",
      });
      const human = spawnSync(process.execPath, commonArguments, { cwd: root, encoding: "utf8" });
      assert.equal(json.status, 0, json.stderr);
      assert.equal(human.status, 0, human.stderr);
      assertNoTaint(json.stdout, taints);
      assertNoTaint(human.stdout, taints);

      const invalidToken = spawnSync(process.execPath, [cli, "--repository", repository], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: newlineToken },
      });
      assert.equal(invalidToken.status, 1);
      assert.match(invalidToken.stderr, /invalid-token/u);
      assertNoTaint(`${invalidToken.stdout}${invalidToken.stderr}`, [...taints, newlineToken]);

      const malformedSnapshot = spawnSync(
        process.execPath,
        [cli, "--repository", repository, "--metadata", malformedPath],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(malformedSnapshot.status, 1);
      assert.match(malformedSnapshot.stderr, /invalid-snapshot/u);
      assertNoTaint(`${malformedSnapshot.stdout}${malformedSnapshot.stderr}`, taints);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("locks the dependency and disposition policy tests into both SDK CI tiers", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const prFast = workflow.slice(workflow.indexOf("  pr-fast:\n"), workflow.indexOf("  benchmark-lab:\n"));
    const jsSdk = workflow.slice(workflow.indexOf("  js-sdk:\n"), workflow.indexOf("  mcp-sdk:\n"));
    for (const job of [prFast, jsSdk]) {
      assert.match(job, /node --test test\/scripts\/pr-issue-disposition\.test\.mjs/u);
      assert.match(job, /node --test test\/scripts\/backlog-dependencies\.test\.mjs/u);
    }
    assert.equal(workflow.match(/node --test test\/scripts\/backlog-dependencies\.test\.mjs/gu)?.length, 2);
  });

  it("rejects an apply flag and contains no GitHub mutation verbs", () => {
    const apply = spawnSync(process.execPath, [cli, "--repository", repository, "--apply"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(apply.status, 1);
    assert.match(apply.stderr, /invalid-argument/u);

    const reader = fs.readFileSync(path.join(root, "scripts/lib/github-backlog-dependencies.mjs"), "utf8");
    assert.doesNotMatch(reader, /\b(?:PATCH|POST|PUT|DELETE)\b/u);
    assert.match(reader, /method: "GET"/u);
  });
});
