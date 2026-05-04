/**
 * LinkedIn Job Alert Agent - Configuration (TEMPLATE)
 * ====================================================
 * 1. Copy this file to `config/config.js`:
 *      cp config/config.example.js config/config.js
 * 2. Edit `config.js` to match your job search criteria.
 * 3. `config.js` is gitignored — your personal targets and chat ID stay local.
 *
 * All settings are defined here. Add/remove companies, roles, locations,
 * and platforms without touching any agent logic.
 */

module.exports = {
  // ─── SCAN SCHEDULE ───────────────────────────────────────────────────────────
  // Cron expression. Used by `npm start` (continuous mode) only — the launchd
  // installer ignores this and uses its own 30-minute interval.
  // Examples:
  //   Every 15 min : "*/15 * * * *"
  //   Every hour   : "0 * * * *"
  //   Every 3 hours: "0 */3 * * *"   ← default
  //   Every 6 hours: "0 */6 * * *"
  //   Once a day   : "0 9 * * *"
  scanSchedule: "0 */3 * * *",

  // ─── TARGET COMPANIES ────────────────────────────────────────────────────────
  // Add company names exactly as they appear on LinkedIn profiles.
  // Use ["all"] to match any company.
  companies: [
    "all",
    // "Airbnb",
    // "Confluent",
    // "Zoom",
    // "GitLab",
    // "Indeed",
  ],

  // ─── TARGET ROLES ────────────────────────────────────────────────────────────
  // Job titles you're looking for. Partial matches work — "Senior Software
  // Engineer" also matches "Sr. SWE". Use ["all"] to match any engineering role.
  roles: [
    "Senior Software Engineer",
    "AI Engineer",
    "Senior Backend Engineer",
    // "Staff Software Engineer",
    // "Engineering Manager",
  ],

  // ─── PREFERRED LOCATIONS ─────────────────────────────────────────────────────
  // Use ["all"] to match any location.
  locations: [
    "Remote",
    "India",
    "Remote India",
    "Work from home",
    "Bangalore",
    "Hyderabad",
    "Gurgaon",
    "Gurugram",
    "Noida",
  ],

  // ─── POSTER SENIORITY FILTER ─────────────────────────────────────────────────
  // Only alert if the person who posted holds one of these title keywords.
  // Leave empty [] to get alerts from anyone at the target companies.
  posterTitles: [],

  // ─── PLATFORMS ───────────────────────────────────────────────────────────────
  // Each platform defines its own scraper. Add new platforms here.
  platforms: {
    linkedin: {
      enabled: true,
      feedUrl: "https://www.linkedin.com/feed/",
      loginUrl: "https://www.linkedin.com/login",
      scrollDepth: 100,          // how many times to scroll to load more posts
      postSelector: ".feed-shared-update-v2",
      maxPostsPerScan: 200,
    },
    // twitter: { enabled: false, ... },  // future platform
  },

  // ─── NOTIFICATION CHANNELS ───────────────────────────────────────────────────
  notifications: {
    telegram: {
      enabled: true,
      // Setup (one-time, ~2 minutes):
      //   1. Message @BotFather on Telegram → /newbot → copy the token
      //   2. Start a chat with your new bot, then visit:
      //      https://api.telegram.org/bot<TOKEN>/getUpdates
      //      and copy the "id" value from the "chat" object — that's your chat ID.
      //   3. Add to .env:
      //        TELEGRAM_BOT_TOKEN=123456:ABC-...
      //        TELEGRAM_CHAT_ID=987654321
      // The chatId below is only used as a fallback if TELEGRAM_CHAT_ID is unset.
      chatId: "YOUR_TELEGRAM_CHAT_ID",
    },
    // slack: { enabled: false, webhookUrl: "https://hooks.slack.com/..." },
    // email: { enabled: false, ... },
  },

  // ─── OLLAMA (local LLM classification) ───────────────────────────────────────
  // Requires Ollama running locally: https://ollama.com
  // Setup: ollama pull qwen3:8b   (or qwen3:4b / qwen3:1.7b for lighter machines)
  ollama: {
    host:       "http://localhost:11434",
    model:      "qwen3:8b",
    timeoutMs:  60000,   // ms to wait for a single Ollama response (default 60s)
    maxRetries: 3,       // retry attempts on timeout/connection errors before giving up
  },

  // ─── BROWSER / PUPPETEER ─────────────────────────────────────────────────────
  browser: {
    headless: true,           // set false to watch the browser while debugging
    slowMo: 50,               // ms between actions (helps avoid bot detection)
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    timeout: 30000,
  },
};
