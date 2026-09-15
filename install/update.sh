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

npm install -g hyperframes@latest
# OmniRoute nur aktualisieren, wenn lokal installiert (sonst fehlt das Paket -> npm abbruch)
if command -v omniroute >/dev/null 2>&1; then
  npm install -g omniroute@latest
else
  echo "OmniRoute nicht lokal installiert — Update übersprungen (Remote-Instanz bleibt verbunden)."
fi

for f in job-server.js portal.html env.example; do
  curl -fsSL "$REPO_RAW/src/$f" -o "$BASE/$f.new" && mv "$BASE/$f.new" "$BASE/$f"
done

# Aktuelle Ports sichern (Install-Script verdrahtet sie in Units/Portal/.env)
CUR_PORTAL=$(grep -oP 'http\.server \K\d+' /etc/systemd/system/hf-portal.service 2>/dev/null || echo 8080)
CUR_BRIDGE=$(grep -oP 'TCP-LISTEN:\K\d+' /etc/systemd/system/hf-studio-bridge.service 2>/dev/null || echo 3100)
CUR_GAL=$(grep -oP '\-\-port \K\d+' /etc/systemd/system/hf-gallery.service 2>/dev/null || echo 3101)
CUR_OMNI=$(grep -oP 'serve --port \K\d+' /etc/systemd/system/omniroute.service.d/exec.conf 2>/dev/null \
  || grep -oP 'PORT=\K\d+' /etc/systemd/system/omniroute.service 2>/dev/null || echo 20128)
# Units aktualisieren, aber maskierte Dienste nicht ungewollt freischalten
for u in hf-studio.service hf-studio-bridge.service hf-gallery.service omniroute.service hf-jobs.service hf-portal.service hyperframes-suite.target; do
  if [ "$(systemctl is-enabled "$u" 2>/dev/null || echo unknown)" = "masked" ]; then
    echo "$u ist maskiert — Unit-Datei wird nicht überschrieben"
    continue
  fi
  curl -fsSL "$REPO_RAW/src/systemd/$u" -o "/etc/systemd/system/$u"
done
# Gesicherte Ports zurück in die frischen Units schreiben (kein Zurückfallen auf Defaults)
sed -i "s/http.server 8080/http.server $CUR_PORTAL/" /etc/systemd/system/hf-portal.service
sed -i "s/TCP-LISTEN:3100/TCP-LISTEN:$CUR_BRIDGE/" /etc/systemd/system/hf-studio-bridge.service
sed -i "s/--port 3101/--port $CUR_GAL/" /etc/systemd/system/hf-gallery.service
sed -i "s/Environment=PORT=20128/Environment=PORT=$CUR_OMNI/" /etc/systemd/system/omniroute.service
if [ -f /etc/systemd/system/omniroute.service.d/exec.conf ]; then
  sed -i "s/serve --port [0-9]*/serve --port $CUR_OMNI/" /etc/systemd/system/omniroute.service.d/exec.conf
fi
sed -i "s/data-port=\"3100\"/data-port=\"$CUR_BRIDGE\"/; s/data-port=\"3101\"/data-port=\"$CUR_GAL\"/; s/data-port=\"20128\"/data-port=\"$CUR_OMNI\"/" "$BASE/portal.html" 2>/dev/null || true
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
