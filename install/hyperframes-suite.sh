#!/bin/bash
# Hyperframes-Suite — Proxmox LXC Einzeiler-Installation (Community-Scripts-Stil)
#
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/HyperFramesProxmox/main/install/hyperframes-suite.sh)"
#
# Erstellt einen LXC-Container und installiert darin: Hyperframes CLI + Studio,
# Render-Galerie, OmniRoute-Gateway (Free-Tiers) und Job-UI (Prompt → Video,
# OpenRouter/OmniRoute anklickbar). Alles läuft lokal, reboot-sicher.
set -euo pipefail
[[ "${DEBUG:-0}" == "1" ]] && set -x

# ================= Variablen (oben, anpassbar) =================
APP="hyperframes-suite"
REPO_RAW="https://raw.githubusercontent.com/HatchetMan111/HyperFramesProxmox/main"
CT_ID="${CT_ID:-$(pvesh get /cluster/nextid 2>/dev/null || echo 210)}"
CT_HOSTNAME="${CT_HOSTNAME:-hyperframes}"
CT_TEMPLATE_STORAGE="${CT_TEMPLATE_STORAGE:-local}"
CT_STORAGE="${CT_STORAGE:-local-lvm}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
# Ressourcen: Rendern ist CPU-lastig — für Leistung CPU=4 RAM=8192 empfohlen.
CT_CPU="${CT_CPU:-2}"
CT_RAM="${CT_RAM:-4096}"
CT_DISK="${CT_DISK:-20}"
# Netzwerk: DHCP Standard; statisch via IP_CIDR="192.168.178.60/24" GW="192.168.178.1"
IP_CIDR="${IP_CIDR:-dhcp}"
CT_GW="${CT_GW:-}"
CT_DNS="${CT_DNS:-192.168.178.1}"
# Ports im Container (Portal = Einstieg; Studio horcht auf localhost:3002 und wird per socat auf :3100 ins LAN gebrückt — Ports stehen in src/systemd/)
PORT_PORTAL=8080 PORT_STUDIO_LAN=3100 PORT_GALLERY=3101 PORT_JOBS=3120 PORT_OMNI=20128
# OmniRoute: 0 = kein lokales Gateway installieren, nur per URL+Key mit einer
# Remote-Instanz verbinden (in Job-UI unter Einstellungen). 1 = lokal mit installieren.
INSTALL_OMNIROUTE="${INSTALL_OMNIROUTE:-0}"
# ===============================================================

LOG="/tmp/${APP}-install.log"
exec > >(tee -a "$LOG") 2>&1

YW="\033[33m"; GN="\033[1;92m"; RD="\033[01;31m"; CL="\033[m]"
msg_info()  { echo -e "${YW}▶ $*${CL}"; }
msg_ok()    { echo -e "${GN}✔ $*${CL}"; }
msg_error() { echo -e "${RD}✘ $*${CL}"; }

# Komplette Fehlerkette bei Abbruch (Befehl gekürzt — kein 200-Zeilen-Dump)
# shellcheck disable=SC2154  # ec wird im trap zugewiesen
trap 'ec=$?; msg_error "Abbruch (Exit $ec)";
  echo "Befehl (Anfang): ${BASH_COMMAND:0:200}";
  echo "--- letzte 30 Logzeilen ($LOG) ---"; tail -n 30 "$LOG" 2>/dev/null || true;
  echo "--- Tipp: Einzeiler mit DEBUG=1 davor setzen für bash -x ---";
  echo "--- CT-Logs: pct exec $CT_ID -- journalctl -n 50 ---";
  exit $ec' ERR

[ "$(id -u)" = "0" ] || { msg_error "Als root auf dem Proxmox-Host ausführen."; exit 1; }
command -v pct >/dev/null || { msg_error "pct nicht gefunden — Proxmox-Host nötig."; exit 1; }

# ---------- Idempotenz: existierende CT-ID nur mit RESUME=1 weiterbauen ----------
RESUME=0
if pct status "$CT_ID" >/dev/null 2>&1; then
  if [ "${RESUME_MODE:-0}" = "1" ]; then
    hn="$(pct exec "$CT_ID" -- hostname 2>/dev/null || echo ?)"
    [ "$hn" = "$CT_HOSTNAME" ] || { msg_error "CT $CT_ID heißt '$hn', erwartet '$CT_HOSTNAME' — Resume abgebrochen."; exit 1; }
    msg_info "Resume-Modus: CT $CT_ID ($hn) wird weiter eingerichtet, kein Neuaufbau"
    RESUME=1
    if [ "$(pct status "$CT_ID" 2>/dev/null | awk '{print $2}')" != "running" ]; then
      msg_info "CT $CT_ID ist gestoppt — starte"
      pct start "$CT_ID"
      for i in $(seq 1 45); do
        if pct exec "$CT_ID" -- true 2>/dev/null; then break; fi
        if [ "$i" = "45" ]; then msg_error "CT startet nicht."; exit 1; fi
        sleep 2
      done
    fi
  else
    msg_error "Container $CT_ID existiert bereits — Abbruch (kein Überschreiben)."
    echo "  Entfernen mit: pct stop $CT_ID && pct destroy $CT_ID"
    echo "  Andere ID: CT_ID=211 bash -c \"\$(wget -qLO - $REPO_RAW/install/hyperframes-suite.sh)\""
    echo "  Abgebrochene Installation fortsetzen: RESUME_MODE=1 bash -c \"\$(wget -qLO - $REPO_RAW/install/hyperframes-suite.sh)\""
    exit 1
  fi
fi

# ---------- Template sicherstellen (nur bei Neuaufbau nötig) ----------
if [ "$RESUME" = "0" ]; then
TPL="$(pveam available -section system 2>/dev/null | grep -o "debian-12-standard_[^ ]*amd64.tar.zst" | sort -V | tail -n 1 || true)"
[ -n "$TPL" ] || { msg_error "Kein debian-12-Template im Katalog gefunden."; exit 1; }
if ! pveam list "$CT_TEMPLATE_STORAGE" 2>/dev/null | grep -q "debian-12-standard"; then
  msg_info "Lade Template $TPL"
  pveam download "$CT_TEMPLATE_STORAGE" "$TPL"
fi
msg_ok "Template bereit: $TPL"

# ---------- Container erstellen ----------
NET="name=eth0,bridge=$CT_BRIDGE"
if [ "$IP_CIDR" = "dhcp" ]; then NET="$NET,ip=dhcp"; else NET="$NET,ip=$IP_CIDR,gw=$CT_GW"; fi
msg_info "Erstelle CT $CT_ID ($CT_HOSTNAME, ${CT_CPU}C/${CT_RAM}MB/${CT_DISK}GB)"
pct create "$CT_ID" "${CT_TEMPLATE_STORAGE}:vztmpl/$TPL" \
  --hostname "$CT_HOSTNAME" --cores "$CT_CPU" --memory "$CT_RAM" --swap 1024 \
  --rootfs "${CT_STORAGE}:${CT_DISK}" --net0 "$NET" \
  --nameserver "$CT_DNS" --unprivileged 1 --features nesting=1 --onboot 1 --start 1
msg_ok "Container erstellt und gestartet"

# Auf CT + IP warten (max. 120 s — DHCP kann dauern; if-Bedingungen sind set -e-sicher)
msg_info "Warte auf CT-Netzwerk"
for i in $(seq 1 60); do
  if pct exec "$CT_ID" -- true 2>/dev/null; then
    if [ -n "$(pct exec "$CT_ID" -- hostname -I 2>/dev/null | awk '{print $1}')" ]; then break; fi
  fi
  if [ "$i" = "60" ]; then msg_error "CT hat nach 120 s keine IP (DHCP/Netz prüfen)."; exit 1; fi
  sleep 2
done
sleep 5
fi
CT_IP="$(pct exec "$CT_ID" -- hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$CT_IP" ] || { msg_error "Keine CT-IP ermittelbar."; exit 1; }
msg_ok "CT-IP: $CT_IP"

# ---------- Setup im Container (alles aus GitHub, nichts fest verdrahtet) ----------
msg_info "Installiere App im Container (ca. 10–15 Min.)"
pct exec "$CT_ID" -- env REPO_RAW="$REPO_RAW" INSTALL_OMNIROUTE="$INSTALL_OMNIROUTE" \
  PORT_PORTAL="$PORT_PORTAL" PORT_GALLERY="$PORT_GALLERY" PORT_JOBS="$PORT_JOBS" PORT_OMNI="$PORT_OMNI" \
  bash -s <<'CTEOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive PATH="/usr/local/bin:$PATH"
echo "==> [CT] Basis"
apt-get update && apt-get install -y curl git ffmpeg python3 socat ufw ca-certificates gnupg openssl sudo locales iproute2 unzip \
  libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2
sed -i 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
echo "==> [CT] Node.js 22"
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
apt-get update && apt-get install -y nodejs
node --version
echo "==> [CT] hyperframes (+ optional omniroute)"
npm install -g hyperframes
if [ "${INSTALL_OMNIROUTE:-0}" = "1" ]; then
  npm install -g omniroute
else
  echo "OmniRoute wird NICHT lokal installiert (nur Remote-Verbindung per URL+Key in den Einstellungen)"
fi
echo "==> [CT] FileBrowser"
curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash
echo "==> [CT] Benutzer + Code aus Repo"
id hyperframes >/dev/null 2>&1 || useradd -m -s /bin/bash hyperframes
BASE=/opt/hyperframes; mkdir -p "$BASE"/{projects,jobs,gallery,portal,studio-home}
HDIR=$(eval echo "~hyperframes")
for f in job-server.js portal.html env.example; do
  curl -fsSL "$REPO_RAW/src/$f" -o "$BASE/$f"
done
mkdir -p "$BASE/systemd"
for u in hf-studio.service hf-studio-bridge.service hf-gallery.service omniroute.service hf-jobs.service hf-portal.service hyperframes-suite.target; do
  curl -fsSL "$REPO_RAW/src/systemd/$u" -o "$BASE/systemd/$u"
done
cp "$BASE/portal.html" "$BASE/portal/index.html"
curl -fsSL "$REPO_RAW/install/update.sh" -o "$BASE/update.sh"
chmod +x "$BASE/update.sh"
[ -f "$BASE/.env" ] || { cp "$BASE/env.example" "$BASE/.env"; sed -i "s/^JOB_TOKEN=.*/JOB_TOKEN=$(openssl rand -hex 16)/" "$BASE/.env"; }
chmod 600 "$BASE/.env"; chown -R hyperframes:hyperframes "$BASE" "$HDIR"
echo "==> [CT] sudo-Regeln für UI-Verwaltung (Neustarts, Update — LAN-Box, dokumentiert in README)"
cat > /etc/sudoers.d/hyperframes-suite <<'SUDO'
hyperframes ALL=(root) NOPASSWD: /bin/systemctl restart hf-jobs, /bin/systemctl restart hf-studio, /bin/systemctl restart hf-studio-bridge, /bin/systemctl restart hf-gallery, /bin/systemctl restart hf-portal, /bin/systemctl restart omniroute, /opt/hyperframes/update.sh
SUDO
chmod 440 /etc/sudoers.d/hyperframes-suite
visudo -c -q -f /etc/sudoers.d/hyperframes-suite || { echo "FEHLER: sudoers ungültig"; exit 1; }
echo "==> [CT] Chrome + Doctor (Download ~115 MB + Entpacken — Fortschritt unten, bitte warten)"
df -h / | tail -n 1
CHROME_BIN="$(sudo -u hyperframes hyperframes browser path 2>/dev/null || true)"
if [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ]; then
  echo "Chrome bereits vorhanden ($CHROME_BIN) — Download übersprungen"
else
  rm -f /tmp/chrome-ensure.log
  sudo -u hyperframes bash -c 'hyperframes browser ensure > /tmp/chrome-ensure.log 2>&1' &
  ENSURE_PID=$!
  ELAPSED=0
  while kill -0 "$ENSURE_PID" 2>/dev/null; do
    sleep 15
    ELAPSED=$((ELAPSED + 15))
    SIZE=$(du -sh /home/hyperframes/.cache/hyperframes/chrome 2>/dev/null | cut -f1)
    [ -n "$SIZE" ] || SIZE="?"
    echo "  ... Chrome-Setup läuft (${ELAPSED}s, Cache: $SIZE)"
    if [ "$ELAPSED" -ge 1500 ]; then
      kill "$ENSURE_PID" 2>/dev/null || true
      echo "FEHLER: Chrome-Setup nach 25 Min. ohne Erfolg (Netz? Platte voll? unzip fehlt?)."
      echo "--- letzte 20 Zeilen chrome-ensure.log ---"; tail -n 20 /tmp/chrome-ensure.log 2>/dev/null || echo "(kein Log vorhanden)"
      exit 1
    fi
  done
  if ! wait "$ENSURE_PID"; then
    echo "FEHLER: hyperframes browser ensure ist fehlgeschlagen."
    echo "--- letzte 30 Zeilen chrome-ensure.log ---"; tail -n 30 /tmp/chrome-ensure.log 2>/dev/null || echo "(kein Log vorhanden)"
    echo "Manuell fortsetzen im CT: sudo -u hyperframes hyperframes browser ensure"
    exit 1
  fi
  echo "Chrome bereit: $(sudo -u hyperframes hyperframes browser path 2>/dev/null)"
fi
echo "==> [CT] Chrome Start-Test (Systembibliotheken prüfen)"
CHROME_BIN="$(sudo -u hyperframes hyperframes browser path 2>/dev/null)"
if [ -z "$CHROME_BIN" ] || ! sudo -u hyperframes "$CHROME_BIN" --version >/dev/null 2>&1; then
  echo "FEHLER: Chrome startet nicht (fehlende Systemlibs?). Ausgabe:"
  sudo -u hyperframes "$CHROME_BIN" --version 2>&1 | head -n 5 || true
  echo "Fix: apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2"
  exit 1
fi
echo "Chrome-Start OK"
df -h /dev/shm
sudo -u hyperframes hyperframes doctor 2>&1 | tail -n 15 || true
echo "==> [CT] Studio-Starterprojekt"
(cd "$BASE/projects" && sudo -u hyperframes HYPERFRAMES_SKIP_SKILLS=1 hyperframes init studio-home --example blank --non-interactive >/dev/null 2>&1 || true)
cp -r "$BASE/projects/studio-home/." "$BASE/studio-home/" 2>/dev/null || true
chown -R hyperframes:hyperframes "$BASE/studio-home"
[ -f "$BASE/studio-home/index.html" ] || echo "WARNUNG: studio-home/index.html fehlt — Studio startet ggf. leer (Prüfung: ls $BASE/studio-home)"
echo "==> [CT] Dienste aktivieren"
cp "$BASE/systemd/"*.service "$BASE/systemd/"*.target /etc/systemd/system/
echo "==> [CT] OmniRoute-Startform erkennen (nur wenn lokal installiert)"
if command -v omniroute >/dev/null 2>&1; then
  OMNI_BIN="$(command -v omniroute)"
  if "$OMNI_BIN" --help 2>&1 | grep -wq "serve"; then
    mkdir -p /etc/systemd/system/omniroute.service.d
    printf '[Service]\nExecStart=\nExecStart=%s serve --port 20128\n' "$OMNI_BIN" > /etc/systemd/system/omniroute.service.d/exec.conf
    echo "OmniRoute nutzt 'serve'-Modus"
  else
    echo "OmniRoute nutzt Standard-Start (Port per ENV)"
  fi
  systemctl enable omniroute.service 2>/dev/null || true
else
  echo "OmniRoute nicht lokal installiert — Dienst wird maskiert (Remote-Instanz in Job-UI Einstellungen verbinden)"
  systemctl mask omniroute.service 2>/dev/null || true
fi
if [ ! -f "$BASE/filebrowser.db" ]; then
  sudo -u hyperframes filebrowser config init --address 0.0.0.0 --port "$PORT_GALLERY" --root "$BASE/gallery" --database "$BASE/filebrowser.db" >/dev/null
  GALPW=$(openssl rand -base64 12); echo "$GALPW" > "$BASE/gallery-pass.txt"; chmod 600 "$BASE/gallery-pass.txt"; chown hyperframes:hyperframes "$BASE/gallery-pass.txt"
  sudo -u hyperframes filebrowser users add admin "$GALPW" --database "$BASE/filebrowser.db" >/dev/null
  sudo -u hyperframes filebrowser users update admin --perm.admin=true --database "$BASE/filebrowser.db" >/dev/null
fi
systemctl daemon-reload
systemctl enable --now hyperframes-suite.target
echo "==> [CT] Firewall (Heimnetz)"
ufw --force enable >/dev/null 2>&1 || true
IFACE=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' || echo eth0)
LAN=$(ip -o -f inet addr show "$IFACE" 2>/dev/null | awk '{print $4}' | head -n 1 | sed 's|\.[0-9]*/|.0/|' | tr -d ' ')
if [ -z "$LAN" ]; then
  echo "WARNUNG: LAN-Netz nicht ermittelbar (Interface $IFACE) — UFW-Regeln übersprungen, Ports nur per Proxmox-Firewall schützen!"
else
  for p in "$PORT_PORTAL" 3100 "$PORT_GALLERY" "$PORT_JOBS" "$PORT_OMNI"; do ufw allow from "$LAN" to any port "$p" proto tcp >/dev/null; done
  echo "UFW-Regeln für $LAN gesetzt"
fi
echo "[CT] FERTIG"
CTEOF
msg_ok "App-Installation im Container abgeschlossen"

# ---------- Verifikation vom Host (mit Start-Wartezeit: Dienste brauchen bis ~60 s) ----------
msg_info "Verifiziere Dienste + Web UIs"
# shellcheck disable=SC2086  # SVCS ist bewusst wortgetrennt
SVCS="hf-studio hf-gallery hf-jobs hf-portal"
if pct exec "$CT_ID" -- systemctl is-enabled omniroute.service >/dev/null 2>&1; then
  SVCS="$SVCS omniroute"
else
  msg_info "OmniRoute lokal nicht installiert — Dienst-Prüfung übersprungen (Remote-Instanz in Job-UI verbinden)"
fi
for svc in $SVCS; do
  ok=0
  for i in $(seq 1 12); do
    if [ "$(pct exec "$CT_ID" -- systemctl is-active "$svc" 2>/dev/null || echo failed)" = "active" ]; then ok=1; break; fi
    sleep 5
  done
  if [ "$ok" = "1" ]; then
    msg_ok "Service $svc aktiv"
  else
    msg_error "Service $svc nicht aktiv nach 60 s"
    pct exec "$CT_ID" -- journalctl -u "$svc" -n 20 --no-pager || true
    exit 1
  fi
done
for p in "$PORT_PORTAL" "$PORT_STUDIO_LAN" "$PORT_GALLERY"; do
  code="$(pct exec "$CT_ID" -- curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/" || echo 000)"
  [ "$code" = "200" ] || { msg_error "Port $p antwortet mit HTTP $code"; exit 1; }
  msg_ok "Web UI :$p → HTTP $code"
done
code="$(pct exec "$CT_ID" -- curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT_JOBS/healthz" || echo 000)"
[ "$code" = "200" ] || { msg_error "Job-UI (:$PORT_JOBS/healthz) antwortet mit HTTP $code"; exit 1; }
msg_ok "Job-UI :$PORT_JOBS → HTTP $code (Healthcheck; UI selbst braucht Token)"
# OmniRoute-Health nur bei lokaler Installation (sonst nur Info, kein Abbruch)
if pct exec "$CT_ID" -- systemctl is-enabled omniroute.service >/dev/null 2>&1; then
  if pct exec "$CT_ID" -- curl -sf -o /dev/null "http://127.0.0.1:$PORT_OMNI/v1/models"; then
    msg_ok "OmniRoute antwortet"
  else
    msg_info "OmniRoute noch im Start (gleich erneut prüfen)"
  fi
fi

GALPW="$(pct exec "$CT_ID" -- cat /opt/hyperframes/gallery-pass.txt 2>/dev/null || echo '?')"
JOBTOK="$(pct exec "$CT_ID" -- grep ^JOB_TOKEN= /opt/hyperframes/.env | cut -d= -f2)"
echo
msg_ok "INSTALLATION FERTIG — Container $CT_ID ($CT_IP)"
echo "  Portal (Einstieg):  http://$CT_IP:$PORT_PORTAL/"
  echo "  Studio:             http://$CT_IP:$PORT_STUDIO_LAN/  (Vorschau + Nacharbeiten)"
echo "  Galerie:            http://$CT_IP:$PORT_GALLERY/  (admin / $GALPW)"
  echo "  Job-UI:             http://$CT_IP:$PORT_JOBS/     (Token: $JOBTOK)"
  if pct exec "$CT_ID" -- systemctl is-enabled omniroute.service >/dev/null 2>&1; then
    echo "  OmniRoute:          http://$CT_IP:$PORT_OMNI/v1"
  else
    echo "  OmniRoute:          nicht lokal installiert — Remote-Instanz in Job-UI unter Einstellungen verbinden"
  fi
echo "  OpenRouter-Key nachtragen: pct exec $CT_ID -- nano /opt/hyperframes/.env → systemctl restart hf-jobs"
  echo "  Update:  pct exec $CT_ID -- bash -c \"\$(wget -qLO - $REPO_RAW/install/update.sh)\""
echo "  Entfernen: pct stop $CT_ID && pct destroy $CT_ID"
echo "  Voll-Log: $LOG"
