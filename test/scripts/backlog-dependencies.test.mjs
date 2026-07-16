import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BacklogDependencyApplyError,
  applyGitHubBacklogReconciliation,
} from "../../scripts/lib/apply-backlog-dependencies.mjs";
import {
  BacklogDependencyError,
  parseBacklogDependencies,
  planBacklogReconciliation,
} from "../../scripts/lib/backlog-dependencies.mjs";
import {
  GitHubBacklogMetadataError,
  githubBacklogLabelRequest,
  githubBacklogRequest,
  loadGitHubBacklogSnapshot,
  loadGitHubBacklogTargetSnapshot,
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

function jsonResponse(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryGitHub(initialIssues) {
  const issues = new Map();
  for (const initial of initialIssues) {
    const issueRepository = initial.repository_url.split("/repos/").at(-1).toLowerCase();
    issues.set(`${issueRepository}#${initial.number}`, cloneJson(initial));
  }
  const mutations = [];
  let revision = 0;

  function issueFromUrl(url) {
    const parsed = new URL(url);
    const match = /\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/u.exec(parsed.pathname);
    if (!match) return null;
    return issues.get(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}#${match[3]}`) ?? null;
  }

  async function read(url) {
    const parsed = new URL(url);
    if (parsed.search) {
      const match = /\/repos\/([^/]+)\/([^/]+)\/issues$/u.exec(parsed.pathname);
      assert.ok(match, `Unexpected list URL: ${url}`);
      const issueRepository = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase();
      return [...issues.entries()]
        .filter(([key, value]) => key.startsWith(`${issueRepository}#`) && value.state === "open")
        .map(([, value]) => cloneJson(value))
        .sort((left, right) => left.number - right.number);
    }
    const value = issueFromUrl(url);
    if (!value) throw new GitHubBacklogMetadataError("not-found", 404);
    return cloneJson(value);
  }

  async function mutate(url, options) {
    const value = issueFromUrl(url);
    if (!value) throw new GitHubBacklogMetadataError("not-found", 404);
    mutations.push({ url, labels: [...options.labels] });
    value.labels = options.labels.map((name) => ({ name }));
    revision += 1;
    value.updated_at = `2026-07-15T03:00:${String(revision).padStart(2, "0")}Z`;
    return cloneJson(value);
  }

  return { issues, mutations, read, mutate };
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

  it("uses valid Markdown container semantics and ignores hidden headings", () => {
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

    for (const hiddenHtml of [
      "<pre>\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n## End\n</pre>",
      "<script>\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n</script>",
      "<script>\n</script not-an-end-tag>\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n</script>",
      "<style>\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n</style>",
      "<textarea>\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n</textarea>",
      "<table>\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n</table>\n",
      "<div>\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n</div>\n",
      "<details>\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n</details>\n",
      '<custom-element data-value=">">\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n</custom-element>\n',
      "<?processing\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n?>",
      "<!DECLARATION\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n>",
      "<![CDATA[\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n]]>",
      "<![CDATA[\nordinary > content\n## Backlog Dependencies\nMode: automatic\nDependencies: none\n]]>",
    ]) {
      expectDependencyError("missing-dependency-section", () =>
        parseBacklogDependencies(`## Specifica\n\nType: Feature\n\n${hiddenHtml}`, {
          repository,
          issueNumber: 2,
        }),
      );
    }
  });

  it("requires whitespace-obfuscated epics to use the manual opt-out", () => {
    for (const epicType of ["Type: Epic ", "Type:\tEpic", "\tType: Epic\t", "type: epic"]) {
      expectDependencyError("epic-requires-manual", () =>
        parseBacklogDependencies(
          `## Specifica\n\n${epicType}\n\n## Backlog Dependencies\n\nMode: automatic\nDependencies: none`,
          {
            repository,
            issueNumber: 2,
          },
        ),
      );
    }
  });

  it("fails closed on missing, ambiguous, or noncanonical automatic Specifica types", () => {
    for (const declaration of [
      null,
      "Type: Feature ",
      "type: feature",
      "Type: **Epic**",
      "Type: Epic <!-- noncanonical -->",
      "Type: Epic\u00a0",
      "Type: Feature\nType: Feature",
    ]) {
      const specifica = declaration === null ? "## Specifica\n\nFixture." : `## Specifica\n\n${declaration}`;
      expectDependencyError("invalid-specifica-type", () =>
        parseBacklogDependencies(
          `${specifica}\n\n## Context\n\nFixture.\n\n## Backlog Dependencies\n\nMode: automatic\nDependencies: none`,
          { repository, issueNumber: 2 },
        ),
      );
    }

    expectDependencyError("invalid-specifica-type", () =>
      parseBacklogDependencies(
        "## Specifica\n\nType: Feature\n\n## Specifica\n\nType: Feature\n\n" +
          "## Backlog Dependencies\n\nMode: automatic\nDependencies: none",
        { repository, issueNumber: 2 },
      ),
    );
    expectDependencyError("epic-requires-manual", () =>
      parseBacklogDependencies(
        "## Specifica\n\nType: Feature\nType: Epic\n\n" +
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

  it("is input-order independent and rejects bounded or ambiguous snapshot metadata", () => {
    const expected = planBacklogReconciliation(stableSnapshot);
    const reordered = planBacklogReconciliation({
      ...stableSnapshot,
      issues: [...stableSnapshot.issues].reverse(),
      unavailable: [...stableSnapshot.unavailable].reverse(),
    });
    assert.deepEqual(reordered, expected);

    expectDependencyError("invalid-dependency-bound", () =>
      planBacklogReconciliation({ repository, issues: [] }, { maxDependencies: 0 }),
    );
    expectDependencyError("invalid-issue-bound", () =>
      planBacklogReconciliation({ repository, issues: [] }, { maxIssues: 0 }),
    );
    expectDependencyError("invalid-issue-bound", () =>
      planBacklogReconciliation({ repository, issues: [] }, { maxIssues: null }),
    );
    expectDependencyError("issue-bound-exceeded", () =>
      planBacklogReconciliation({ repository, issues: [issue(1), issue(2)] }, { maxIssues: 1 }),
    );
    expectDependencyError("unavailable-overlaps-issue", () =>
      planBacklogReconciliation({
        repository,
        issues: [issue(1)],
        unavailable: [{ repository, number: 1 }],
      }),
    );
    expectDependencyError("invalid-issue-labels", () =>
      planBacklogReconciliation({ repository, issues: [issue(1, { labels: ["blocked", "blocked"] })] }),
    );
    expectDependencyError("invalid-issue-flags", () =>
      planBacklogReconciliation({ repository, issues: [issue(1, { target: "true" })] }),
    );

    let getterCalled = false;
    const accessorIssue = issue(1);
    Object.defineProperty(accessorIssue, "repository", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("private-accessor-taint");
      },
    });
    expectDependencyError("invalid-issue-metadata", () =>
      planBacklogReconciliation({ repository, issues: [accessorIssue] }),
    );
    assert.equal(getterCalled, false);

    let stableGetterCalled = false;
    const accessorStable = issue(2);
    Object.defineProperty(accessorStable, "stable", {
      enumerable: true,
      get() {
        stableGetterCalled = true;
        return true;
      },
    });
    expectDependencyError("invalid-issue-metadata", () =>
      planBacklogReconciliation({ repository, issues: [accessorStable] }),
    );
    assert.equal(stableGetterCalled, false);

    let optionsGetterCalled = false;
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "maxIssues", {
      enumerable: true,
      get() {
        optionsGetterCalled = true;
        return 1;
      },
    });
    expectDependencyError("invalid-planner-options", () =>
      planBacklogReconciliation({ repository, issues: [] }, accessorOptions),
    );
    assert.equal(optionsGetterCalled, false);
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

  it("never promotes hidden dependency metadata or invalid Specifica types", () => {
    const hiddenDependency =
      "## Specifica\n\nType: Feature\n\n<pre>\n## Backlog Dependencies\n" +
      "Mode: automatic\nDependencies: none\n</pre>";
    const noncanonicalFeature =
      "## Specifica\n\nType: Feature \n\n## Backlog Dependencies\n\nMode: automatic\nDependencies: none";
    const obfuscatedEpic =
      "## Specifica\n\nType:\tEpic\n\n## Backlog Dependencies\n\nMode: automatic\nDependencies: none";
    const plan = planBacklogReconciliation({
      repository,
      issues: [
        issue(21, { body: hiddenDependency }),
        issue(22, { body: noncanonicalFeature }),
        issue(23, { body: obfuscatedEpic }),
      ],
    });
    assert.deepEqual(
      plan.dispositions.map(({ number, kind, proposedLabels }) => [number, kind, proposedLabels]),
      [
        [21, "missing", null],
        [22, "malformed", null],
        [23, "malformed", null],
      ],
    );
  });

  it("detects dependency cycles, self-cycles, and duplicate declarations", () => {
    const siteRepository = "honua-io/honua-site";
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
        issue(36, {
          body: automatic([`${siteRepository}#120`]),
          labels: ["ready-to-start"],
        }),
        issue(120, {
          repository: siteRepository,
          body: body(`Mode: automatic\nDependencies:\n- ${repository}#36`),
          target: false,
        }),
      ],
    };
    const plan = planBacklogReconciliation(snapshot);
    assert.deepEqual(
      plan.dispositions.map(({ number, kind }) => [number, kind]),
      [
        [30, "cycle"],
        [33, "cycle"],
        [34, "malformed"],
        [36, "cycle"],
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
    assert.deepEqual(plan.dispositions[3].proposedLabels, {
      remove: ["ready-to-start"],
      add: ["blocked"],
    });
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
      "invalid-bound",
      loadGitHubBacklogSnapshot({ repository, maxIssues: null }, async () => []),
    );
    await expectMetadataError(
      "invalid-api-root",
      loadGitHubBacklogSnapshot({ repository, apiRoot: "https://secret@api.github.com" }, async () => []),
    );
    await expectMetadataError(
      "invalid-api-root",
      loadGitHubBacklogSnapshot({ repository, apiRoot: null }, async () => []),
    );
    await expectMetadataError(
      "invalid-api-root",
      loadGitHubBacklogSnapshot({ repository, apiRoot: "ftp://localhost/api/v3" }, async () => []),
    );
    await expectMetadataError(
      "invalid-api-root",
      loadGitHubBacklogSnapshot({ repository, apiRoot: "http://api.github.com" }, async () => []),
    );
    await expectMetadataError(
      "degraded-api",
      loadGitHubBacklogSnapshot({ repository }, async () => {
        throw new GitHubBacklogMetadataError("degraded-api", 429);
      }),
    );

    const twoMissing = restIssue(64, { body: automatic(["honua-io/private#9", "honua-io/private#10"]) });
    await expectMetadataError(
      "issue-bound-exceeded",
      loadGitHubBacklogSnapshot({ repository, maxIssues: 2 }, async (url) => {
        if (url.includes("/issues?")) return [twoMissing];
        throw new GitHubBacklogMetadataError("not-found", 404);
      }),
    );
  });

  it("rejects malformed API fields before planning or graph expansion", async () => {
    for (const malformed of [
      restIssue(65, { repository_url: `https://attacker.invalid/repos/${repository}` }),
      restIssue(65, { body: "x".repeat(100_001) }),
      restIssue(65, { labels: Array.from({ length: 101 }, (_, index) => ({ name: `label-${index}` })) }),
      restIssue(65, { pull_request: false }),
      restIssue(65, { updated_at: "not-a-timestamp" }),
      restIssue(65, { updated_at: "2026-02-30T03:00:00Z" }),
    ]) {
      await expectMetadataError(
        "malformed-metadata",
        loadGitHubBacklogSnapshot({ repository }, async (url) => (url.includes("/issues?") ? [malformed] : malformed)),
      );
    }
  });

  it("origin-locks token-bearing requests and bounds streamed JSON responses", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    try {
      process.env.GH_TOKEN = "";
      process.env.GITHUB_TOKEN = `ghp_${"a".repeat(40)}`;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return jsonResponse({ ok: true });
      };

      await expectMetadataError(
        "invalid-request-url",
        githubBacklogRequest("https://attacker.invalid/repos/o/r/issues/1"),
      );
      await expectMetadataError("invalid-request-url", githubBacklogRequest("https://api.github.com/user"));
      await expectMetadataError(
        "invalid-request-url",
        githubBacklogRequest("https://api.github.com/repos/o/r/issues/9007199254740992"),
      );
      await expectMetadataError(
        "invalid-request-url",
        githubBacklogRequest(
          "https://api.github.com/repos/o/r/issues?state=open&sort=created&direction=asc&per_page=100&page=11",
        ),
      );
      await expectMetadataError(
        "invalid-bound",
        githubBacklogRequest("https://api.github.com/repos/o/r/issues/1", { maxResponseBytes: null }),
      );
      assert.equal(fetchCalls, 0);

      const valid = await githubBacklogRequest("https://api.github.com/repos/o/r/issues/1", {
        maxResponseBytes: 64,
      });
      assert.deepEqual(valid, { ok: true });
      assert.equal(fetchCalls, 1);

      globalThis.fetch = async () =>
        jsonResponse({ exhausted: true }, { "x-ratelimit-remaining": "0" });
      await expectMetadataError(
        "rate-limited",
        githubBacklogRequest("https://api.github.com/repos/o/r/issues/1", { maxResponseBytes: 64 }),
      );

      globalThis.fetch = async () =>
        new Response("{}", {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        });
      await expectMetadataError(
        "rate-limited",
        githubBacklogRequest("https://api.github.com/repos/o/r/issues/1", { maxResponseBytes: 64 }),
      );

      globalThis.fetch = async () => jsonResponse({ oversized: "x".repeat(32) });
      await expectMetadataError(
        "response-bound-exceeded",
        githubBacklogRequest("https://api.github.com/repos/o/r/issues/1", { maxResponseBytes: 8 }),
      );

      globalThis.fetch = async () => jsonResponse({ mismatch: true }, { "content-length": "1" });
      await expectMetadataError(
        "degraded-api",
        githubBacklogRequest("https://api.github.com/repos/o/r/issues/1", { maxResponseBytes: 64 }),
      );

      globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "text/plain" } });
      await expectMetadataError(
        "degraded-api",
        githubBacklogRequest("https://api.github.com/repos/o/r/issues/1", { maxResponseBytes: 64 }),
      );

      let chunk = 0;
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: {
          getReader() {
            return {
              async read() {
                chunk += 1;
                return { done: false, value: Uint8Array.of(0x20) };
              },
              async cancel() {},
            };
          },
        },
      });
      await expectMetadataError(
        "response-bound-exceeded",
        githubBacklogRequest("https://api.github.com/repos/o/r/issues/1"),
      );
      assert.equal(chunk, 16_385);
    } finally {
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      if (originalGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalGhToken;
      globalThis.fetch = originalFetch;
    }
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

describe("trusted backlog dependency apply", () => {
  it("changes one eligible synthetic issue exactly once and makes the second run a no-op", async () => {
    const github = memoryGitHub([
      restIssue(10, {
        body: automatic(["#20"]),
        labels: [{ name: "priority/P2" }, { name: "blocked" }],
      }),
      restIssue(20, { state: "closed", labels: [{ name: "phase/Beta" }] }),
    ]);
    const input = { repository, maxPages: 2, maxIssues: 20, maxDependencies: 10, concurrency: 1 };

    const targeted = await loadGitHubBacklogTargetSnapshot({ ...input, issueNumber: 10 }, github.read);
    assert.equal(targeted.metadata.doubleRead, true);
    assert.equal(targeted.metadata.targeted, true);
    assert.equal(targeted.issues.length, 2);

    const first = await applyGitHubBacklogReconciliation(input, {
      read: github.read,
      mutate: github.mutate,
    });
    assert.equal(first.mode, "apply");
    assert.equal(first.mutationsPerformed, true);
    assert.equal(first.appliedCount, 1);
    assert.deepEqual(first.applied, [{ issue: "#10", remove: "blocked", add: "ready-to-start" }]);
    assert.equal(github.mutations.length, 1);
    assert.deepEqual(github.mutations[0].labels, ["priority/P2", "ready-to-start"]);

    const second = await applyGitHubBacklogReconciliation(input, {
      read: github.read,
      mutate: github.mutate,
    });
    assert.equal(second.mode, "apply");
    assert.equal(second.mutationsPerformed, false);
    assert.equal(second.appliedCount, 0);
    assert.deepEqual(second.applied, []);
    assert.equal(github.mutations.length, 1);
  });

  it("double-reads the transitive graph again and performs no write when a dependency drifts", async () => {
    const github = memoryGitHub([
      restIssue(10, { body: automatic(["#20"]), labels: [{ name: "blocked" }] }),
      restIssue(20, { state: "closed" }),
    ]);
    let dependencyReads = 0;
    const driftingRead = async (url, options) => {
      if (url.endsWith("/issues/20")) {
        dependencyReads += 1;
        if (dependencyReads === 5) {
          const dependency = github.issues.get(`${repository}#20`);
          dependency.state = "open";
          dependency.updated_at = "2026-07-15T03:00:01Z";
        }
      }
      return github.read(url, options);
    };

    await assert.rejects(
      applyGitHubBacklogReconciliation(
        { repository, maxPages: 2, maxIssues: 20, maxDependencies: 10, concurrency: 1 },
        { read: driftingRead, mutate: github.mutate },
      ),
      (error) => error instanceof BacklogDependencyApplyError && error.code === "preflight-drift",
    );
    assert.equal(dependencyReads, 6);
    assert.equal(github.mutations.length, 0);
  });

  it("rejects transitive dependency-body drift even when the direct disposition is unchanged", async () => {
    const dependencyRepository = "honua-io/backlog-dependency";
    const github = memoryGitHub([
      restIssue(10, {
        body: automatic([`${dependencyRepository}#20`]),
        labels: [{ name: "ready-to-start" }],
      }),
      restIssue(20, { repository: dependencyRepository, body: automatic() }),
    ]);
    let dependencyReads = 0;
    const driftingRead = async (url, options) => {
      if (url.endsWith(`/repos/${dependencyRepository}/issues/20`)) {
        dependencyReads += 1;
        if (dependencyReads === 3) {
          const dependency = github.issues.get(`${dependencyRepository}#20`);
          dependency.body = body("Mode: manual\nReason: Dependency sequencing changed during preflight.");
          dependency.updated_at = "2026-07-15T03:00:01Z";
        }
      }
      return github.read(url, options);
    };

    await assert.rejects(
      applyGitHubBacklogReconciliation(
        { repository, maxPages: 2, maxIssues: 20, maxDependencies: 10, concurrency: 1 },
        { read: driftingRead, mutate: github.mutate },
      ),
      (error) => error instanceof BacklogDependencyApplyError && error.code === "preflight-drift",
    );
    assert.equal(dependencyReads, 4);
    assert.equal(github.mutations.length, 0);
  });

  it("demotes readiness while preserving every unrelated label and is idempotent", async () => {
    const github = memoryGitHub([
      restIssue(10, {
        body: automatic(["#20"]),
        labels: [{ name: "priority/P2" }, { name: "ready-to-start" }, { name: "effort/S" }],
      }),
      restIssue(20, { state: "open", labels: [{ name: "phase/Beta" }] }),
    ]);
    const input = { repository, maxPages: 2, maxIssues: 20, maxDependencies: 10, concurrency: 1 };

    const first = await applyGitHubBacklogReconciliation(input, {
      read: github.read,
      mutate: github.mutate,
    });
    assert.deepEqual(first.applied, [{ issue: "#10", remove: "ready-to-start", add: "blocked" }]);
    assert.deepEqual(github.mutations[0].labels, ["blocked", "effort/S", "priority/P2"]);

    const second = await applyGitHubBacklogReconciliation(input, {
      read: github.read,
      mutate: github.mutate,
    });
    assert.equal(second.appliedCount, 0);
    assert.equal(github.mutations.length, 1);
  });

  it("makes target metadata the final pre-mutation read and rejects last-read drift", async () => {
    const github = memoryGitHub([
      restIssue(10, { body: automatic(["#20"]), labels: [{ name: "blocked" }] }),
      restIssue(20, { state: "closed" }),
    ]);
    let targetReads = 0;
    const driftingRead = async (url, options) => {
      if (url.endsWith("/issues/10")) {
        targetReads += 1;
        if (targetReads === 7) {
          const target = github.issues.get(`${repository}#10`);
          target.body = automatic();
          target.updated_at = "2026-07-15T03:00:01Z";
        }
      }
      return github.read(url, options);
    };

    await assert.rejects(
      applyGitHubBacklogReconciliation(
        { repository, maxPages: 2, maxIssues: 20, maxDependencies: 10, concurrency: 1 },
        { read: driftingRead, mutate: github.mutate },
      ),
      (error) => error instanceof BacklogDependencyApplyError && error.code === "preflight-drift",
    );
    assert.equal(targetReads, 7);
    assert.equal(github.mutations.length, 0);
  });

  it("origin-locks one atomic PATCH and rejects ambiguous label payloads before fetch", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    const originalFetch = globalThis.fetch;
    const calls = [];
    try {
      process.env.GH_TOKEN = "";
      process.env.GITHUB_TOKEN = `ghp_${"a".repeat(40)}`;
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(
          restIssue(10, {
            labels: [{ name: "priority/P2" }, { name: "ready-to-start" }],
            updated_at: "2026-07-15T03:00:01Z",
          }),
        );
      };

      await githubBacklogLabelRequest(`https://api.github.com/repos/${repository}/issues/10`, {
        labels: ["priority/P2", "ready-to-start"],
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.method, "PATCH");
      assert.equal(calls[0].options.redirect, "error");
      assert.deepEqual(JSON.parse(calls[0].options.body), {
        labels: ["priority/P2", "ready-to-start"],
      });

      await expectMetadataError(
        "invalid-label-mutation",
        githubBacklogLabelRequest(`https://api.github.com/repos/${repository}/issues/10`, {
          labels: ["blocked", "blocked"],
        }),
      );
      await expectMetadataError(
        "invalid-request-url",
        githubBacklogLabelRequest("https://attacker.invalid/repos/o/r/issues/10", {
          labels: ["blocked"],
        }),
      );
      await expectMetadataError(
        "invalid-request-url",
        githubBacklogLabelRequest(
          "https://api.github.com/repos/o/r/issues?state=open&sort=created&direction=asc&per_page=100&page=1",
          { labels: ["blocked"] },
        ),
      );
      assert.equal(calls.length, 1);

      globalThis.fetch = async () =>
        new Response("{}", {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
          },
        });
      await expectMetadataError(
        "rate-limited",
        githubBacklogLabelRequest(`https://api.github.com/repos/${repository}/issues/10`, {
          labels: ["blocked"],
        }),
      );
    } finally {
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      if (originalGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalGhToken;
      globalThis.fetch = originalFetch;
    }
  });
});

describe("backlog dependency CLI and workflow", () => {
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

  it("rejects duplicate arguments and unsafe or oversized snapshot files", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "honua-backlog-bounds-"));
    const oversizedPath = path.join(tempDirectory, "oversized.json");
    const invalidUtf8Path = path.join(tempDirectory, "invalid-utf8.json");
    const symlinkPath = path.join(tempDirectory, "snapshot-link.json");
    try {
      fs.closeSync(fs.openSync(oversizedPath, "w"));
      fs.truncateSync(oversizedPath, 16 * 1024 * 1024 + 1);
      fs.writeFileSync(invalidUtf8Path, Buffer.from([0xff]));
      fs.symlinkSync(path.join(fixtureRoot, "stable-snapshot.json"), symlinkPath);

      for (const args of [
        ["--repository", repository, "--repository", repository],
        ["--repository", repository, "--json", "--json"],
        ["--repository", repository, "--apply", "--apply"],
        ["--repository", repository, "--apply", "--metadata", path.join(fixtureRoot, "stable-snapshot.json")],
        ["--repository", repository, "--metadata", oversizedPath],
        ["--repository", repository, "--metadata", invalidUtf8Path],
        ["--repository", repository, "--metadata", symlinkPath],
        ["--repository", repository, "--metadata", tempDirectory],
        ["--repository", repository, "--metadata", path.join(fixtureRoot, "stable-snapshot.json"), "--max-issues", "1"],
      ]) {
        const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
        assert.equal(result.status, 1, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Backlog dependency reconciliation failed:/u);
      }
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the trusted workflow pinned, least-privilege, and isolated from pull-request code", () => {
    const workflow = fs.readFileSync(
      path.join(root, ".github/workflows/backlog-dependency-reconciliation.yml"),
      "utf8",
    );
    assert.match(workflow, /^  schedule:/mu);
    assert.match(workflow, /^  workflow_dispatch:/mu);
    assert.doesNotMatch(
      workflow,
      /^  (?:pull_request(?:_target)?|push|workflow_run|repository_dispatch|issue_comment|issues):/mu,
    );
    assert.match(workflow, /^permissions: \{\}$/mu);
    assert.equal(workflow.match(/^      issues: read$/gmu)?.length, 1);
    assert.equal(workflow.match(/^      issues: write$/gmu)?.length, 1);
    assert.equal(workflow.match(/^      contents: read$/gmu)?.length, 2);
    assert.deepEqual(
      [...workflow.matchAll(/^[\t ]*-?[\t ]*uses:[\t ]*([^\s#]+)/gmu)].map((match) => match[1]),
      [
        "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
        "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
        "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
        "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      ],
    );
    assert.equal(workflow.match(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/gu)?.length, 2);
    assert.equal(workflow.match(/path: trusted-policy/gu)?.length, 2);
    assert.equal(workflow.match(/persist-credentials: false/gu)?.length, 2);
    assert.equal(workflow.match(/working-directory: trusted-policy/gu)?.length, 2);
    assert.equal(workflow.match(/^        run: \|$/gmu)?.length, 2);
    assert.equal(workflow.match(/^        shell: bash$/gmu)?.length, 2);
    assert.equal(workflow.match(/node scripts\/reconcile-backlog-dependencies\.mjs/gu)?.length, 2);
    assert.equal(workflow.match(/^            --apply \\$/gmu)?.length, 1);
    assert.doesNotMatch(workflow, /github\.event\.pull_request|github\.sha|secrets:|gh issue comment/u);
    assert.doesNotMatch(workflow, /\b(?:curl|wget|git|npm|npx|pnpm|yarn|bun|deno|python|ruby|perl|eval|source)\b/u);
    assert.doesNotMatch(workflow, /(?:refs\/pull|pull\/\d|GITHUB_EVENT_PATH|repository:|\$\(.*(?:node|sh|bash))/u);
    assert.match(workflow, /^    if: github\.event_name == 'schedule' \|\| inputs\.mode == 'apply'$/mu);

    const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    assert.equal(ci.match(/node --test test\/scripts\/backlog-dependencies\.test\.mjs/gu)?.length, 2);
  });

  it("keeps dry-run reads separate from the single bounded PATCH implementation", () => {
    const reader = fs.readFileSync(path.join(root, "scripts/lib/github-backlog-dependencies.mjs"), "utf8");
    assert.equal(reader.match(/method: "PATCH"/gu)?.length, 1);
    assert.doesNotMatch(reader, /\b(?:POST|PUT|DELETE)\b/u);
    assert.match(reader, /method: "GET"/u);
  });
});
