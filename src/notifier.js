/**
 * Notification Service
 * ====================
 * Sends alerts via configured channels.
 * Currently: Telegram Bot API (free, no credits).
 */

const logger = require("./logger");

const TELEGRAM_API = "https://api.telegram.org";

class NotificationService {
  constructor(config) {
    this.config = config;
    this._initProviders();
  }

  _initProviders() {
    const { telegram } = this.config.notifications;

    if (telegram?.enabled) {
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN must be set in .env");
      }
      if (!process.env.TELEGRAM_CHAT_ID && !telegram.chatId) {
        throw new Error("TELEGRAM_CHAT_ID must be set in .env (or telegram.chatId in config)");
      }
      this._botToken = process.env.TELEGRAM_BOT_TOKEN;
      this._chatId   = process.env.TELEGRAM_CHAT_ID || telegram.chatId;
      logger.info("📱 Telegram bot channel initialized.");
    }
  }

  async sendAlert(post, analysis, levelsUrl = null) {
    const message  = this._formatMessage(post, analysis, levelsUrl);
    const channels = this.config.notifications;
    const promises = [];

    if (channels.telegram?.enabled) {
      promises.push(this._sendTelegram(message));
    }

    await Promise.allSettled(promises);
  }

  async sendAlerts(matches) {
    if (matches.length === 0) {
      logger.info("🔕 No matches this scan — no notifications sent.");
      return;
    }

    logger.info(`📤 Sending ${matches.length} alert(s) via Telegram…`);
    for (const { post, analysis, levelsUrl } of matches) {
      await this.sendAlert(post, analysis, levelsUrl);
    }
  }

  // ─── TELEGRAM ─────────────────────────────────────────────────────────────

  async _sendTelegram(text) {
    const url = `${TELEGRAM_API}/bot${this._botToken}/sendMessage`;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          chat_id:    this._chatId,
          text,
          parse_mode: "MarkdownV2",
          // Disable link previews so the message stays compact
          disable_web_page_preview: true,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description);
      logger.info(`📲 Telegram alert sent (chat ${this._chatId})`);
    } catch (err) {
      logger.error(`❌ Telegram send failed: ${err.message}`);
    }
  }

  // ─── MESSAGE FORMATTER ────────────────────────────────────────────────────

  _formatMessage(post, analysis, levelsUrl) {
    const lines = [
      `🚨 *Job Alert Match\\!*`,
      ``,
      `👤 *Posted by:* ${this._esc(post.authorName)}`,
      post.authorTitle ? `🏢 *Title:* ${this._esc(post.authorTitle)}` : null,
      ``,
      analysis.company         ? `🏷  *Company:*  ${this._esc(analysis.company)}`         : null,
      analysis.role            ? `💼 *Role:*     ${this._esc(analysis.role)}`            : null,
      analysis.matchedLocation ? `📍 *Location:* ${this._esc(analysis.matchedLocation)}` : null,
      ``,
      `📝 *Post:*`,
      this._esc(post.text),
      ``,
      post.postUrl ? `🔗 [View Post](${this._escUrl(post.postUrl)})` : `🔗 _No direct link found_`,
      levelsUrl    ? `💵 [Salary data on levels\\.fyi](${this._escUrl(levelsUrl)})` : null,
      ``,
      `⏰ ${this._esc(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))} IST`,
    ];

    return lines.filter((l) => l !== null).join("\n");
  }

  // Escape Telegram MarkdownV2 special characters (for text fields)
  _esc(str = "") {
    return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
  }

  // Escape only the characters that must be escaped inside a MarkdownV2 URL
  _escUrl(url = "") {
    return String(url).replace(/[)\\]/g, "\\$&");
  }
}

module.exports = NotificationService;
