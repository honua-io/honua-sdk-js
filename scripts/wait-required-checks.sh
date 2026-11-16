#!/usr/bin/env bash
set -euo pipefail
PR_NUMBER="${1:?pull request number is required}"
: "${GITHUB_REPOSITORY:?repository is required}"

base="$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json baseRefName --jq .baseRefName)"
encoded_base="$(jq -rn --arg base "$base" '$base | @uri')"
expected="$(gh api "repos/$GITHUB_REPOSITORY/rules/branches/$encoded_base" \
  --jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | unique')"
if ! jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' <<<"$expected" >/dev/null; then
  echo "Cannot determine required check contexts for PR #$PR_NUMBER."
  exit 1
fi

# Hosted-runner admission can delay required checks beyond five minutes.
# Bound the entire wait and require every context to pass before merging.
for attempt in {1..270}; do
  required="$(gh pr checks "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --required --json name,bucket 2>/dev/null || true)"
  if [[ -z "$required" ]]; then
    required='[]'
  fi
  if jq -e --argjson expected "$expected" '
    . as $checks | all(.[]; .bucket == "pass") and
    all($expected[]; . as $name | any($checks[]; .name == $name and .bucket == "pass"))
  ' <<<"$required" >/dev/null; then
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
