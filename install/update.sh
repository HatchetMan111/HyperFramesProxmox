#!/bin/bash
# Hyperframes-Suite Update — IM Container ausführen:
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/HyperFramesProxmox/main/install/update.sh)"
set -euo pipefail
[[ "${DEBUG:-0}" == "1" ]] && set -x
[ "$(id -u)" = "0" ] || { echo "Als root im LXC ausführen." >&2; exit 1; }
REPO_RAW="https://raw.githubusercontent.com/HatchetMan111/HyperFramesProxmox/main"
BASE=/opt/hyperframes
# shellcheck disable=SC2154  # ec wird im trap zugewiesen
trap 'ec=$?; echo "FEHLER (Exit $ec) bei: $BASH_COMMAND"; exit $ec' ERR
npm update -g hyperframes omniroute
for f in job-server.js portal.html env.example; do
  curl -fsSL "$REPO_RAW/src/$f" -o "$BASE/$f.new" && mv "$BASE/$f.new" "$BASE/$f"
done
for u in hf-studio.service hf-studio-bridge.service hf-gallery.service omniroute.service hf-jobs.service hf-portal.service hyperframes-suite.target; do
  curl -fsSL "$REPO_RAW/src/systemd/$u" -o "/etc/systemd/system/$u"
done
cp "$BASE/portal.html" "$BASE/portal/index.html"
chown -R hyperframes:hyperframes "$BASE"
systemctl daemon-reload
systemctl restart hyperframes-suite.target
sleep 5
systemctl is-active hf-studio hf-gallery omniroute hf-jobs hf-portal
hyperframes --version
echo "UPDATE FERTIG"
