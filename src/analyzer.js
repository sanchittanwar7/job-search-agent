/**
 * Post Analyzer
 * =============
 * Two-stage pipeline:
 *
 * Stage 1 — Regex gate (< 1ms/post)
 *   Drops posts with zero hiring-intent signals.
 *
 * Stage 2 — Two focused LLM calls, no JS matching logic:
 *   Call A: Extract facts from the post (is_job_posting, company, role, location).
 *   Call B: Given extracted facts + user config, decide match + reason.
 *   Separating extraction from matching keeps each call focused and accurate.
 */

const logger = require("./logger");
const { hasAll, EXTRACTION_PROMPT, buildMatchPrompt } = require("./prompt");

// ─── REGEX GATE ──────────────────────────────────────────────────────────────
const HIRING_INTENT_RES = [
  /\b(?:we'?re?|now|actively|urgently|immediately)\s+hir(?:ing|ed)\b/i,
  /\bhir(?:ing|ed)\b/i,
  /\b(?:looking|searching|hunting)\s+for\b/i,
  /\bjoin\s+(?:our|the|my|us)\b/i,
  /\b(?:open|new|available)\s+(?:role|position|headcount|req(?:uisition)?)\b/i,
  /\bjob\s+(?:opening|post(?:ing)?|listing|alert|opportunity)\b/i,
  /\bcareer\s+opportunit/i,
  /\bappl(?:y|ication|ying|icants?)\b/i,
  /\b(?:dm|message|ping|reach\s+out)\s+(?:me|us)\b/i,
  /\bvacancy|vacancies\b/i,
  /\bpositions?\s+(?:open|available|at|in)\b/i,
  /\bexcited\s+to\s+(?:share|announce|post)\b/i,
];

// ─── ANALYZER ────────────────────────────────────────────────────────────────
class PostAnalyzer {
  constructor(config) {
    this.config       = config;
    this.ollamaCfg    = config.ollama;
    this._matchPrompt = buildMatchPrompt(config);

    const esc    = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const termRe = (t) => new RegExp(`(?<![\\w])${esc(t).replace(/\s+/g, "\\s+")}(?![\\w])`, "i");
    this.patterns = {
      companies:    hasAll(config.companies)    ? [] : config.companies.map(termRe),
      roles:        hasAll(config.roles)        ? [] : config.roles.map(termRe),
      locations:    hasAll(config.locations)    ? [] : config.locations.map(termRe),
      posterTitles: config.posterTitles.map(termRe),
    };
  }

  _passesGate(text) {
    return HIRING_INTENT_RES.some((re) => re.test(text));
  }

  async _ollamaChat(systemPrompt, userContent, numPredict, schema) {
    const url        = `${this.ollamaCfg.host}/api/chat`;
    const timeoutMs  = this.ollamaCfg.timeoutMs  ?? 60000;
    const maxRetries = this.ollamaCfg.maxRetries  ?? 3;
    const body = {
      model:   this.ollamaCfg.model,
      stream:  false,
      think:   false,
      options: { temperature: 0, num_predict: numPredict },
      messages: [
        { role: "user",      content: systemPrompt },
        { role: "assistant", content: "Understood." },
        { role: "user",      content: userContent },
      ],
    };
    if (schema) body.format = schema;

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
        const raw  = (data.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
        return raw.trim();
      } catch (err) {
        lastErr = err;
        const retry = err.name === "TimeoutError" || err.name === "AbortError" ||
                      err.message?.includes("ECONNREFUSED") || err.message?.includes("fetch failed");
        if (!retry || attempt === maxRetries) throw err;
        const delay = 1000 * 2 ** (attempt - 1);
        logger.warn(`⏳ Ollama attempt ${attempt}/${maxRetries} failed — retrying in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  // Call A: extract facts from post text — no config context, no matching.
  async _extract(postText) {
    const schema = {
      type: "object",
      properties: {
        is_job_posting: { type: "boolean" },
        company:        { type: ["string", "null"] },
        role:           { type: ["string", "null"] },
        location:       { type: ["string", "null"] },
      },
      required: ["is_job_posting", "company", "role", "location"],
    };

    const raw = await this._ollamaChat(
      EXTRACTION_PROMPT,
      `Post: "${postText.substring(0, 600)}"\nJSON:`,
      80,
      schema
    );

    const tryParse = (s) => {
      const p = JSON.parse(s);
      return {
        is_job_posting: p.is_job_posting === true,
        company:  typeof p.company  === "string" ? p.company.trim()  : null,
        role:     typeof p.role     === "string" ? p.role.trim()     : null,
        location: typeof p.location === "string" ? p.location.trim() : null,
      };
    };
    try { return tryParse(raw); } catch { /* fall through */ }
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) { try { return tryParse(m[0]); } catch { /* fall through */ } }
    return { is_job_posting: false, company: null, role: null, location: null };
  }

  // Call B: match extracted facts against user config — no post text, pure matching.
  async _match(company, role, location) {
    const schema = {
      type: "object",
      properties: {
        match:  { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["match", "reason"],
    };

    const jobSummary = [
      `Company : ${company  ?? "(not stated)"}`,
      `Role    : ${role     ?? "(not stated)"}`,
      `Location: ${location ?? "(not mentioned)"}`,
    ].join("\n");

    const raw = await this._ollamaChat(
      this._matchPrompt,
      `Job:\n${jobSummary}\n\nDoes this match the preferences? JSON:`,
      60,
      schema
    );

    const tryParse = (s) => {
      const p = JSON.parse(s);
      return { match: p.match === true, reason: typeof p.reason === "string" ? p.reason : "" };
    };
    try { return tryParse(raw); } catch { /* fall through */ }
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) { try { return tryParse(m[0]); } catch { /* fall through */ } }
    return { match: false, reason: "parse error" };
  }

  _firstMatch(text, list, patterns) {
    return list.find((_, i) => patterns[i]?.test(text)) || null;
  }

  async analyzePost(post) {
    const text        = post.text        || "";
    const authorTitle = post.authorTitle || "";

    if (!this._passesGate(text)) {
      return { isMatch: false, reason: "regex gate", company: null, role: null, matchedLocation: null, posterTitleMatch: false };
    }

    let extracted;
    try {
      extracted = await this._extract(text);
    } catch (err) {
      logger.error(`Ollama extraction failed: ${err.message}`);
      return { isMatch: false, reason: `Ollama unavailable: ${err.message}`, company: null, role: null, matchedLocation: null, posterTitleMatch: false };
    }

    const { is_job_posting, company, role, location } = extracted;

    if (!is_job_posting) {
      return { isMatch: false, reason: "not a job posting", company, role, matchedLocation: location, posterTitleMatch: false };
    }
    if (!role) {
      return { isMatch: false, reason: "no role extracted", company, role: null, matchedLocation: location, posterTitleMatch: false };
    }

    let matchResult;
    try {
      matchResult = await this._match(company, role, location);
    } catch (err) {
      logger.error(`Ollama matching failed: ${err.message}`);
      return { isMatch: false, reason: `Ollama unavailable: ${err.message}`, company, role, matchedLocation: location, posterTitleMatch: false };
    }

    const matchedLocation =
      (typeof location === "string" && location) ? location :
      hasAll(this.config.locations) ? null :
      this._firstMatch(text, this.config.locations, this.patterns.locations);

    const posterTitleMatch =
      this.config.posterTitles.length === 0 ||
      hasAll(this.config.posterTitles) ||
      this.config.posterTitles.some((_, i) => this.patterns.posterTitles[i].test(authorTitle));

    return {
      isMatch: matchResult.match,
      reason:  matchResult.reason,
      company, role, matchedLocation, posterTitleMatch,
    };
  }

  async filterPosts(posts) {
    const gated = posts.filter((p) => this._passesGate(p.text || ""));
    logger.info(`🔍 ${posts.length} posts — regex dropped ${posts.length - gated.length}, sending ${gated.length} to Ollama`);

    const matches = [];
    for (const post of posts) {
      const result = await this.analyzePost(post);
      if (result.isMatch && result.posterTitleMatch) {
        logger.info(`✅ MATCH: "${post.authorName}" — ${result.reason}`);
        matches.push({ post, analysis: result });
      } else {
        logger.debug(`  ✗ ${post.authorName}: ${result.reason}`);
      }
    }
    logger.info(`🎯 Found ${matches.length} matching posts.`);
    return matches;
  }
}

module.exports = PostAnalyzer;
