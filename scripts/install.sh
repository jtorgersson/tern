#!/usr/bin/env bash
# Builds Tern in release mode and installs it for the current user (Omarchy/Walker picks it up).
set -euo pipefail
cd "$(dirname "$0")/.."

register_mcp=false
case "${1:-}" in
  "") ;;
  --register-mcp) register_mcp=true ;;
  *) echo "Usage: $0 [--register-mcp]" >&2; exit 2 ;;
esac
if (( $# > 1 )); then echo "Usage: $0 [--register-mcp]" >&2; exit 2; fi

bun install --frozen-lockfile
bun tauri build --no-bundle

mkdir -p "$HOME/.local/bin"
# Atomic replacement also works while the previous executable is running.
tern_install_tmp=$(mktemp "$HOME/.local/bin/.tern-install.XXXXXX")
trap 'rm -f "$tern_install_tmp"' EXIT
install -m755 src-tauri/target/release/tern "$tern_install_tmp"
mv -f "$tern_install_tmp" "$HOME/.local/bin/tern"
install -Dm644 src-tauri/icons/icon.png "$HOME/.local/share/icons/hicolor/512x512/apps/tern.png"
install -Dm644 /dev/stdin "$HOME/.local/share/applications/tern.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Tern
GenericName=Mail
Comment=Mail, calendar, and conversations
Exec=$HOME/.local/bin/tern %u
Icon=tern
Terminal=false
Categories=Network;Email;Office;
MimeType=x-scheme-handler/mailto;
Keywords=mail;email;calendar;chat;teams;outlook;microsoft;365;
StartupWMClass=tern
DESKTOP

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "Installed. Launch Tern from the app launcher (Super+Space) or run: tern"
if "$register_mcp"; then ./scripts/register-mcp.sh; fi
