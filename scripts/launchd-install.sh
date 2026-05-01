#!/bin/bash
# Installs the job-search agent as a macOS launchd user agent.
# Runs every 30 minutes while the Mac is awake (skips while asleep).
# Uses --once mode so launchd owns the schedule, not node-cron.

set -e

PLIST_LABEL="com.jobsearchagent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_PATH="$(which node 2>/dev/null || true)"

# ── Preflight checks ────────────────────────────────────────────────────────
if [ -z "$NODE_PATH" ]; then
  echo "❌  node not found in PATH."
  echo "    If you use nvm, run:  nvm use  (or open a new shell) then re-run this script."
  exit 1
fi

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "❌  .env file not found at $PROJECT_DIR/.env"
  echo "    Copy .env.example to .env and fill in your credentials first."
  exit 1
fi

NODE_DIR="$(dirname "$NODE_PATH")"
mkdir -p "$PROJECT_DIR/logs"

# launchd's stdout/stderr files must live outside TCC-protected folders
# (Desktop/Documents/Downloads/iCloud) — otherwise xpcproxy can't open them
# for writing and the spawn fails with EX_CONFIG (78) before any code runs.
LAUNCHD_LOG_DIR="$HOME/Library/Logs/${PLIST_LABEL}"
mkdir -p "$LAUNCHD_LOG_DIR"

echo "📍 Project : $PROJECT_DIR"
echo "📍 Node    : $NODE_PATH"
echo "📍 Logs    : $LAUNCHD_LOG_DIR"

# ── Write the plist ─────────────────────────────────────────────────────────
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>

  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <!-- Run: node src/agent.js --once -->
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${PROJECT_DIR}/src/agent.js</string>
    <string>--once</string>
  </array>

  <!-- Working directory so dotenv finds .env and relative log paths work -->
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <!-- Every 30 minutes (1800 seconds) -->
  <key>StartInterval</key>
  <integer>1800</integer>

  <!-- Run one scan immediately on load -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Stdout / stderr go to ~/Library/Logs/com.jobsearchagent/ — outside the
       TCC-protected Desktop folder so launchd can actually open them. -->
  <key>StandardOutPath</key>
  <string>${LAUNCHD_LOG_DIR}/launchd.log</string>

  <key>StandardErrorPath</key>
  <string>${LAUNCHD_LOG_DIR}/launchd-error.log</string>

  <!-- Expose the node binary directory so any child processes can find it -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_DIR}:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>

</dict>
</plist>
PLIST

echo "✅ Plist written → $PLIST_PATH"

# ── Load (unload first if already registered) ────────────────────────────────
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo ""
echo "✅ Agent loaded into launchd."
echo "   • Runs every 30 min while the Mac is awake"
echo "   • First scan starting now (RunAtLoad = true)"
echo "   • Logs → $LAUNCHD_LOG_DIR/{launchd.log,launchd-error.log}"
echo ""
echo "Useful commands:"
echo "  Check status : launchctl list | grep jobsearchagent"
echo "  Stop         : npm run launchd:uninstall"
echo "  Restart      : npm run launchd:uninstall && npm run launchd:install"
