#!/usr/bin/env bash
# Install the system libraries Playwright's chromium headless shell needs on
# this WSL/Ubuntu 26.04 box (Playwright's own install-deps doesn't support it),
# then verify a headless launch works AS THE NORMAL USER. Idempotent.
# Run with sudo:  sudo bash /home/mike/honua-io/honua-sdk-js/scripts/install-playwright-deps.sh
set -u

REPO=/home/mike/honua-io/honua-sdk-js
RUN_USER=mike

echo "== 1/2 installing chromium system libs via apt =="
apt-get update
# Ubuntu 24.04+/26.04 uses the t64 ABI names; fall back to non-t64 per package.
for pkg in libnss3 libnspr4 libdbus-1-3 \
           "libatk1.0-0t64|libatk1.0-0" "libatk-bridge2.0-0t64|libatk-bridge2.0-0" \
           "libcups2t64|libcups2" libdrm2 libxcomposite1 libxdamage1 libxext6 \
           libxfixes3 libxrandr2 libgbm1 libxcb1 libxkbcommon0 \
           libpango-1.0-0 libcairo2 "libasound2t64|libasound2"; do
  primary="${pkg%%|*}"; alt="${pkg##*|}"
  if apt-get install -y "$primary" 2>/dev/null; then :;
  elif [ "$alt" != "$primary" ] && apt-get install -y "$alt" 2>/dev/null; then :;
  else echo "  WARN: could not install $pkg"; fi
done

echo "== 2/2 verifying headless launch as $RUN_USER =="
sudo -u "$RUN_USER" env HOME=/home/"$RUN_USER" node -e "const{chromium}=require('$REPO/node_modules/playwright');chromium.launch({headless:true,args:['--no-sandbox']}).then(b=>b.close()).then(()=>console.log('LAUNCH OK')).catch(e=>{console.log('LAUNCH FAIL:',e.message.split('\n')[0]);process.exit(1)})"
