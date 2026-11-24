#!/usr/bin/env bash
set -uo pipefail
# Answer a scripted sequence, one entry per call, the last entry repeating.
# "EMPTY" answers with nothing, which is how "no such run exists" is expressed.
next_line() {
  local seq="$1"
  local idx_file="$2"
  local idx
  idx="$(cat "$idx_file" 2>/dev/null || echo 0)"
  echo "$((idx + 1))" > "$idx_file"
  local line
  line="$(sed -n "$((idx + 1))p" "$seq")"
  if [[ -z "$line" ]]; then line="$(tail -n 1 "$seq")"; fi
  if [[ "$line" == "EMPTY" ]]; then return 0; fi
  echo "$line"
}
ARGS="$*"
if [[ "$ARGS" == *"--method POST"*"git/refs"* ]]; then
  [[ "$GH_TOKEN" == "protected-tag-app" ]] || exit 96
else
  [[ "$GH_TOKEN" == "job-token" ]] || exit 97
fi
case "$ARGS" in
  "run list"*)
    entry="$(next_line "${RELEASE_FIXTURE_ROOT}/run-list-ids" "${RELEASE_FIXTURE_ROOT}/run-list-index")"
    if [[ "$entry" == \[* ]]; then
      # Model `gh run list`: honour --branch, then evaluate --jq over the rows.
      branch=""
      jqexpr=""
      prev=""
      for a in "$@"; do
        case "$prev" in
          --branch) branch="$a" ;;
          --jq) jqexpr="$a" ;;
        esac
        prev="$a"
      done
      rows="$entry"
      if [[ -n "$branch" && "${FIXTURE_RUN_LIST_HONOURS_BRANCH_FLAG}" == "1" ]]; then
        rows="$(jq -c --arg b "$branch" '[.[] | select(.headBranch == $b)]' <<<"$rows")"
      fi
      if [[ -n "$jqexpr" ]]; then
        jq -r "$jqexpr" <<<"$rows"
      else
        echo "$rows"
      fi
    else
      echo "$entry"
    fi
    ;;
  "run view"*)
    echo "view:$3" >> "${RELEASE_FIXTURE_ROOT}/observations"
    conclusion="$(next_line "${RELEASE_FIXTURE_ROOT}/reseal-conclusions" "${RELEASE_FIXTURE_ROOT}/reseal-index")"
    if [[ "$conclusion" == "ERROR" ]]; then exit 1; fi
    echo "$conclusion"
    ;;
  "workflow run regenerate-derived-artifacts.yml"*) echo "reseal-dispatch" >> "${RELEASE_FIXTURE_ROOT}/trace" ;;
  "run watch"*)
    echo "watch:$3" >> "${RELEASE_FIXTURE_ROOT}/observations"
    if [[ "${FIXTURE_RESEAL_WATCH_FAILS}" == "1" ]]; then exit 1; fi
    ;;
  *"git/ref/heads/trunk"*) echo "${FIXTURE_RESEALED_COMMIT}" ;;
  *"git/ref/tags/"*)
    # The exact-ref lookup 404s for an absent tag, and real gh api prints
    # that error body on stdout. The workflow must not use it.
    echo '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#get-a-reference","status":"404"}'
    echo "gh: Not Found (HTTP 404)" >&2
    exit 1
    ;;
  *"git/matching-refs/tags/"*)
    # Answers the workflow's --jq selection: the sha when the tag exists,
    # nothing (an empty list) when it does not.
    if [[ "${FIXTURE_STRANDED_TAG_EXISTS}" == "1" ]]; then
      echo "${FIXTURE_SEALED_TAG_COMMIT}"
    fi
    ;;
  *"contents/.github/workflows/publish-js-sdk.yml?ref=${FIXTURE_RELEASE_COMMIT}"*) echo "${FIXTURE_PUBLISHER_POLICY}" ;;
  *"contents/.github/workflows/publish-js-sdk.yml?ref="*)
    echo "${FIXTURE_SEALED_PUBLISHER_POLICY}"
    ;;
  *"contents/package.json"*) echo "${FIXTURE_TRUNK_VERSION}" ;;
  # This call uses gh's own --jq .status, so the stub answers the resolved value.
  *"compare/${FIXTURE_SEALED_TAG_COMMIT}"*) echo "${FIXTURE_TAG_ANCESTRY_STATUS}" ;;
  *"/releases --paginate"*)
    # Evaluate the step's real resolve-by-tag jq against the release fixture.
    jqexpr=""
    prev=""
    for a in "$@"; do
      case "$prev" in --jq) jqexpr="$a" ;; esac
      prev="$a"
    done
    jq -r "$jqexpr" "${RELEASE_FIXTURE_ROOT}/releases.json"
    ;;
  *"compare/"*)
    printf '{"status":"ahead","merge_base_commit":{"sha":"%s"},"files":[{"filename":"llms.txt"}]}\n' "$FIXTURE_RELEASE_COMMIT"
    ;;
  *"--method POST"*"git/refs"*)
    echo "tag-create" >> "${RELEASE_FIXTURE_ROOT}/trace"
    if [[ "${FIXTURE_TAG_CREATE_FAILS}" == "1" ]]; then
      echo "gh: Reference already exists (HTTP 422)" >&2
      exit 1
    fi
    ;;
  *"--method PATCH"*"/releases/"*)
    echo "draft-publish" >> "${RELEASE_FIXTURE_ROOT}/trace"
    if [[ "${FIXTURE_PUBLISH_DRAFT_FAILS}" == "1" ]]; then
      echo "gh: Repository rule violations found" >&2
      exit 1
    fi
    echo "${FIXTURE_PUBLISHED_DRAFT_STATE}"
    ;;
  *"/releases/"*)
    if [[ "${FIXTURE_DRAFT_READ_FAILS}" == "1" ]]; then
      echo "gh: Bad credentials (HTTP 401)" >&2
      exit 1
    fi
    echo "${FIXTURE_DRAFT_STATE}"
    ;;
  *"commits/${FIXTURE_TAG}"*)
    index="$(cat "${RELEASE_FIXTURE_ROOT}/tag-index" 2>/dev/null || echo 0)"
    echo "$((index + 1))" > "${RELEASE_FIXTURE_ROOT}/tag-index"
    sed -n "$((index + 1))p" "${RELEASE_FIXTURE_ROOT}/tag-resolves" || true
    tail -n 1 "${RELEASE_FIXTURE_ROOT}/tag-resolves" > "${RELEASE_FIXTURE_ROOT}/tag-last"
    if [[ -z "$(sed -n "$((index + 1))p" "${RELEASE_FIXTURE_ROOT}/tag-resolves")" ]]; then
      cat "${RELEASE_FIXTURE_ROOT}/tag-last"
    fi
    ;;
  "workflow run publish-js-sdk.yml"*) echo "npm-publish-dispatch" >> "${RELEASE_FIXTURE_ROOT}/trace" ;;
  "workflow run first-map-release-smoke.yml"*) echo "smoke-dispatch" >> "${RELEASE_FIXTURE_ROOT}/trace" ;;
  *) echo "unexpected gh call: $ARGS" >&2; exit 99 ;;
esac
