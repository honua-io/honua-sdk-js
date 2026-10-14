/** Only the installed connector's latest summary can attest comment-only completion. */
export function completedFirstPassCommit(comments, firstPassReviewer = "chatgpt-codex-connector") {
  if (firstPassReviewer !== "chatgpt-codex-connector") return undefined;
  const summaries = comments
    .filter(
      (comment) =>
        comment.user?.login === "chatgpt-codex-connector[bot]" &&
        comment.user?.type === "Bot" &&
        comment.performed_via_github_app?.id === 1144995 &&
        comment.performed_via_github_app?.slug === "chatgpt-codex-connector" &&
        Number.isFinite(Date.parse(comment.updated_at)) &&
        comment.body?.startsWith("<!-- codex-pull-request-review-summary -->"),
    )
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  if (summaries.length > 1 && Date.parse(summaries[0].updated_at) === Date.parse(summaries[1].updated_at))
    return undefined;
  const rows = (summaries[0]?.body ?? "")
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length === 6 && /^(?:📝 )?\*\*Code Review\*\*$/.test(cells[1]));
  if (rows.length !== 1) return undefined;
  const [, , status, commit] = rows[0];
  const completed = /^✅ \*\*Completed\*\* <relative-time datetime="([^"]+)">([^<]+)<\/relative-time>$/.exec(status);
  if (!completed || !Number.isFinite(Date.parse(completed[1])) || completed[1] !== completed[2]) return undefined;
  return /^`([a-f0-9]{7,40})`$/.exec(commit)?.[1];
}

/** Resolve even abbreviated commits through GitHub; string prefix matches are not evidence. */
export function evaluateCompletedFirstPassSummary({ comments, headSha, firstPassReviewer, resolveCommit }) {
  const commitPrefix = completedFirstPassCommit(comments, firstPassReviewer);
  if (!commitPrefix || !/^[a-f0-9]{40}$/.test(headSha)) {
    return { completedSummary: false, resolution: "no-current-completion" };
  }
  try {
    const resolvedCommit = resolveCommit(commitPrefix);
    if (!/^[a-f0-9]{40}$/.test(resolvedCommit)) {
      return { completedSummary: false, commitPrefix, resolution: "invalid-commit" };
    }
    return {
      completedSummary: resolvedCommit === headSha,
      commitPrefix,
      resolvedCommit,
      resolution: resolvedCommit === headSha ? "exact-head" : "different-head",
    };
  } catch {
    return { completedSummary: false, commitPrefix, resolution: "lookup-failed" };
  }
}
