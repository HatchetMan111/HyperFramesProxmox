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
# Ports im Container (Portal = Einstieg)
PORT_PORTAL=8080 PORT_STUDIO=3100 PORT_GALLERY=3101 PORT_JOBS=3120 PORT_OMNI=20128
# ===============================================================

LOG="/tmp/${APP}-install.log"
exec > >(tee -a "$LOG") 2>&1

YW="\033[33m"; GN="\033[1;92m"; RD="\033[01;31m"; CL="\033[m]"
msg_info()  { echo -e "${YW}▶ $*${CL}"; }
msg_ok()    { echo -e "${GN}✔ $*${CL}"; }
msg_error() { echo -e "${RD}✘ $*${CL}"; }

# Komplette Fehlerkette bei Abbruch: Befehl, Exit-Code, Log-Auszug, Journal-Hinweis
# shellcheck disable=SC2154  # ec wird im trap zugewiesen
trap 'ec=$?; msg_error "Abbruch (Exit $ec) beim Befehl: $BASH_COMMAND";
  echo "--- letzte 30 Logzeilen ($LOG) ---"; tail -n 30 "$LOG" 2>/dev/null || true;
  echo "--- Tipp: erneut mit DEBUG=1 starten: DEBUG=1 bash -x $0 ---";
  echo "--- CT-Logs: pct exec $CT_ID -- journalctl -n 50 ---";
  exit $ec' ERR

[ "$(id -u)" = "0" ] || { msg_error "Als root auf dem Proxmox-Host ausführen."; exit 1; }
command -v pct >/dev/null || { msg_error "pct nicht gefunden — Proxmox-Host nötig."; exit 1; }

# ---------- Idempotenz: existierende CT-ID niemals überschreiben ----------
if pct status "$CT_ID" >/dev/null 2>&1; then
  msg_error "Container $CT_ID existiert bereits — Abbruch (kein Überschreiben)."
  echo "  Entfernen mit: pct stop $CT_ID && pct destroy $CT_ID"
  echo "  Oder andere ID wählen: CT_ID=211 bash -c \"\$(wget -qLO - $REPO_RAW/install/hyperframes-suite.sh)\""
  exit 1
fi

# ---------- Template sicherstellen ----------
msg_info "Debian-12-Template prüfen"
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

# Auf Netzwerk im CT warten (max. 90 s)
msg_info "Warte auf CT-Netzwerk"
for i in $(seq 1 45); do
  pct exec "$CT_ID" -- true 2>/dev/null && break
  sleep 2
  [ "$i" = "45" ] && { msg_error "CT antwortet nicht."; exit 1; }
done
sleep 5
CT_IP="$(pct exec "$CT_ID" -- hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$CT_IP" ] || { msg_error "Keine CT-IP ermittelbar."; exit 1; }
msg_ok "CT-IP: $CT_IP"

# ---------- Setup im Container (alles aus GitHub, nichts fest verdrahtet) ----------
msg_info "Installiere App im Container (ca. 10–15 Min.)"
pct exec "$CT_ID" -- env REPO_RAW="$REPO_RAW" \
  PORT_PORTAL="$PORT_PORTAL" PORT_GALLERY="$PORT_GALLERY" PORT_JOBS="$PORT_JOBS" PORT_OMNI="$PORT_OMNI" \
  bash -s <<'CTEOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive PATH="/usr/local/bin:$PATH"
echo "==> [CT] Basis"
apt-get update && apt-get install -y curl git ffmpeg python3 socat ufw ca-certificates gnupg openssl sudo locales iproute2
sed -i 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
echo "==> [CT] Node.js 22"
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
apt-get update && apt-get install -y nodejs
node --version
echo "==> [CT] hyperframes + omniroute"
npm install -g hyperframes omniroute
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
[ -f "$BASE/.env" ] || { cp "$BASE/env.example" "$BASE/.env"; sed -i "s/^JOB_TOKEN=.*/JOB_TOKEN=$(openssl rand -hex 16)/" "$BASE/.env"; }
chmod 600 "$BASE/.env"; chown -R hyperframes:hyperframes "$BASE" "$HDIR"
echo "==> [CT] Chrome + Doctor"
sudo -u hyperframes hyperframes browser ensure 2>&1 | tail -n 2
df -h /dev/shm
sudo -u hyperframes hyperframes doctor 2>&1 | tail -n 15 || true
echo "==> [CT] Studio-Starterprojekt"
(cd "$BASE/projects" && sudo -u hyperframes HYPERFRAMES_SKIP_SKILLS=1 hyperframes init studio-home --example blank --non-interactive >/dev/null 2>&1 || true)
cp -r "$BASE/projects/studio-home/." "$BASE/studio-home/" 2>/dev/null || true
chown -R hyperframes:hyperframes "$BASE/studio-home"
echo "==> [CT] Dienste aktivieren"
cp "$BASE/systemd/"*.service "$BASE/systemd/"*.target /etc/systemd/system/
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
LAN=$(ip -o -f inet addr show eth0 | awk '{print $4}' | sed 's|\.[0-9]*/| .0/|' | tr -d ' ')
for p in "$PORT_PORTAL" 3100 "$PORT_GALLERY" "$PORT_JOBS" "$PORT_OMNI"; do ufw allow from "$LAN" to any port "$p" proto tcp >/dev/null; done
echo "[CT] FERTIG"
CTEOF
msg_ok "App-Installation im Container abgeschlossen"

# ---------- Verifikation vom Host ----------
msg_info "Verifiziere Dienste + Web UIs"
for svc in hf-studio hf-gallery omniroute hf-jobs hf-portal; do
  st="$(pct exec "$CT_ID" -- systemctl is-active "$svc" 2>/dev/null || echo failed)"
  [ "$st" = "active" ] || { msg_error "Service $svc: $st"; pct exec "$CT_ID" -- journalctl -u "$svc" -n 20 --no-pager || true; exit 1; }
  msg_ok "Service $svc aktiv"
done
for p in "$PORT_PORTAL" "$PORT_STUDIO" "$PORT_GALLERY" "$PORT_JOBS"; do :; done
for p in "$PORT_PORTAL" "$PORT_GALLERY" "$PORT_JOBS"; do
  code="$(pct exec "$CT_ID" -- curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/" || echo 000)"
  [ "$code" = "200" ] || { msg_error "Port $p antwortet mit HTTP $code"; exit 1; }
  msg_ok "Web UI :$p → HTTP $code"
done
# OmniRoute-Health (darf ohne Keys leere Modellauswahl melden, muss aber antworten)
pct exec "$CT_ID" -- curl -s -o /dev/null "http://127.0.0.1:$PORT_OMNI/v1/models" \
  && msg_ok "OmniRoute antwortet" || msg_info "OmniRoute noch im Start (gleich erneut prüfen)"

GALPW="$(pct exec "$CT_ID" -- cat /opt/hyperframes/gallery-pass.txt 2>/dev/null || echo '?')"
JOBTOK="$(pct exec "$CT_ID" -- grep ^JOB_TOKEN= /opt/hyperframes/.env | cut -d= -f2)"
echo
msg_ok "INSTALLATION FERTIG — Container $CT_ID ($CT_IP)"
echo "  Portal (Einstieg):  http://$CT_IP:$PORT_PORTAL/"
echo "  Studio:             http://$CT_IP:$PORT_STUDIO/  (Vorschau + Nacharbeiten)"
echo "  Galerie:            http://$CT_IP:$PORT_GALLERY/  (admin / $GALPW)"
echo "  Job-UI:             http://$CT_IP:$PORT_JOBS/     (Token: $JOBTOK)"
echo "  OmniRoute:          http://$CT_IP:$PORT_OMNI/v1"
echo "  OpenRouter-Key nachtragen: pct exec $CT_ID -- nano /opt/hyperframes/.env → systemctl restart hf-jobs"
echo "  Update:  pct exec $CT_ID -- bash -c \"\$(wget -qLO - $REPO_RAW/install/update.sh)\"  (folgt)"
echo "  Entfernen: pct stop $CT_ID && pct destroy $CT_ID"
echo "  Voll-Log: $LOG"
