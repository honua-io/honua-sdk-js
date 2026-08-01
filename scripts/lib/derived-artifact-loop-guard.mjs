export const DERIVED_ARTIFACT_REGEN_MARKER = "chore(evidence): regenerate derived artifacts";

/**
 * Decide whether the derived-artifact workflow may skip regeneration.
 *
 * Only a merge commit whose second-parent chain contains one to four
 * regeneration commits based directly on the merge's first parent proves that
 * the generated artifacts are current. A one-parent commit is deliberately
 * never sufficient: squash-merging the generated chain destroys the ancestry
 * that evidence receipts bind to, even when the resulting subject retains the
 * regeneration marker.
 */
export function evaluateDerivedArtifactTip({
  releaseMatrixReceiptRunId = "",
  firstParent,
  secondParent,
  readCommit,
}) {
  if (releaseMatrixReceiptRunId.trim() !== "") {
    return {
      skip: false,
      reason: `Dispatch carries a release-matrix receipt from run ${releaseMatrixReceiptRunId}; regenerating.`,
    };
  }

  if (typeof firstParent !== "string" || firstParent === "") {
    return { skip: false, reason: "Tip has no first parent; regenerating." };
  }
  if (typeof secondParent !== "string" || secondParent === "") {
    return {
      skip: false,
      reason: "Tip is not an ancestry-preserving regeneration merge; regenerating.",
    };
  }

  let chainCursor = secondParent;
  let commitCount = 0;
  const visited = new Set();
  while (chainCursor !== "") {
    if (visited.has(chainCursor)) {
      return { skip: false, reason: "Regeneration chain is cyclic or malformed; regenerating." };
    }
    visited.add(chainCursor);

    const commit = readCommit(chainCursor);
    if (!commit?.subject?.startsWith(DERIVED_ARTIFACT_REGEN_MARKER)) {
      break;
    }
    commitCount += 1;
    chainCursor = commit.parent ?? "";
  }

  if (commitCount >= 1 && commitCount <= 4 && chainCursor === firstParent) {
    return {
      skip: true,
      reason: `Tip cleanly merges the current ${commitCount}-commit regeneration chain; nothing to regenerate.`,
    };
  }

  return {
    skip: false,
    reason: "Regeneration merge is absent, malformed, or based on an older trunk tip; regenerating.",
  };
}
