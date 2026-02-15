#!/bin/bash
# Remove agentchat-dashboard dev commands from ~/bin
TARGET="$HOME/bin"

for cmd in startsync prs next restart-dashboard restart-back-end; do
  if [ -L "$TARGET/$cmd" ]; then
    rm "$TARGET/$cmd"
    echo "  removed $cmd"
  fi
done

echo "Done."
