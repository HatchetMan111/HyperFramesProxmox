# Hyperframes-Suite für Proxmox

Lokale Video-Werkstatt im LXC: **Hyperframes** (HTML → MP4, 100 % lokal) mit
Web-Oberflächen für Vorschau, Nacharbeiten, Render-Galerie und KI-gestützte
Entwürfe — **OpenRouter und OmniRoute pro Auftrag anklickbar**.
Rendern braucht keine KI und kein Internet; KI wird nur zur Inhaltserzeugung
(Texte, Storyboards, HTML, Bilder, Sprecher) zugeschaltet.

## Installation (Einzeiler auf dem Proxmox-Host, als root)

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/HyperFramesProxmox/main/install/hyperframes-suite.sh)"
```

Das Script erstellt einen LXC (Debian 12, unprivilegiert, `onboot: 1`) und
installiert alles darin — **nichts auf dem Host außer dem Container**.
Am Ende gibt es die URLs + Logins aus. Bei Fehlern: komplette Fehlerkette im
Log, neu starten mit `DEBUG=1` für `bash -x`-Details (siehe Script-Kopf).

Anpassungen per Umgebungsvariablen, z. B.:

```bash
CT_ID=211 CT_CPU=4 CT_RAM=8192 CT_DISK=50 IP_CIDR="192.168.178.60/24" CT_GW="192.168.178.1" \
bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/HyperFramesProxmox/main/install/hyperframes-suite.sh)"
```

| Variable | Standard | Bedeutung |
|---|---|---|
| `CT_ID` | nächste freie | Container-ID (existierende ID → Abbruch, kein Überschreiben) |
| `CT_CPU` / `CT_RAM` / `CT_DISK` | `2` / `4096` / `20` | Ressourcen (Rendern mag `4` / `8192`) |
| `CT_STORAGE` | `local-lvm` | Disk-Storage |
| `IP_CIDR` / `CT_GW` | `dhcp` | statisch z. B. `"192.168.178.60/24"` + GW |

## Web UIs (nach Installation, `CT-IP` aus der Ausgabe)

| Dienst | URL | Wofür |
|---|---|---|
| Portal | `http://CT-IP:8080/` | Einstieg mit Links |
| Job-UI | `http://CT-IP:3120/` | Prompt → Video (Token aus `/opt/hyperframes/.env`) |
| Studio | `http://CT-IP:3100/` | Vorschau + Nacharbeiten |
| Galerie | `http://CT-IP:3101/` | MP4 laden (admin-Pass aus Ausgabe) |
| OmniRoute | `http://CT-IP:20128/v1` | lokales KI-Gateway (Free-Tiers, OpenAI-kompatibel) |

OpenRouter-Key nachtragen (optional):
`pct exec CT-ID -- nano /opt/hyperframes/.env` → `systemctl restart hf-jobs`.

## Update

```bash
CT_ID=210  # deine ID
pct exec $CT_ID -- npm update -g hyperframes omniroute
pct exec $CT_ID -- systemctl restart hyperframes-suite.target
```

## Deinstallation

```bash
pct stop 210 && pct destroy 210   # ID anpassen
```

## Testprotokoll (nach Installation abhaken)

- [ ] `pct exec 210 -- systemctl is-active hf-studio hf-gallery omniroute hf-jobs hf-portal` → 5× `active`
- [ ] Alle 5 URLs aus dem Heimnetz erreichbar (Portal klickbar)
- [ ] Job-UI: Testauftrag mit OmniRoute → Entwurf + Snapshots sichtbar
- [ ] Reboot: `pct reboot 210`, 2 Min. warten → alle URLs wieder grün
- [ ] Proxmox-Backup-Job für den CT angelegt
