/**
 * LinkedIn Job Alert Agent — Main Entry Point
 * ============================================
 * Orchestrates: scraping → dedup → AI analysis → notifications
 * Runs on a cron schedule defined in config.
 */

require("dotenv").config();
const cron = require("node-cron");

const config = require("../config/config");
const LinkedInScraper = require("./scraper");
const PostAnalyzer = require("./analyzer");
const NotificationService = require("./notifier");
const SeenPostsStore = require("./store");
const logger = require("./logger");

// ─── CREDENTIALS ──────────────────────────────────────────────────────────────
const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL;
const LINKEDIN_PASSWORD = process.env.LINKEDIN_PASSWORD;
const COOKIE_PATH = `${__dirname}/../logs/linkedin_cookies.json`;

// ─── SERVICES ─────────────────────────────────────────────────────────────────
const analyzer = new PostAnalyzer(config);
const notifier = new NotificationService(config);
const store = new SeenPostsStore();

// ─── CORE SCAN FUNCTION ───────────────────────────────────────────────────────
async function runScan() {
  const startTime = Date.now();
  store.startRun(); // create a fresh timestamped log file for this scan
  logger.info("═══════════════════════════════════════════════════");
  logger.info("🔍 Starting LinkedIn feed scan...");
  logger.info(`   Companies : ${config.companies.join(", ")}`);
  logger.info(`   Roles     : ${config.roles.join(", ")}`);
  logger.info(`   Locations : ${config.locations.join(", ")}`);
  logger.info("═══════════════════════════════════════════════════");

  const scraper = new LinkedInScraper(config);

  try {
    await scraper.init();

    if (!LINKEDIN_EMAIL || !LINKEDIN_PASSWORD) {
      throw new Error("LINKEDIN_EMAIL and LINKEDIN_PASSWORD must be set in .env");
    }

    // Try loading saved cookies first (avoids repeated logins)
    const cookiesLoaded = await scraper.loadCookies(COOKIE_PATH);
    let loggedIn = false;

    if (cookiesLoaded) {
      // Verify the cookies are still valid by navigating to the feed
      await scraper.page.goto(scraper.platformConfig.feedUrl, {
        waitUntil: "domcontentloaded",
        timeout: scraper.config.browser.timeout,
      });
      loggedIn = await scraper.isLoggedIn();
      if (!loggedIn) {
        logger.info("🍪 Saved cookies have expired — logging in fresh...");
      }
    }

    if (!loggedIn) {
      await scraper.login({ email: LINKEDIN_EMAIL, password: LINKEDIN_PASSWORD });
      await scraper.saveCookies(COOKIE_PATH);
    }

    // 1. Scrape feed
    const allPosts = await scraper.scrapeFeed();

    // 2. Deduplicate
    const newPosts = store.filterNew(allPosts);

    // 3. AI analysis
    const matches = await analyzer.filterPosts(newPosts);

    // 4. Mark all new posts as seen (even non-matches, to avoid re-analyzing)
    newPosts.forEach((p) => store.markSeen(p));

    // 5. Send notifications
    await notifier.sendAlerts(matches);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`✅ Scan complete in ${elapsed}s. Next run: ${config.scanSchedule}`);
  } catch (err) {
    logger.error(`❌ Scan failed: ${err.message}`, err);
  } finally {
    await scraper.close();
  }
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function start() {
  logger.info("🤖 LinkedIn Job Alert Agent starting...");
  logger.info(`⏰ Schedule: ${config.scanSchedule}`);

  // Run once immediately on startup
  await runScan();

  // Then run on cron schedule
  cron.schedule(config.scanSchedule, async () => {
    await runScan();
  });

  logger.info("🟢 Agent is running. Press Ctrl+C to stop.");
}

// Allow running a single scan manually: node src/agent.js --once
if (process.argv.includes("--once")) {
  runScan().then(() => process.exit(0)).catch((e) => {
    logger.error(e);
    process.exit(1);
  });
} else {
  start().catch((e) => {
    logger.error(e);
    process.exit(1);
  });
}
