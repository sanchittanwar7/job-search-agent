/**
 * Post Analyzer
 * =============
 * Two-stage pipeline:
 *
 * Stage 1 — Regex gate (< 1ms/post)
 *   Drops posts with zero hiring-intent signals so Ollama never sees them.
 *
 * Stage 2 — Ollama few-shot classification
 *   Sends survivors to a local qwen2.5:1.5b instance with a few-shot prompt
 *   built from the user's config (companies / roles / locations).
 *   Model replies YES or NO — nothing else (temperature=0).
 *
 * Ollama must be running: https://ollama.com  →  ollama pull qwen2.5:1.5b
 */

const logger = require("./logger");
const { hasAll, buildSystemPrompt } = require("./prompt");

// ─── REGEX GATE ──────────────────────────────────────────────────────────────
// Wide net — prefer false positives here; Ollama will clean them up.
const HIRING_INTENT_RES = [
  /\b(?:we'?re?|now|actively|urgently|immediately)\s+hir(?:ing|ed)\b/i,
  /\bhir(?:ing|ed)\b/i,
  /\b(?:looking|searching|hunting)\s+for\b/i,
  /\bjoin\s+(?:our|the|my|us)\b/i,
  /\b(?:open|new|available)\s+(?:role|position|headcount|req(?:uisition)?)\b/i,
  /\bjob\s+(?:opening|post(?:ing)?|listing|alert|opportunity)\b/i,
  /\bcareer\s+opportunit/i,
  /\bappl(?:y|ication|ying|icants?)\b/i,
  /\b(?:shortlist(?:ed|ing)?|interview(?:ing|s)?)\b/i,
  /\b(?:dm|message|ping|reach\s+out)\s+(?:me|us)\b/i,
  /\bvacancy|vacancies\b/i,
  /\btalent\s+(?:acquisition|sourcing|search)\b/i,
  /\bpositions?\s+(?:open|available|at|in)\b/i,
  /\bopportunity\s+(?:at|with|for|to\s+join)\b/i,
  /\bexcited\s+to\s+(?:share|announce|post)\b/i,
  /\b(?:full.?time|contract|freelance)\s+(?:role|position|opportunity)\b/i,
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const esc       = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRegex = (term) =>
  new RegExp(`(?<![\\w])${esc(term).replace(/\s+/g, "\\s+")}(?![\\w])`, "i");

// ─── ANALYZER ────────────────────────────────────────────────────────────────
class PostAnalyzer {
  constructor(config) {
    this.config       = config;
    this.ollamaCfg    = config.ollama;
    this._systemPrompt = buildSystemPrompt(config);

    // Pre-compile config terms for metadata extraction (used in notification msg).
    // Filters set to "all" get an empty pattern list (no specific term to extract).
    this.patterns = {
      companies:    hasAll(config.companies) ? [] : config.companies.map(termRegex),
      roles:        hasAll(config.roles)     ? [] : config.roles.map(termRegex),
      locations:    hasAll(config.locations) ? [] : config.locations.map(termRegex),
      posterTitles: config.posterTitles.map(termRegex),
    };
  }

  // ── Stage 1: regex gate ───────────────────────────────────────────────────
  _passesGate(text) {
    return HIRING_INTENT_RES.some((re) => re.test(text));
  }

  // ── Stage 2a: Ollama HTTP helper ─────────────────────────────────────────
  // format: optional JSON Schema object passed as Ollama's `format` field.
  // When present Ollama uses constrained decoding — the model is physically
  // forced to emit tokens that match the schema, so JSON.parse never throws.
  //
  // Retries up to OLLAMA_RETRIES times with exponential backoff on timeout or
  // transient errors. Throws only after all attempts are exhausted.
  async _ollamaChat(messages, numPredict = 10, format = null) {
    const url        = `${this.ollamaCfg.host}/api/chat`;
    const timeoutMs  = this.ollamaCfg.timeoutMs  ?? 60000;
    const maxRetries = this.ollamaCfg.maxRetries  ?? 3;
    const body = {
      model:  this.ollamaCfg.model,
      stream: false,
      think:  false,
      options: { temperature: 0, num_predict: numPredict },
      messages,
    };
    if (format) body.format = format;

    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
          signal:  AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const raw = (data.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
        return raw.trim();
      } catch (err) {
        lastErr = err;
        const isRetryable = err.name === "TimeoutError" || err.name === "AbortError" ||
                            err.message?.includes("ECONNREFUSED") ||
                            err.message?.includes("fetch failed");
        if (!isRetryable || attempt === maxRetries) throw err;
        const delayMs = 1000 * 2 ** (attempt - 1); // 1 s, 2 s, 4 s …
        logger.warn(`⏳ Ollama attempt ${attempt}/${maxRetries} failed (${err.message}) — retrying in ${delayMs / 1000}s`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  // ── Stage 2: Ollama — classify + extract company/role in one call ─────────
  async _classifyPost(postText) {
    // Constrained-decoding schema: Ollama guarantees the output matches this
    // shape, so we don't need regex heuristics or a YES/NO fallback.
    const schema = {
      type: "object",
      properties: {
        match:   { type: "boolean" },
        company: { type: ["string", "null"] },
        role:    { type: ["string", "null"] },
      },
      required: ["match", "company", "role"],
    };

    const raw = await this._ollamaChat(
      [
        { role: "user",      content: this._systemPrompt },
        { role: "assistant", content: "Understood. Ready to classify." },
        { role: "user",      content: `Post: "${postText.substring(0, 500)}"\nJSON:` },
      ],
      60,
      schema
    );

    try {
      const parsed = JSON.parse(raw);
      return {
        isMatch: parsed.match === true,
        company: typeof parsed.company === "string" ? parsed.company : null,
        role:    typeof parsed.role    === "string" ? parsed.role    : null,
      };
    } catch {
      // Schema enforcement failed (very old Ollama without constrained decoding).
      // Best-effort: look for a JSON object anywhere in the output.
      const m = raw.match(/\{[\s\S]*?\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          return {
            isMatch: parsed.match === true,
            company: typeof parsed.company === "string" ? parsed.company : null,
            role:    typeof parsed.role    === "string" ? parsed.role    : null,
          };
        } catch { /* fall through */ }
      }
      return { isMatch: raw.toUpperCase().includes("TRUE") || raw.toUpperCase().startsWith("YES"), company: null, role: null };
    }
  }

  // ── Metadata extraction (for notification message) ────────────────────────
  _firstMatch(text, list, patterns) {
    return list.find((_, i) => patterns[i]?.test(text)) || null;
  }

  // ── Per-post entry point ──────────────────────────────────────────────────
  async analyzePost(post) {
    const text        = post.text        || "";
    const authorTitle = post.authorTitle || "";

    // Stage 1
    if (!this._passesGate(text)) {
      return {
        isMatch: false, reason: "regex gate: no hiring intent",
        company: null, role: null,
        matchedLocation: null, posterTitleMatch: false,
      };
    }

    // Stage 2
    let isMatch = false;
    let reason  = "";
    let company = null;
    let role    = null;
    try {
      ({ isMatch, company, role } = await this._classifyPost(text));
      reason = isMatch ? "Ollama: YES" : "Ollama: NO";
    } catch (err) {
      logger.error(`Ollama failed after retries — skipping post by "${post.authorName}": ${err.message}`, {
        authorName: post.authorName,
        postSnippet: text.substring(0, 120),
      });
      isMatch = false;
      reason  = `Ollama unavailable: ${err.message}`;
    }

    const matchedLocation = hasAll(this.config.locations) ? null : this._firstMatch(text, this.config.locations, this.patterns.locations);
    const posterTitleMatch =
      this.config.posterTitles.length === 0 ||
      hasAll(this.config.posterTitles) ||
      this.config.posterTitles.some((_, i) => this.patterns.posterTitles[i].test(authorTitle));

    return { isMatch, reason, company, role, matchedLocation, posterTitleMatch };
  }

  // ── Batch filter ─────────────────────────────────────────────────────────
  async filterPosts(posts) {
    const gated = posts.filter((p) => this._passesGate(p.text || ""));
    logger.info(
      `🔍 Analyzing ${posts.length} posts — ` +
      `regex gate: ${posts.length - gated.length} dropped, ${gated.length} sent to Ollama`
    );

    const matches = [];
    for (const post of posts) {
    const result = await this.analyzePost(post);
      if (result.isMatch && result.posterTitleMatch) {
        logger.info(`✅ MATCH: "${post.authorName}" — ${JSON.stringify(result)}`);
        matches.push({ post, analysis: result });
      } else if (result.isMatch && !result.posterTitleMatch) {
        logger.debug(`  ✗ ${post.authorName}: Ollama YES but poster title not in filter`);
      } else {
        logger.debug(`  ✗ ${post.authorName}: ${JSON.stringify(result)}`);
      }
    }

    logger.info(`🎯 Found ${matches.length} matching posts.`);
    return matches;
  }
}

module.exports = PostAnalyzer;
