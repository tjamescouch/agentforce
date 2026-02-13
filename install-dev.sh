#!/bin/bash
# Install agentchat-dashboard dev commands into ~/bin
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/bin"
TARGET="$HOME/bin"

mkdir -p "$TARGET"

# Symlink each command
for cmd in startsync prs next restart-dashboard restart-back-end; do
  chmod +x "$BIN/$cmd"
  ln -sf "$BIN/$cmd" "$TARGET/$cmd"
  echo "  $cmd -> $BIN/$cmd"
done

# Create .env if missing
if [ ! -f "$DIR/server/.env" ]; then
  echo "AGENTCHAT_PUBLIC=true" > "$DIR/server/.env"
  echo "  created server/.env"
fi

# Check PATH
if [[ ":$PATH:" != *":$TARGET:"* ]]; then
  echo ""
  echo "Add ~/bin to your PATH:"
  echo '  export PATH="$HOME/bin:$PATH"'
fi

echo ""
echo "Done. Commands: startsync, prs, next, restart-dashboard, restart-back-end"
