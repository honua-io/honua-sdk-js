#!/usr/bin/env bash
set -euo pipefail
PR_NUMBER="${1:?pull request number is required}"
: "${GITHUB_REPOSITORY:?repository is required}"

# Hosted-runner admission can delay required checks beyond five minutes.
# Bound the entire wait and require every context to pass before merging.
for attempt in {1..270}; do
  required="$(gh pr checks "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --required --json name,bucket 2>/dev/null || true)"
  if [[ -z "$required" ]]; then
    required='[]'
  fi
  if jq -e 'length >= 3 and all(.[]; .bucket == "pass")' <<<"$required" >/dev/null; then
    break
  fi
  if jq -e 'any(.[]; .bucket == "fail" or .bucket == "cancel")' <<<"$required" >/dev/null; then
    echo "A required check failed or was cancelled for PR #$PR_NUMBER:"
    jq -c '.[] | select(.bucket == "fail" or .bucket == "cancel")' <<<"$required"
    exit 1
  fi
  if (( attempt == 270 )); then
    echo "Required checks did not all pass for PR #$PR_NUMBER after 45 minutes:"
    jq -c '.[] | select(.bucket != "pass")' <<<"$required"
    exit 1
  fi
  sleep 10
done
