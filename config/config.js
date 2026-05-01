/**
 * LinkedIn Job Alert Agent - Configuration
 * =========================================
 * All settings are defined here. Add/remove companies, roles,
 * locations, and platforms without touching any agent logic.
 */

module.exports = {
  // ─── SCAN SCHEDULE ───────────────────────────────────────────────────────────
  // Cron expression: "0 */3 * * *" = every 3 hours
  // Examples:
  //   Every 15 min : "*/15 * * * *"
  //   Every hour   : "0 * * * *"
  //   Every 6 hours: "0 */6 * * *"
  //   Once a day   : "0 9 * * *"
  scanSchedule: "0 */3 * * *",

  // ─── TARGET COMPANIES ────────────────────────────────────────────────────────
  // Add any company name exactly as it appears on LinkedIn profiles.
  companies: [
    "all",
    // "Airbnb",
    // "Confluent",
    // "Zoom",
    // "GitLab",
    // "Indeed",
  ],

  // ─── TARGET ROLES ────────────────────────────────────────────────────────────
  // Keywords the AI will look for in post content.
  // Partial matches work — "Senior Software Engineer" also matches "Sr. SWE".
  roles: [
    "Senior Software Engineer",
    "AI Engineer",
    "Senior Backend Engineer",
    // "Staff Software Engineer",      // easy to add more
    // "Engineering Manager",
    // "Product Manager",
  ],

  // ─── PREFERRED LOCATIONS ─────────────────────────────────────────────────────
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
      // Setup (one-time, 2 minutes):
      //   1. Message @BotFather on Telegram → /newbot → copy the token
      //   2. Start a chat with your new bot, then visit:
      //      https://api.telegram.org/bot<TOKEN>/getUpdates
      //      and copy the "id" value from the "chat" object — that's your chat ID.
      //   3. Add to .env:
      //        TELEGRAM_BOT_TOKEN=123456:ABC-...
      //        TELEGRAM_CHAT_ID=987654321
      chatId: "838942055",  // fallback if TELEGRAM_CHAT_ID env var is not set
    },
    // slack: { enabled: false, webhookUrl: "https://hooks.slack.com/..." },
    // email: { enabled: false, ... },
  },

  // ─── OLLAMA (local LLM classification) ───────────────────────────────────────
  // Requires Ollama running locally: https://ollama.com
  // Setup: ollama pull qwen3:8b
  ollama: {
    host:  "http://localhost:11434",
    model: "qwen3:8b",
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
