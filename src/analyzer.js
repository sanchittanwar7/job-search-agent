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

// ─── FEW-SHOT PROMPT ─────────────────────────────────────────────────────────
// Setting any filter value to "all" (case-insensitive) disables that filter.
// Static examples illustrate common patterns; dynamic criteria come from config.
const hasAll = (arr) => arr.some((v) => String(v).toLowerCase() === "all");

const buildSystemPrompt = (config) => {
  const skipCompanies = hasAll(config.companies);
  const skipRoles     = hasAll(config.roles);
  const skipLocations = hasAll(config.locations);

  // Build YES criteria — skip a criterion entirely when its filter is "all"
  const yesLines = [
    "  1. It announces a currently open job position (not filled, not past)",
  ];

  if (skipRoles) {
    yesLines.push(
      "  2. The role is a software engineering or technical position",
      "     — Do NOT accept intern, junior, associate, entry-level, or graduate roles"
    );
  } else {
    yesLines.push(
      `  2. The role EXACTLY matches one of: ${config.roles.join(", ")}`,
      "     — Seniority must match: do NOT accept intern, junior, associate, entry-level, or graduate roles",
      "     — Function must match: do NOT accept PM, designer, data analyst, or other non-engineering roles"
    );
  }

  if (skipCompanies) {
    yesLines.push("  3. [No company filter — any company is acceptable]");
  } else {
    yesLines.push(
      `  3. The company is EXACTLY one of: ${config.companies.join(", ")}`,
      "     — Do NOT match subsidiary, parent, or similarly-named companies"
    );
  }

  if (skipLocations) {
    yesLines.push("  4. [No location filter — any location is acceptable]");
  } else {
    yesLines.push(
      `  4. The location is explicitly one of: ${config.locations.join(", ")}`,
      "     — If no location is mentioned, answer NO",
      "     — US-only, UK-only, Europe-only, or purely on-site roles are NO"
    );
  }

  // Build NO rules — omit filter-specific rules when that filter is "all"
  const noLines = [
    "  - Career advice, interview tips, or motivational content",
    "  - Someone sharing that THEY got hired or accepted an offer",
    "  - Market commentary, layoff news, or industry trends",
    "  - Wrong seniority: intern, junior, associate, entry-level, new grad, graduate",
    "  - Wrong function: PM, TPM, designer, data analyst, QA, DevOps (unless explicitly listed)",
  ];
  if (!skipCompanies) noLines.push("  - A role at a company not exactly in the target list");
  if (!skipRoles)     noLines.push("  - A role type not matching the target list (wrong seniority, wrong function)");
  if (!skipLocations) noLines.push(
    "  - Location not in target list, or location is US/UK/Europe/on-site only",
    "  - Post does not mention a location and is not explicitly remote"
  );

  return `You are a strict job alert classifier for a software engineer job search.
Reply with ONLY the word YES or NO — no explanation, no punctuation.

A post is YES when ALL of the following are true:
${yesLines.join("\n")}

A post is NO when ANY of these apply:
${noLines.join("\n")}

---EXAMPLES---

Post: "Excited to share that my team at Airbnb is hiring a Senior Software Engineer! Remote-friendly, open to candidates in India. DM me or apply via the link."
Answer: YES

Post: "We're growing the backend team at Confluent. Looking for a strong Senior Backend Engineer — remote India welcome. Ping me if interested."
Answer: YES

Post: "Our team at Indeed is expanding! Hiring Senior Software Engineers in Bangalore and Hyderabad. Referrals welcome, comment below."
Answer: YES

Post: "GitLab is hiring a Senior Backend Engineer — fully remote, India candidates welcome."
Answer: YES

Post: "Zoom is looking for an AI Engineer to join the platform team in India. Apply here: [link]"
Answer: YES

Post: "Airbnb is hiring a Software Engineering Intern for summer 2025. Based in San Francisco, USA."
Answer: NO

Post: "Confluent is looking for a Junior Backend Engineer in New York City. Great opportunity for new grads!"
Answer: NO

Post: "We are hiring a Senior Software Engineer at Stripe — fully remote but US only."
Answer: NO

Post: "My team at Microsoft is hiring a Senior Software Engineer — remote, India welcome."
Answer: NO

Post: "Hot take: the best engineers are not the ones who grind LeetCode."
Answer: NO

Post: "Just accepted an offer at Google as a Senior SWE! Dreams do come true."
Answer: NO

Post: "5 things I wish I knew before my Senior Engineer interview at Amazon."
Answer: NO

Post: "Recruiter tip: always tailor your resume for each job. Here is how."
Answer: NO

Post: "We are hiring a Senior SWE at our early-stage stealth startup — remote, great equity."
Answer: NO

---END EXAMPLES---`;
};

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

  // ── Stage 2: Ollama classification ───────────────────────────────────────
  async _ollamaClassify(postText) {
    const url  = `${this.ollamaCfg.host}/api/chat`;
    const body = {
      model:  this.ollamaCfg.model,
      stream: false,
      think:  false,   // top-level Ollama flag: disables Qwen3 <think> reasoning mode
      options: {
        temperature: 0,    // deterministic — we only want YES/NO
        num_predict: 10,   // YES/NO is 1-2 tokens; keep it tight
      },
      messages: [
        { role: "user",      content: this._systemPrompt },
        { role: "assistant", content: "Understood. Ready to classify." },
        {
          role: "user",
          content: `Post: "${postText.substring(0, 500)}"\nAnswer:`,
        },
      ],
    };

    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(15000), // don't hang if Ollama is slow
    });

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const content = data.message?.content || "";
    // Strip <think>…</think> blocks in case thinking mode partially activated
    const raw    = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
    const answer = raw.trim().toUpperCase();
    // logger.info(`Ollama response: "${content}" → interpreted as "${answer}"`);
    return answer.startsWith("YES");
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
        matchedCompany: null, matchedRole: null,
        matchedLocation: null, posterTitleMatch: false,
      };
    }

    // Stage 2
    let isMatch = false;
    let reason  = "";
    try {
      isMatch = await this._ollamaClassify(text);
      reason  = isMatch ? "Ollama: YES" : "Ollama: NO";
    } catch (err) {
      // If Ollama is unreachable, fall back to regex-only result
      logger.warn(`⚠️  Ollama unavailable (${err.message}) — falling back to regex for this post`);
      isMatch = true; // pass through so nothing is silently dropped
      reason  = "Ollama unavailable — regex gate passed";
    }

    const matchedCompany  = hasAll(this.config.companies) ? null : this._firstMatch(text, this.config.companies,  this.patterns.companies);
    const matchedRole     = hasAll(this.config.roles)     ? null : this._firstMatch(text, this.config.roles,      this.patterns.roles);
    const matchedLocation = hasAll(this.config.locations) ? null : this._firstMatch(text, this.config.locations,  this.patterns.locations);
    const posterTitleMatch =
      this.config.posterTitles.length === 0 ||
      hasAll(this.config.posterTitles) ||
      this.config.posterTitles.some((_, i) => this.patterns.posterTitles[i].test(authorTitle));

    return { isMatch, reason, matchedCompany, matchedRole, matchedLocation, posterTitleMatch };
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
        logger.info(`✅ MATCH: "${post.authorName}" — ${result.reason}`);
        matches.push({ post, analysis: result });
      } else if (result.isMatch && !result.posterTitleMatch) {
        logger.debug(`  ✗ ${post.authorName}: Ollama YES but poster title not in filter`);
      } else {
        logger.debug(`  ✗ ${post.authorName}: ${result.reason}`);
      }
    }

    logger.info(`🎯 Found ${matches.length} matching posts.`);
    return matches;
  }
}

module.exports = PostAnalyzer;
