# 🤖 LinkedIn Job Alert Agent

An AI-powered agent that monitors your LinkedIn feed on a schedule and sends you a **Telegram alert** whenever someone from your target companies posts a relevant hiring opportunity.

---

## 🧠 How It Works

```
LinkedIn Feed
     │
     ▼
[Puppeteer] ──── scrapes posts on a cron schedule
     │
     ▼
[Dedup Store] ── filters out already-seen posts
     │
     ▼
[Regex Gate] ─── fast pre-filter: drops posts with zero hiring intent
     │
     ▼
[Ollama LLM] ─── classifies each post against your criteria
     │            (company ✓  role ✓  location ✓  poster seniority ✓)
     ▼
[Telegram] ────── sends alert if it's a match 🎉
```

Classification is fully **local and free** — no cloud API calls. A two-stage pipeline keeps it fast:
1. **Regex gate** (<1ms/post) — drops posts with no hiring-intent signals before they reach the LLM
2. **Ollama + Qwen3** — few-shot prompted YES/NO classifier running on your machine (default model: `qwen3:8b`, configurable in `config.js`)

---

## 🗂️ Project Structure

```
job-search-agent/
├── config/
│   ├── config.example.js  ← Template (committed). Copy → config.js to get started.
│   └── config.js          ← 🔧 YOUR settings (gitignored — companies, roles, locations, chat ID)
├── scripts/
│   ├── launchd-install.sh   ← macOS scheduling setup
│   └── launchd-uninstall.sh ← macOS scheduling teardown
├── src/
│   ├── agent.js           ← Main orchestrator + cron scheduler
│   ├── scraper.js         ← Puppeteer-based LinkedIn scraper
│   ├── analyzer.js        ← Two-stage post classifier (regex + Ollama)
│   ├── notifier.js        ← Telegram alert sender
│   ├── store.js           ← Deduplication + per-run post logs
│   └── logger.js          ← Structured logging to console + files
├── logs/                  ← Auto-created at runtime (see Logs section)
├── .env                   ← Your secrets (never commit this!)
├── .env.example           ← Template for secrets
└── package.json
```

---

## ⚙️ Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Install Ollama and pull the model

```bash
# Install Ollama: https://ollama.com
brew install ollama        # macOS
ollama pull qwen3:8b       # ~5 GB download (default model — see model table below for lighter options)
ollama serve               # start the local server
```

### 3. Configure your targets

`config/config.js` is gitignored so your personal targets and chat ID stay local. Copy the template and edit it:

```bash
cp config/config.example.js config/config.js
```

Then open **`config/config.js`** and edit the fields to match your search:

```js
companies: ["Airbnb", "Confluent", "Zoom", "GitLab", "Indeed"],
roles:     ["Senior Software Engineer", "AI Engineer", "Senior Backend Engineer"],
locations: ["Remote", "India", "Remote India", "Bangalore"],
```

Set any filter to `"all"` to skip it entirely:

```js
companies: ["all"],   // match posts from any company
roles:     ["all"],   // match any engineering role
locations: ["all"],   // match any location
```

### 4. Set up a Telegram bot (one-time, ~2 minutes)

1. Open Telegram and message **@BotFather** → `/newbot` → follow prompts → copy the token
2. Start a chat with your new bot
3. Open in a browser (replace `<TOKEN>` with your token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. Copy the `id` value from the `"chat"` object — that's your `TELEGRAM_CHAT_ID`

### 5. Set your secrets

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `LINKEDIN_EMAIL` | Your LinkedIn login email |
| `LINKEDIN_PASSWORD` | Your LinkedIn password |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID (step 4 above) |

---

## 🚀 Running the Agent

### Run once (test / debug)
```bash
npm run scan
```

### Run once with verbose logs
```bash
npm run dev
```

### Run continuously (production)
```bash
npm start
```

The agent scans immediately on startup, then repeats on the cron schedule in `config.js` (default: every 3 hours).

### Run in background (keep alive after SSH logout)
```bash
# Using pm2 (recommended)
npm install -g pm2
pm2 start src/agent.js --name linkedin-agent
pm2 save
pm2 startup

# Or using nohup
nohup npm start > logs/output.log 2>&1 &
```

### Schedule on macOS with launchd (runs every 30 min while Mac is awake)

```bash
npm run launchd:install
```

This registers a launchd user agent that fires `node src/agent.js --once` every 30 minutes whenever your Mac is awake. If the Mac was asleep during a scheduled time, one catch-up scan runs immediately on wake.

```bash
# Check it's registered and get its last exit code
launchctl list | grep jobsearchagent

# Stop and remove
npm run launchd:uninstall

# Restart (e.g. after changing config)
npm run launchd:uninstall && npm run launchd:install
```

**How it differs from `npm start`:** `npm start` uses the internal `node-cron` schedule from `config.js` and keeps the process alive. The launchd setup ignores `scanSchedule` in config — launchd owns the 30-minute interval and Node starts fresh each time. Use one or the other, not both.

**nvm users:** The install script captures your current `node` path at install time. If you switch Node versions with nvm later, re-run `npm run launchd:install` to update the path.

**Ollama:** launchd won't start Ollama for you. If you installed Ollama via `brew install ollama`, it already runs as its own launchd service automatically. Verify with `ollama list`.

---

## 🔧 Configuration Reference

All settings live in `config/config.js`:

| Setting | Description |
|---|---|
| `scanSchedule` | Cron expression for scan frequency (default: every 3 hours) |
| `companies[]` | Target company names — use `["all"]` to match any company |
| `roles[]` | Job titles you're looking for — use `["all"]` to match any engineering role |
| `locations[]` | Acceptable locations — use `["all"]` to match any location |
| `posterTitles[]` | Only alert if the poster holds one of these title keywords. Leave `[]` or use `["all"]` to accept posts from anyone |
| `platforms.linkedin.scrollDepth` | How many times to scroll the feed (more = more posts, slower) |
| `platforms.linkedin.maxPostsPerScan` | Cap on posts analyzed per run |
| `browser.headless` | Set `false` to watch the browser (useful for debugging) |
| `ollama.host` | Ollama server address (default: `http://localhost:11434`) |
| `ollama.model` | Ollama model to use (default: `qwen3:8b`) |

### Choosing a model

| Model | Size | Quality | Notes |
|---|---|---|---|
| `qwen3:1.7b` | ~1 GB | Good | Fast, fits any laptop |
| `qwen3:4b` | ~2.5 GB | Better | Noticeably more accurate |
| `qwen3:8b` | ~5 GB | Best | **Default** — requires ~8 GB free RAM |

Switch models with `ollama pull <model>` and update `ollama.model` in config.

---

## ➕ Extending the Agent

### Add or remove companies, roles, locations
```js
// config/config.js
companies: ["Airbnb", "Stripe", "Figma"],
roles:     ["Senior Software Engineer", "Staff Engineer"],
locations: ["Remote", "India", "Bangalore"],
```

### Add a new notification channel (e.g. Slack)
1. Add to `config.js`:
   ```js
   slack: { enabled: true, webhookUrl: "https://hooks.slack.com/..." }
   ```
2. Add `_sendSlack()` in `src/notifier.js`
3. Call it in `sendAlert()` when `channels.slack?.enabled`

### Add a new platform (e.g. Twitter/X)
1. Add to `config.js`:
   ```js
   platforms: { twitter: { enabled: true, ... } }
   ```
2. Create `src/scrapers/twitter.js` following the same interface as `scraper.js`
3. Load it conditionally in `agent.js`

---

## ⚠️ Important Notes

- **LinkedIn ToS**: LinkedIn prohibits automated scraping. Use this for personal use only, run infrequently (every few hours), and use `slowMo` to mimic human behavior.
- **CAPTCHA**: If LinkedIn detects automation it may show a CAPTCHA. Set `browser.headless: false` to solve it manually the first time. Cookies are saved after the first login.
- **Two-factor auth**: Disable 2FA on your LinkedIn account or handle it manually on first run with `headless: false`.
- **Session cookies**: After the first successful login, cookies are saved in `logs/linkedin_cookies.json`. Subsequent runs reuse them and only log in again if the session has expired.
- **Ollama must be running**: The agent falls back gracefully if Ollama is unreachable (posts that passed the regex gate are passed through rather than silently dropped), but for accurate filtering keep `ollama serve` running.

---

## 📱 Example Telegram Alert

```
🚨 Job Alert Match!

👤 Posted by: Sarah Chen
🏢 Title: Senior Recruiter at Airbnb

🏷  Company: Airbnb
💼 Role: Senior Software Engineer
📍 Location: Remote India

📝 Post:
We're hiring! Looking for a Senior Software Engineer to join our
Payments team. This is a fully remote role open to candidates
based in India. DM me or apply via the link below...

🔗 View Post

⏰ 14/4/2026, 10:30:00 am IST
```

---

## 📋 Logs

| File | Contents |
|---|---|
| `logs/agent.log` | Full run history |
| `logs/errors.log` | Errors only |
| `logs/posts/seen_posts.json` | Fingerprints of already-seen posts (used for deduplication across runs) |
| `logs/posts/posts_log_YYYY-MM-DD_HH-MM-SS.json` | Full metadata of every post seen in that run. The 3 most recent files are kept; older ones are deleted automatically. |
| `logs/linkedin_cookies.json` | Saved LinkedIn session cookies |
| `~/Library/Logs/com.jobsearchagent/launchd.log` | stdout from launchd-fired runs (only when scheduled via `launchd:install`) |
| `~/Library/Logs/com.jobsearchagent/launchd-error.log` | stderr from launchd-fired runs |
# job-search-agent
