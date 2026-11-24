#!/usr/bin/env bash

fail() {
  local message="$1"
  echo "::error title=Release blocked for ${RELEASE_FAILURE_TAG}::${message}"
  {
    echo "## Release blocked: \`${RELEASE_FAILURE_TAG}\`"
    echo
    echo "${message}"
    if [[ -n "${RELEASE_FAILURE_FOOTER:-}" ]]; then
      echo
      echo "${RELEASE_FAILURE_FOOTER}"
    fi
  } >> "${GITHUB_STEP_SUMMARY}"
  exit 1
}
