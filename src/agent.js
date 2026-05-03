/**
 * LinkedIn Job Alert Agent — Main Entry Point
 * ============================================
 * Orchestrates: scraping → dedup → AI analysis → notifications
 * Runs on a cron schedule defined in config.
 */

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const cron = require("node-cron");

const config = require("../config/config");
const LinkedInScraper = require("./linkedin_scraper");
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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildLevelsUrl(analysis) {
  const company = analysis.company || null;
  if (!company) return null;
  const params = new URLSearchParams({ search: company, sinceDate: "year" });
  return `https://www.levels.fyi/t/software-engineer/locations/india?${params}`;
}

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

    // 5. Attach levels.fyi link for each match
    for (const match of matches) {
      match.levelsUrl = buildLevelsUrl(match.analysis);
    }

    // 6. Send notifications
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

// ─── REPLAY ───────────────────────────────────────────────────────────────────
// Re-runs Ollama analysis + levels.fyi enrichment on saved post log files.
// Usage:
//   npm run replay                                   ← most recent log file
//   npm run replay:all                               ← all log files, deduped
//   npm run replay -- --replay=logs/posts/posts_log_2026-05-02_10-00-00.json
async function runReplay({ filePath = null, all = false } = {}) {
  const POSTS_DIR = path.join(__dirname, "../logs/posts");

  // ── Resolve which files to process ────────────────────────────────────────
  let targetFiles;
  if (filePath) {
    targetFiles = [path.resolve(filePath)];
  } else {
    const found = fs.readdirSync(POSTS_DIR)
      .filter((f) => /^posts_log_.*\.json$/.test(f))
      .sort()
      .reverse(); // newest first
    if (!found.length) {
      throw new Error(`No posts_log_*.json files found in ${POSTS_DIR}. Run a scan first.`);
    }
    targetFiles = all
      ? found.map((f) => path.join(POSTS_DIR, f))
      : [path.join(POSTS_DIR, found[0])];
  }

  logger.info("═══════════════════════════════════════════════════");
  logger.info(
    all
      ? `🔄 Replay mode (all) — ${targetFiles.length} log file(s)`
      : `🔄 Replay mode — ${path.basename(targetFiles[0])}`
  );
  logger.info("═══════════════════════════════════════════════════");

  // ── Load posts, deduplicating across files by stored fingerprint ───────────
  const seenFingerprints = new Set();
  const posts = [];
  for (const f of targetFiles) {
    logger.info(`  📂 ${path.basename(f)}`);
    const entries = JSON.parse(fs.readFileSync(f, "utf-8"));
    for (const entry of entries) {
      if (!seenFingerprints.has(entry.fingerprint)) {
        seenFingerprints.add(entry.fingerprint);
        posts.push({
          text:        entry.text,
          authorName:  entry.authorName,
          authorTitle: entry.authorTitle,
          postUrl:     entry.postUrl,
          timestamp:   entry.timestamp,
        });
      }
    }
  }
  logger.info(
    `📦 ${posts.length} unique post(s) loaded` +
    (targetFiles.length > 1 ? ` (deduped across ${targetFiles.length} files)` : "")
  );

  // ── Stage 1 + 2: regex gate → Ollama classification ───────────────────────
  const matches = await analyzer.filterPosts(posts);

  if (matches.length === 0) {
    logger.info("🔕 No matches found in replay — no notifications sent.");
    return;
  }

  // ── Stage 3: attach levels.fyi link ──────────────────────────────────────
  for (const match of matches) {
    match.levelsUrl = buildLevelsUrl(match.analysis);
  }

  // ── Stage 4: send alerts ───────────────────────────────────────────────────
  await notifier.sendAlerts(matches);
}

// ─── ENTRYPOINT ───────────────────────────────────────────────────────────────
const replayArg = process.argv.find((a) => a === "--replay" || a.startsWith("--replay="));
const allFlag   = process.argv.includes("--all");

if (replayArg) {
  const filePath = replayArg.includes("=") ? replayArg.split("=")[1] : null;
  runReplay({ filePath, all: allFlag }).then(() => process.exit(0)).catch((e) => {
    logger.error(e);
    process.exit(1);
  });
} else if (process.argv.includes("--once")) {
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
