#!/usr/bin/env bash
# Register the installed native MCP server. No repository runtime or extra daemon needed.
set -euo pipefail
tern_binary="${TERN_BINARY:-$HOME/.local/bin/tern}"
if [[ ! -x "$tern_binary" ]]; then
  echo "Install Tern first with ./scripts/install.sh" >&2
  exit 1
fi
"$tern_binary" --version
command -v codex >/dev/null || { echo "Install the Codex CLI before registering the MCP server." >&2; exit 1; }
codex mcp add tern -- "$tern_binary" --mcp
echo "Registered Tern. Start a new Codex session to discover its tools."
