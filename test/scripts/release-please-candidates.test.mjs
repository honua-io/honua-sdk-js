import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReleasePleasePullRequests, prepareReleasePleaseCandidates } from "../../scripts/lib/release-please-candidates.mjs";
import { RELEASE_PLEASE_HEADS } from "../../scripts/lib/release-please-disposition-check.mjs";

const [legacy, sdk, mcp] = RELEASE_PLEASE_HEADS;
const sha = (letter) => letter.repeat(40);
const input = { repository: "honua-io/honua-sdk-js", trustedPolicySha: sha("a") };
const record = (headBranchName, number) => ({ headBranchName, baseBranchName: "trunk", number });

test("action outputs map only updated candidates; missing output means no updates", () => {
  assert.deepEqual([...parseReleasePleasePullRequests("")], []);
  assert.deepEqual([...parseReleasePleasePullRequests(JSON.stringify([record(mcp, 2)]))], [[mcp, 2]]);
  for (const value of ["null", "{}", "[null]", JSON.stringify([record("unknown", 2)]),
    JSON.stringify([record(mcp, 2), record(mcp, 3)]), JSON.stringify([{ ...record(mcp, 2), baseBranchName: "main" }])]) {
    assert.throws(() => parseReleasePleasePullRequests(value));
  }
});

function harness(present = [legacy, sdk, mcp]) {
  const calls = [];
  const current = new Map(present.map((headRefName, index) => [headRefName, {
    repository: input.repository, trustedPolicySha: input.trustedPolicySha,
    headRefName, pullRequestNumber: index + 1, headSha: sha("b"),
  }]));
  return { calls, current, dependencies: {
    refresh: async (request) => {
      calls.push({ operation: request.requireCurrent ? "confirm" : "refresh", ...request });
      const candidate = current.get(request.headRefName);
      if (!candidate) return { status: "not-found" };
      return { ...candidate, status: request.releasePleaseReportedUpdate ? "release-please-updated" : "already-current" };
    },
    locks: async () => {
      calls.push({ operation: "locks" });
      return [...current.values()].map((candidate) => {
        candidate.headSha = sha("c");
        return { ...candidate, status: "normalized" };
      });
    },
    mcpNotes: async () => {
      calls.push({ operation: "mcp" });
      const candidate = current.get(mcp);
      if (!candidate) return { status: "absent" };
      candidate.headSha = sha("d");
      return { status: "normalized", headSha: candidate.headSha };
    },
    workspaceNotes: async () => {
      calls.push({ operation: "legacy" });
      current.get(legacy).headSha = sha("e");
      return { status: "normalized", headSha: sha("e") };
    },
  } };
}

test("mixed unchanged and updated candidates retain independent outcomes and final heads", async () => {
  const { dependencies, calls } = harness();
  const result = await prepareReleasePleaseCandidates({ ...input,
    releasePleasePullRequests: JSON.stringify([record(mcp, 3)]) }, dependencies);
  assert.equal(result.legacy.headSha, sha("e"));
  assert.equal(result.candidates.find((candidate) => candidate.headRefName === sdk).headSha, sha("c"));
  assert.equal(result.candidates.find((candidate) => candidate.headRefName === mcp).headSha, sha("d"));
  assert.deepEqual(calls.slice(0, 4).map((call) => call.releasePleaseReportedUpdate), [false, false, true, false]);
  assert.equal(calls[2].reportedPullRequestNumber, 3);
  assert.deepEqual(calls.map((call) => call.operation), ["refresh", "refresh", "refresh", "refresh",
    "locks", "mcp", "legacy", "confirm", "confirm", "confirm", "confirm"]);
});

test("no candidates produce no legacy readiness and no borrowed update disposition", async () => {
  const { dependencies, calls } = harness([]);
  const result = await prepareReleasePleaseCandidates(input, dependencies);
  assert.equal(result.legacy.status, "not-found");
  assert.ok(result.candidates.every((candidate) => candidate.status === "not-found"));
  assert.ok(calls.filter((call) => call.operation === "refresh").every((call) => call.releasePleaseReportedUpdate === false));
  assert.ok(!calls.some((call) => call.operation === "legacy"));
});

test("a final-head race fails closed after normalization", async () => {
  const { dependencies, current } = harness();
  const normalize = dependencies.mcpNotes;
  dependencies.mcpNotes = async () => {
    const result = await normalize();
    current.get(sdk).headSha = sha("f");
    return result;
  };
  await assert.rejects(prepareReleasePleaseCandidates(input, dependencies), /moved during normalization/);
});


test("normalizers receive independent exact stage snapshots including absence", async () => {
  const { dependencies } = harness([legacy, mcp]);
  const locks = dependencies.locks;
  const notes = dependencies.mcpNotes;
  let initial;
  dependencies.locks = async (request) => {
    initial = request.expectedCandidates;
    assert.equal(initial.find((entry) => entry.headRefName === mcp).headSha, sha("b"));
    assert.equal(initial.find((entry) => entry.headRefName === sdk).status, "not-found");
    return locks(request);
  };
  dependencies.mcpNotes = async (request) => {
    assert.equal(request.expectedCandidates.find((entry) => entry.headRefName === mcp).headSha, sha("c"));
    assert.equal(initial.find((entry) => entry.headRefName === mcp).headSha, sha("b"));
    return notes(request);
  };
  await prepareReleasePleaseCandidates(input, dependencies);
});
