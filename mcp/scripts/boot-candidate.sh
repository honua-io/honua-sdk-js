#!/usr/bin/env bash
# Boot the pinned honua-server candidate for live MCP certification, exactly as
# a user's `honua admin install local` does: the same generated compose
# (ADMIN_LOCAL_SERVER_IMAGE + PostGIS + Redis, so the durable control plane and
# its governed tools exist), the same readiness wait, and the same admin-key
# bootstrap (the generated HONUA_ADMIN_PASSWORD is used once as X-API-Key to
# mint a scoped admin key, which the installer writes to <dir>/.env).
#
#   mcp/scripts/boot-candidate.sh <install-dir>          # boot + bootstrap
#   mcp/scripts/boot-candidate.sh <install-dir> --down   # tear down, volumes too
#
# Requires the SDK to be built (dist/src/cli/bin.js) and Docker Compose v2.
# The minted key is NEVER printed. Under GitHub Actions it is masked, and the
# outputs `install_dir`, `server_image`, `server_sha` and `mcp_url` are written to
# $GITHUB_OUTPUT. Read the key from <install-dir>/.env (HONUA_ADMIN_KEY) where it
# is needed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_ROOT/dist/src/cli/bin.js"
GENERATED="$REPO_ROOT/dist/src/control-plane/generated/admin-operations.js"

dir="${1:?usage: boot-candidate.sh <install-dir> [--down]}"
port="${HONUA_CANDIDATE_HTTP_PORT:-8080}"

if [[ "${2:-}" == "--down" ]]; then
  if [[ -f "$dir/compose.yaml" ]]; then
    docker compose --project-directory "$dir" --file "$dir/compose.yaml" down --volumes --remove-orphans || true
  fi
  exit 0
fi

if [[ ! -f "$CLI" || ! -f "$GENERATED" ]]; then
  echo "boot-candidate: build the SDK first (npm run build at the repo root)." >&2
  exit 2
fi

read -r server_image server_sha < <(
  node --input-type=module -e '
    const m = await import(process.argv[1]);
    process.stdout.write(`${m.ADMIN_LOCAL_SERVER_IMAGE} ${m.ADMIN_RELEASE_SERVER_SHA}\n`);
  ' "$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' "$GENERATED")"
)
echo "Booting pinned candidate ${server_image} (honua-server@${server_sha}) into ${dir}"

mkdir -p "$(dirname "$dir")"
receipt="$(mktemp)"
trap 'rm -f "$receipt"' EXIT
if ! node "$CLI" admin install local --yes --directory "$dir" --http-port "$port" --timeout-ms 600000 >"$receipt"; then
  echo "boot-candidate: honua admin install local failed; honua logs follow." >&2
  docker compose --project-directory "$dir" --file "$dir/compose.yaml" logs --no-color honua postgis-bootstrap >&2 || true
  exit 1
fi
# The install receipt carries the credential's id, grants and a reference
# digest, never its material, so it is safe to summarize.
node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const c = r.accessCredential ?? {};
  console.log(`Installed: status=${r.status} image=${r.serverImage} baseUrl=${r.baseUrl}`);
  console.log(`Admin key: id=${c.id} grants=${(c.effectiveGrants ?? []).join(",")} provisioned=${c.provisioned}`);
' "$receipt"

key="$(sed -n 's/^HONUA_ADMIN_KEY=//p' "$dir/.env")"
if [[ -z "$key" ]]; then
  echo "boot-candidate: the installer did not write HONUA_ADMIN_KEY to $dir/.env." >&2
  exit 1
fi
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::add-mask::${key}"
  root="$(sed -n 's/^HONUA_ADMIN_PASSWORD=//p' "$dir/.env")"
  [[ -n "$root" ]] && echo "::add-mask::${root}"
fi

mcp_url="http://localhost:${port}/mcp"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "install_dir=${dir}"
    echo "server_image=${server_image}"
    echo "server_sha=${server_sha}"
    echo "mcp_url=${mcp_url}"
  } >>"$GITHUB_OUTPUT"
fi
echo "Candidate ready at ${mcp_url}"
