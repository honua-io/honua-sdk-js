#!/usr/bin/env bash
# Verify (or refresh) the vendored geospatial-mcp JSON Schemas against the
# pinned upstream commit, proving byte-for-byte identity with the open standard.
#
# The standard is owned upstream (github.com/honua-io/geospatial-mcp); this repo
# vendors spec/schemas/ verbatim so the MCP certification harness runs offline.
# NEVER hand-edit a file under the vendored directory: change the pin and re-run
# this script with --write instead.
#
#   scripts/sync-schemas.sh            # check: fail if the vendored tree drifts
#   scripts/sync-schemas.sh --write    # refresh the vendored tree from the pin
#
# The pinned commit is the single source of truth in the vendored PROVENANCE.md
# ("Source commit: `<sha>`"). To re-pin, edit that line (and the index date),
# then run --write.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/mcp/certification/geospatial-mcp-schemas"
PROVENANCE="$VENDOR_DIR/PROVENANCE.md"
UPSTREAM_REPO="honua-io/geospatial-mcp"
UPSTREAM_SUBPATH="spec/schemas"
# Files that live inside the vendored dir but are NOT part of the upstream tree.
LOCAL_ONLY=("PROVENANCE.md")

WRITE=0
[[ "${1:-}" == "--write" ]] && WRITE=1

if [[ ! -f "$PROVENANCE" ]]; then
  echo "FAIL: cannot find $PROVENANCE" >&2
  exit 2
fi

PIN="$(grep -oE 'Source commit:\*\* `[0-9a-f]{7,40}`' "$PROVENANCE" | grep -oE '[0-9a-f]{7,40}' | head -1 || true)"
if [[ -z "$PIN" ]]; then
  echo "FAIL: could not read the pinned 'Source commit' SHA from $PROVENANCE" >&2
  exit 2
fi

echo "Vendored geospatial-mcp schemas pinned at ${UPSTREAM_REPO}@${PIN}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TARBALL_URL="https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${PIN}"
echo "Fetching ${TARBALL_URL}"
if ! curl -fsSL "$TARBALL_URL" -o "$TMP/upstream.tar.gz"; then
  echo "FAIL: could not download the pinned upstream tarball (offline or bad SHA)." >&2
  exit 2
fi
tar -xzf "$TMP/upstream.tar.gz" -C "$TMP"
UPSTREAM_SCHEMAS="$(find "$TMP" -maxdepth 4 -type d -path "*/${UPSTREAM_SUBPATH}" | head -1)"
if [[ -z "$UPSTREAM_SCHEMAS" || ! -d "$UPSTREAM_SCHEMAS" ]]; then
  echo "FAIL: upstream tarball did not contain ${UPSTREAM_SUBPATH}/" >&2
  exit 2
fi

DIFF_ARGS=()
for f in "${LOCAL_ONLY[@]}"; do DIFF_ARGS+=(-x "$f"); done

if [[ "$WRITE" == "1" ]]; then
  echo "Refreshing vendored tree from the pin..."
  # Remove everything except the local-only files, then copy upstream verbatim.
  find "$VENDOR_DIR" -mindepth 1 \
    $(printf "! -name %s " "${LOCAL_ONLY[@]}") -delete 2>/dev/null || true
  cp -R "$UPSTREAM_SCHEMAS"/. "$VENDOR_DIR"/
  echo "OK: vendored tree refreshed from ${UPSTREAM_REPO}@${PIN}."
  echo "Remember to update the 'Schema index date' in PROVENANCE.md if it changed."
  exit 0
fi

if diff -r "${DIFF_ARGS[@]}" "$UPSTREAM_SCHEMAS" "$VENDOR_DIR" >"$TMP/diff.txt" 2>&1; then
  echo "OK: vendored schemas are byte-identical to ${UPSTREAM_REPO}@${PIN}."
  exit 0
fi

echo "FAIL: the vendored geospatial-mcp schemas have drifted from the pinned" >&2
echo "      upstream commit ${UPSTREAM_REPO}@${PIN}:" >&2
sed 's/^/      /' "$TMP/diff.txt" >&2
echo "" >&2
echo "      The standard is owned upstream and vendored byte-for-byte here." >&2
echo "      Do NOT hand-edit files under mcp/certification/geospatial-mcp-schemas/." >&2
echo "      To re-pin to a newer revision, edit the 'Source commit' line in" >&2
echo "      that dir's PROVENANCE.md, then run: scripts/sync-schemas.sh --write" >&2
exit 1
