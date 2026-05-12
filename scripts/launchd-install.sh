#!/bin/bash
# Installs the job-search agent as a macOS launchd user agent.
# Reads the scan schedule from config/config.js (scanSchedule cron expression)
# and converts it to the appropriate launchd StartCalendarInterval / StartInterval.
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

# ── Read schedule from config ────────────────────────────────────────────────
SCHEDULE=$(node -e "console.log(require('${PROJECT_DIR}/config/config.js').scanSchedule)" 2>/dev/null || echo "0 */3 * * *")
echo "📍 Schedule: $SCHEDULE (from config/config.js)"

# Parse cron: minute hour day-of-month month day-of-week
IFS=' ' read -r CRON_MIN CRON_HOUR CRON_DOM CRON_MON CRON_DOW <<< "$SCHEDULE"

# ── Convert cron to launchd schedule XML ─────────────────────────────────────
generate_schedule_xml() {
  local min="$1" hour="$2"

  # Case 1: */N minutes → enumerate minute entries (coalesces on sleep)
  if [[ "$min" =~ ^\*/([0-9]+)$ ]]; then
    local step="${BASH_REMATCH[1]}"
    cat << XML
  <!-- Every ${step} minutes (from config) -->
  <key>StartCalendarInterval</key>
  <array>
XML
    for ((m=0; m<60; m+=step)); do
      cat << XML
    <dict>
      <key>Minute</key><integer>${m}</integer>
    </dict>
XML
    done
    cat << XML
  </array>
XML
    return
  fi

  # Case 2: */N hours → enumerate hours at the given minute
  if [[ "$hour" =~ ^\*/([0-9]+)$ ]]; then
    local step="${BASH_REMATCH[1]}"
    cat << XML
  <!-- Every ${step} hours at minute ${min} (from config) -->
  <key>StartCalendarInterval</key>
  <array>
XML
    for ((h=0; h<24; h+=step)); do
      cat << XML
    <dict>
      <key>Minute</key><integer>${min}</integer>
      <key>Hour</key><integer>${h}</integer>
    </dict>
XML
    done
    cat << XML
  </array>
XML
    return
  fi

  # Case 3: Specific hour + minute → once daily
  if [[ "$hour" =~ ^[0-9]+$ ]] && [[ "$min" =~ ^[0-9]+$ ]]; then
    cat << XML
  <!-- Daily at ${hour}:${min} (from config) -->
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Minute</key><integer>${min}</integer>
      <key>Hour</key><integer>${hour}</integer>
    </dict>
  </array>
XML
    return
  fi

  # Case 4: Every hour at specific minute
  if [[ "$hour" == "*" ]] && [[ "$min" =~ ^[0-9]+$ ]]; then
    cat << XML
  <!-- Every hour at minute ${min} (from config) -->
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Minute</key><integer>${min}</integer>
    </dict>
  </array>
XML
    return
  fi

  # Fallback: every 3 hours at minute 0
  echo "  <!-- Could not parse cron '${min} ${hour}', falling back to every 3 hours -->"
  cat << XML
  <key>StartCalendarInterval</key>
  <array>
XML
  for ((h=0; h<24; h+=3)); do
    cat << XML
    <dict>
      <key>Minute</key><integer>0</integer>
      <key>Hour</key><integer>${h}</integer>
    </dict>
XML
  done
  cat << XML
  </array>
XML
}

SCHEDULE_XML=$(generate_schedule_xml "$CRON_MIN" "$CRON_HOUR")

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

${SCHEDULE_XML}

  <!-- Run one scan immediately on load (and on wake-from-sleep if a fire
       was missed, via StartCalendarInterval coalescing) -->
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
echo "   • Schedule: $SCHEDULE (from config/config.js)"
echo "   • Catches up after sleep/wake"
echo "   • First scan starting now (RunAtLoad = true)"
echo "   • Logs → $LAUNCHD_LOG_DIR/{launchd.log,launchd-error.log}"
echo ""
echo "Useful commands:"
echo "  Check status : launchctl list | grep jobsearchagent"
echo "  Stop         : npm run launchd:uninstall"
echo "  Restart      : npm run launchd:uninstall && npm run launchd:install"
