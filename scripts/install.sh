#!/usr/bin/env bash
# Builds Tern in release mode and installs it for the current user (Omarchy/Walker picks it up).
set -euo pipefail
cd "$(dirname "$0")/.."

bun install --frozen-lockfile
bun tauri build --no-bundle

install -Dm755 src-tauri/target/release/tern "$HOME/.local/bin/tern"
install -Dm644 src-tauri/icons/icon.png "$HOME/.local/share/icons/hicolor/512x512/apps/tern.png"
install -Dm644 /dev/stdin "$HOME/.local/share/applications/tern.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Tern
GenericName=Mail
Comment=AI-native mail for Omarchy
Exec=$HOME/.local/bin/tern %u
Icon=tern
Terminal=false
Categories=Network;Email;Office;
MimeType=x-scheme-handler/mailto;
Keywords=mail;email;outlook;microsoft;365;
StartupWMClass=tern
DESKTOP

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "Installed. Launch Tern from the app launcher (Super+Space) or run: tern"
