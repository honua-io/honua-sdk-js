const SHA = /^[0-9a-f]{40}$/u;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

/** Publish a child commit after caller-owned identity and ref rechecks; divergent updates fail non-force. */
export async function updateReleasePleaseCandidate(candidate, { request, assertCurrent }) {
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
  return commit.sha;
}
