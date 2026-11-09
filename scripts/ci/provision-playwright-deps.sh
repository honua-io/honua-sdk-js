#!/usr/bin/env bash
set -euo pipefail

ubuntu_sources="${HONUA_UBUNTU_APT_SOURCES:-/etc/apt/sources.list.d/ubuntu.sources}"
if [[ ! -f "$ubuntu_sources" ]]; then
  echo "::error::Ubuntu's signed apt sources are required for browser dependencies"
  exit 1
fi

apt_state="$(mktemp -d "${RUNNER_TEMP:-/tmp}/honua-browser-apt.XXXXXX")"
trap 'sudo rm -rf "${apt_state:?}"' EXIT
mkdir "$apt_state/sources" "$apt_state/lists"
chmod 755 "$apt_state" "$apt_state/sources" "$apt_state/lists"
install -m 644 "$ubuntu_sources" "$apt_state/sources/ubuntu.sources"

version="$(node -p 'require("./package-lock.json").packages["node_modules/playwright"].version')"
plan="$(npx --yes "playwright@${version}" install-deps --dry-run chromium)"
packages="$(sed -n 's/.*apt-get install -y --no-install-recommends \([^"]*\)".*/\1/p' <<<"$plan")"
if [[ -z "$packages" ]]; then
  echo "::error::Could not read Playwright's OS dependency list"
  echo "$plan"
  exit 1
fi

# Chromium's system libraries come from Ubuntu; unrelated SDK feeds must not
# make their provisioning fail. Keep the runner's signing keys and source file.
apt_options=(-o Dir::Etc::sourcelist=/dev/null
  -o "Dir::Etc::sourceparts=$apt_state/sources"
  -o "Dir::State::lists=$apt_state/lists"
  -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=30)
for attempt in 1 2 3; do
  # Root owns the timeout so it signals apt's entire process group.
  # shellcheck disable=SC2086 # Playwright emits a space-separated package list.
  if sudo timeout --kill-after=10s 60s apt-get "${apt_options[@]}" update \
    && sudo env DEBIAN_FRONTEND=noninteractive timeout --kill-after=10s 210s \
      apt-get "${apt_options[@]}" install -y --no-install-recommends $packages; then
    exit 0
  fi
  if (( attempt < 3 )); then
    echo "::warning::Browser OS dependency attempt ${attempt} failed; retrying"
    sudo timeout --kill-after=10s 30s dpkg --configure -a || true
    sleep $((attempt * 15))
  fi
done
echo "::error::Browser OS dependencies could not be provisioned from Ubuntu"
exit 1
