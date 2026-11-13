const SHA = /^[0-9a-f]{40}$/u;
const HEAD_SYNC_ATTEMPTS = 15;
const HEAD_SYNC_DELAY_MS = 1_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * GitHub moves the ref at once but reports the new pull-request head only after a short sync,
 * during which REST and GraphQL snapshots can disagree. Any other reported head fails closed.
 */
async function awaitPullRequestHead(pullRequestHead, previousHead, nextHead, wait) {
  for (let attempt = 1; ; attempt += 1) {
    const reported = await pullRequestHead().catch((error) => ({ error }));
    if (reported === nextHead) return;
    requireThat(reported === previousHead || reported?.error, "The pull request reports an unexpected candidate head.");
    if (attempt >= HEAD_SYNC_ATTEMPTS) {
      throw new Error("The pull request did not report the normalized candidate head.", { cause: reported?.error });
    }
    await wait(HEAD_SYNC_DELAY_MS);
  }
}

/** Publish a child commit after caller-owned identity and ref rechecks; divergent updates fail non-force. */
export async function updateReleasePleaseCandidate(candidate, { request, assertCurrent, pullRequestHead, wait = sleep }) {
  const { api, headSha, headRefName, changes, message } = candidate;
  const write = (path, payload) => request(`${api}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  await assertCurrent();
  const parent = await request(`${api}/git/commits/${headSha}`);
  requireThat(parent?.sha === headSha && SHA.test(parent.tree?.sha), "Invalid candidate parent tree.");
  const tree = await write("git/trees", { base_tree: parent.tree.sha, tree: changes });
  requireThat(SHA.test(tree?.sha), "Invalid normalized candidate tree.");
  const commit = await write("git/commits", { message, tree: tree.sha, parents: [headSha] });
  requireThat(SHA.test(commit?.sha) && commit.tree?.sha === tree.sha && commit.parents?.length === 1 &&
    commit.parents[0]?.sha === headSha, "Invalid normalized candidate commit.");
  await assertCurrent();
  const updated = await request(`${api}/git/refs/heads/${headRefName}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  requireThat(updated?.object?.sha === commit.sha, "Normalized candidate head update was not confirmed.");
  await awaitPullRequestHead(pullRequestHead, headSha, commit.sha, wait);
  return commit.sha;
}
