/**
 * LinkedIn Scraper
 * ================
 * Logs into LinkedIn and scrapes the feed for posts.
 * Uses Puppeteer for browser automation.
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const logger = require("./logger");

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LinkedInScraper {
  constructor(config) {
    this.config = config;
    this.platformConfig = config.platforms.linkedin;
    this.browser = null;
    this.page = null;
  }

  async init() {
    logger.info("🚀 Launching browser...");
    this.browser = await puppeteer.launch({
      headless: this.config.browser.headless,
      slowMo: this.config.browser.slowMo,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    });

    this.page = await this.browser.newPage();
    await this.page.setUserAgent(this.config.browser.userAgent);
    await this.page.setViewport(this.config.browser.viewport);

    // Remove webdriver flag to avoid bot detection
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  }

  async _screenshot(label) {
    try {
      const fs = require("fs");
      const dir = `${__dirname}/../logs`;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const path = `${dir}/screenshot-${label}.png`;
      await this.page.screenshot({ path, fullPage: true });
      logger.info(`📸 Screenshot saved → logs/screenshot-${label}.png`);
    } catch (e) {
      logger.warn(`Could not save screenshot: ${e.message}`);
    }
  }

  async isLoggedIn() {
    try {
      const url = this.page.url();
      if (url.includes("/feed") || url.includes("/in/")) return true;
      // Check for the global nav which only appears when logged in
      const navEl = await this.page.$(".global-nav__me, #global-nav");
      return !!navEl;
    } catch {
      return false;
    }
  }

  async login(credentials) {
    logger.info("🔐 Logging into LinkedIn...");

    await this.page.goto(this.platformConfig.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.browser.timeout,
    });

    // Brief pause for JS-driven redirects to settle
    await sleep(2000);

    // Check if already logged in (cookie session)
    const currentUrl = this.page.url();
    if (currentUrl.includes("/feed") || currentUrl.includes("/in/")) {
      logger.info("✅ Already logged in via session cookies.");
      return;
    }

    // Check if LinkedIn served a challenge/CAPTCHA instead of the login form
    if (
      currentUrl.includes("checkpoint") ||
      currentUrl.includes("challenge") ||
      currentUrl.includes("captcha")
    ) {
      await this._screenshot("challenge");
      logger.warn("⚠️  LinkedIn is showing a verification page. Manual action needed.");
      logger.warn("    → Set browser.headless: false in config/config.js to solve it.");
      logger.warn("    → Waiting 90 seconds for manual intervention...");
      await sleep(90000);
      return;
    }

    // LinkedIn has used several selectors for the email field over the years
    const usernameSelectors = [
      "#username",
      "input[name='session_key']",
      "input[autocomplete='username']",
      "input[type='email']",
    ];

    let usernameSelector = null;
    for (const sel of usernameSelectors) {
      const el = await this.page.$(sel);
      if (el) { usernameSelector = sel; break; }
    }

    if (!usernameSelector) {
      await this._screenshot("login-no-form");
      throw new Error(
        "LinkedIn login form not found — LinkedIn may be blocking the headless browser.\n" +
        "  → Set  browser.headless: false  in config/config.js and run again to debug visually.\n" +
        "  → Screenshot saved to logs/screenshot-login-no-form.png"
      );
    }

    await this.page.type(usernameSelector, credentials.email, { delay: 80 });
    await this.page.type("#password", credentials.password, { delay: 80 });

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      this.page.click('[type="submit"]'),
    ]);

    // Handle potential CAPTCHA or 2FA after submit
    const postLoginUrl = this.page.url();
    if (postLoginUrl.includes("checkpoint") || postLoginUrl.includes("challenge")) {
      await this._screenshot("post-login-challenge");
      logger.warn("⚠️  LinkedIn is asking for verification. Please solve it manually.");
      logger.warn("    → Set browser.headless: false in config/config.js to interact.");
      logger.warn("    Waiting 90 seconds for manual intervention...");
      await sleep(90000);
    }

    logger.info("✅ Login successful.");
  }

  async scrapeFeed() {
    logger.info("📜 Navigating to LinkedIn feed...");

    // If agent.js already navigated here for cookie validation, skip re-navigation
    const alreadyOnFeed = this.page.url().includes("/feed");
    if (!alreadyOnFeed) {
      await this.page.goto(this.platformConfig.feedUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.browser.timeout,
      });
    }

    // Guard: if we ended up on a login/challenge page, bail out clearly
    const feedUrl = this.page.url();
    if (feedUrl.includes("login") || feedUrl.includes("checkpoint") || feedUrl.includes("authwall")) {
      await this._screenshot("feed-redirected");
      throw new Error(
        "LinkedIn redirected away from the feed — session expired or bot detected.\n" +
        "  → Delete logs/linkedin_cookies.json and run again to force a fresh login.\n" +
        "  → Screenshot saved to logs/screenshot-feed-redirected.png"
      );
    }

    // Wait for the feed container (stable data-testid, not obfuscated classes)
    try {
      await this.page.waitForSelector('[data-testid="mainFeed"]', { timeout: 15000 });
    } catch {
      await this._screenshot("feed-no-content");
      logger.warn("⚠️  [data-testid=\"mainFeed\"] not found after 15s — saving debug screenshot.");
    }

    // Scroll to load more posts.
    // page.mouse.wheel fires a real wheel event — more reliably triggers
    // LinkedIn's infinite-scroll loader than window.scrollBy, and is
    // visually observable when running with headless: false.
    logger.info(`🔄 Scrolling feed (${this.platformConfig.scrollDepth} times)...`);
    const { width, height } = this.config.browser.viewport;
    await this.page.mouse.move(width / 2, height / 2); // centre the cursor first
    for (let i = 0; i < this.platformConfig.scrollDepth; i++) {
      await this.page.mouse.wheel({ deltaY: 1200 });
      await sleep(1500 + Math.random() * 1000); // human-like delay
    }

    // Extract posts
    // NOTE: LinkedIn uses obfuscated/hashed CSS classes that change on every deploy.
    //       All selectors here use stable data-testid / aria / role attributes instead.
    logger.info("🔍 Extracting posts...");
    const posts = await this.page.evaluate((maxPosts) => {
      const feedEl = document.querySelector('[data-testid="mainFeed"]');
      if (!feedEl) return [];

      // Each post is a role="listitem" whose componentkey contains "FeedType"
      const postEls = Array.from(
        feedEl.querySelectorAll('[role="listitem"][componentkey*="FeedType"]')
      );

      const results = [];

      postEls.forEach((el) => {
        try {
          // Skip sponsored / ad posts
          if (el.querySelector('[aria-label*="Hide or report this ad"]')) return;

          // ── Author name ──────────────────────────────────────────────────────
          // Reliably in the aria-label of the "Hide post by …" control button
          let authorName = "";
          const hideBtn = el.querySelector('button[aria-label^="Hide post by "]');
          if (hideBtn) {
            authorName = hideBtn.getAttribute("aria-label").replace("Hide post by ", "").trim();
          } else {
            const menuBtn = el.querySelector('button[aria-label^="Open control menu for post by "]');
            if (menuBtn) {
              authorName = menuBtn.getAttribute("aria-label")
                .replace("Open control menu for post by ", "").trim();
            }
          }

          // ── Author title / headline ──────────────────────────────────────────
          // No stable attribute exists; it is the first <p> sibling after the
          // author profile link that does NOT equal the author name.
          let authorTitle = "";
          const profileLink = el.querySelector('a[href*="linkedin.com/in/"]');
          if (profileLink) {
            // Walk up until we find a parent that has at least 2 <p> children
            let cursor = profileLink.parentElement;
            for (let i = 0; i < 5 && cursor; i++) {
              const paras = Array.from(cursor.querySelectorAll("p"));
              const candidate = paras.find(
                (p) => p.innerText.trim() && p.innerText.trim() !== authorName
              );
              if (candidate) { authorTitle = candidate.innerText.trim(); break; }
              cursor = cursor.parentElement;
            }
          }

          // ── Post text ────────────────────────────────────────────────────────
          // LinkedIn line-clamps long posts in the feed and appends a "…more"
          // toggle button. innerText would only return the clamped (visible)
          // portion, so we read textContent on a clone with the toggle button
          // stripped out — that gives us the full post regardless of CSS clip.
          // textContent flattens line breaks, so we manually inject \n for
          // <br> and block-level boundaries to preserve the author's formatting.
          let text = "";
          const textBox = el.querySelector('[data-testid="expandable-text-box"]');
          if (textBox) {
            const clone = textBox.cloneNode(true);
            clone.querySelectorAll("button").forEach((b) => b.remove());
            clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
            clone.querySelectorAll("p, div, li").forEach((b) => {
              b.append("\n");
            });
            text = clone.textContent
              .replace(/(…|\.{3,})\s*$/, "")
              .replace(/[ \t]+\n/g, "\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
          }

          // ── Post URL ─────────────────────────────────────────────────────────
          // LinkedIn feed HTML rarely contains direct post permalink anchors.
          let postUrl = "";
          const a = el.querySelector('a[href*="/posts/"], a[href*="/feed/update/"]');
          if (a) postUrl = a.href;

          // ── Timestamp ────────────────────────────────────────────────────────
          const timeEl = el.querySelector("time");
          const timestamp = timeEl
            ? timeEl.getAttribute("datetime") || timeEl.innerText.trim()
            : "";

          if (text && authorName) {
            results.push({ text, authorName, authorTitle, postUrl, timestamp });
          }
        } catch {
          // skip malformed post nodes
        }
      });

      return results.slice(0, maxPosts);
    }, this.config.platforms.linkedin.maxPostsPerScan);

    if (posts.length === 0) {
      const fs = require("fs");
      const dir = `${__dirname}/../logs`;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const html = await this.page.content();
      fs.writeFileSync(`${dir}/feed-debug.html`, html);
      await this._screenshot("feed-zero-posts");
      logger.warn("⚠️  0 posts extracted. Saved debug files to logs/:");
      logger.warn("    → feed-debug.html  (open in browser to inspect live selectors)");
      logger.warn("    → screenshot-feed-zero-posts.png  (what the page looked like)");
    }

    logger.info(`📦 Scraped ${posts.length} posts from LinkedIn feed.`);
    return posts;
  }

  async saveCookies(cookiePath) {
    const cookies = await this.page.cookies();
    const fs = require("fs");
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    logger.info(`🍪 Session cookies saved to ${cookiePath}`);
  }

  async loadCookies(cookiePath) {
    const fs = require("fs");
    if (!fs.existsSync(cookiePath)) return false;

    const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf-8"));
    await this.page.setCookie(...cookies);
    logger.info("🍪 Session cookies loaded.");
    return true;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = LinkedInScraper;
