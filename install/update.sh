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

npm update -g hyperframes
# OmniRoute nur aktualisieren, wenn lokal installiert (sonst fehlt das Paket -> npm abbruch)
if command -v omniroute >/dev/null 2>&1; then
  npm update -g omniroute
else
  echo "OmniRoute nicht lokal installiert — Update übersprungen (Remote-Instanz bleibt verbunden)."
fi

for f in job-server.js portal.html env.example; do
  curl -fsSL "$REPO_RAW/src/$f" -o "$BASE/$f.new" && mv "$BASE/$f.new" "$BASE/$f"
done

# Units aktualisieren, aber maskierte Dienste nicht ungewollt freischalten
for u in hf-studio.service hf-studio-bridge.service hf-gallery.service omniroute.service hf-jobs.service hf-portal.service hyperframes-suite.target; do
  if [ "$(systemctl is-enabled "$u" 2>/dev/null || echo unknown)" = "masked" ]; then
    echo "$u ist maskiert — Unit-Datei wird nicht überschrieben"
    continue
  fi
  curl -fsSL "$REPO_RAW/src/systemd/$u" -o "/etc/systemd/system/$u"
done
cp "$BASE/portal.html" "$BASE/portal/index.html"
chown -R hyperframes:hyperframes "$BASE"
systemctl daemon-reload
systemctl restart hyperframes-suite.target
sleep 5

# Nur die tatsächlich erwarteten Dienste prüfen (nicht masked/inactive als bricht das Script ab)
SVCS="hf-studio hf-studio-bridge hf-gallery hf-jobs hf-portal"
if systemctl is-enabled omniroute.service >/dev/null 2>&1; then
  SVCS="$SVCS omniroute"
fi
failed=""
for svc in $SVCS; do
  if [ "$(systemctl is-active "$svc" 2>/dev/null || echo failed)" != "active" ]; then
    echo "WARNUNG: $svc nicht aktiv"
    failed="$failed $svc"
  fi
done
[ -z "$failed" ] || { echo "Nicht-aktive Dienste:$failed — Status mit 'systemctl status $failed' prüfen."; }
hyperframes --version
echo "UPDATE FERTIG"
