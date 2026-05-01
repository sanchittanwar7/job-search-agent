/**
 * Seen Posts Store
 * ================
 * Tracks post URLs / fingerprints already alerted on,
 * so the agent doesn't send duplicate notifications across scans.
 * Uses a simple JSON file as a lightweight persistent store.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger");

const POSTS_DIR   = path.join(__dirname, "../logs/posts");
const STORE_PATH  = path.join(POSTS_DIR, "seen_posts.json");
const MAX_ENTRIES = 2000; // prevent unbounded growth in seen_posts.json
const MAX_RUNS    = 3;    // how many posts_log_*.json files to keep

fs.mkdirSync(POSTS_DIR, { recursive: true });

class SeenPostsStore {
  constructor() {
    this._logPath = null; // set by startRun() at the beginning of each scan
    this.seen = new Set();
    this._load();
  }

  /**
   * Call once at the start of each scan run.
   * Creates a new timestamped log file and prunes old ones.
   */
  startRun() {
    const ts = new Date().toISOString()
      .replace("T", "_")
      .replace(/:/g, "-")
      .slice(0, 19); // e.g. "2026-04-13_09-15-00"
    this._logPath = path.join(POSTS_DIR, `posts_log_${ts}.json`);
    logger.info(`📋 Run log: logs/posts/posts_log_${ts}.json`);
    this._pruneOldLogs();
  }

  _pruneOldLogs() {
    try {
      if (!fs.existsSync(POSTS_DIR)) return;
      const files = fs.readdirSync(POSTS_DIR)
        .filter((f) => /^posts_log_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(f))
        .sort()   // ISO-style names sort chronologically
        .reverse(); // newest first

      files.slice(MAX_RUNS).forEach((f) => {
        fs.unlinkSync(path.join(POSTS_DIR, f));
        logger.debug(`🗑  Deleted old run log: ${f}`);
      });
    } catch (e) {
      logger.warn(`Could not prune old run logs: ${e.message}`);
    }
  }

  _load() {
    try {
      if (fs.existsSync(STORE_PATH)) {
        const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
        this.seen = new Set(data);
        logger.debug(`📂 Loaded ${this.seen.size} seen post fingerprints.`);
      }
    } catch (e) {
      logger.warn("Could not load seen posts store — starting fresh.");
      this.seen = new Set();
    }
  }

  _save() {
    let entries = [...this.seen];
    if (entries.length > MAX_ENTRIES) {
      // Keep the most recent half
      entries = entries.slice(entries.length - MAX_ENTRIES / 2);
      this.seen = new Set(entries);
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2));
  }

  /**
   * Generate a stable fingerprint for a post.
   */
  _fingerprint(post) {
    const key = post.postUrl || `${post.authorName}::${post.text.substring(0, 100)}`;
    return crypto.createHash("sha1").update(key).digest("hex");
  }

  /**
   * Returns true if this post has already been seen.
   */
  hasSeen(post) {
    return this.seen.has(this._fingerprint(post));
  }

  /**
   * Mark a post as seen and persist its metadata to posts_log.json.
   */
  markSeen(post) {
    const fp = this._fingerprint(post);
    this.seen.add(fp);
    this._logPost(post, fp);
    this._save();
  }

  _logPost(post, fingerprint) {
    if (!this._logPath) return; // startRun() not called — skip logging

    let log = [];
    try {
      if (fs.existsSync(this._logPath)) {
        log = JSON.parse(fs.readFileSync(this._logPath, "utf-8"));
      }
    } catch { log = []; }

    log.push({
      fingerprint,
      seenAt:      new Date().toISOString(),
      authorName:  post.authorName  || "",
      authorTitle: post.authorTitle || "",
      postUrl:     post.postUrl     || "",
      timestamp:   post.timestamp   || "",
      text:        post.text ? post.text.substring(0, 300) : "",
    });

    fs.writeFileSync(this._logPath, JSON.stringify(log, null, 2));
  }

  /**
   * Filter a list of posts to only unseen ones.
   */
  filterNew(posts) {
    const newPosts = posts.filter((p) => !this.hasSeen(p));
    logger.info(
      `🗂  Dedup: ${posts.length} total → ${newPosts.length} new (${posts.length - newPosts.length} already seen)`
    );
    return newPosts;
  }
}

module.exports = SeenPostsStore;
