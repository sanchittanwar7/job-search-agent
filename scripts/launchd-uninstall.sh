#!/bin/bash
# Stops and removes the job-search launchd agent.

PLIST_LABEL="com.jobsearchagent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

if [ ! -f "$PLIST_PATH" ]; then
  echo "ℹ️  Plist not found at $PLIST_PATH — nothing to remove."
  exit 0
fi

launchctl unload "$PLIST_PATH" 2>/dev/null && echo "✅ Agent stopped." || echo "ℹ️  Agent was not running."
rm -f "$PLIST_PATH" && echo "✅ Plist removed."
