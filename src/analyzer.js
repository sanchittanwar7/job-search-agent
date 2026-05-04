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
    "  - Someone sharing that THEY got hired or accepted an offer (even if the offer was later revoked)",
    "  - Someone posting that THEY are looking for a job, open to work, seeking referrals, or exploring opportunities — these are job-seekers, NOT job postings",
    "  - Market commentary, layoff news, or industry trends",
    "  - Marketing or promotional content: background check services, immigration consultants, HR software, recruiting tools, or sponsored ads",
    "  - Educational courses, bootcamps, certifications, or university programmes",
    "  - Posts that only mention hiring in a hashtag (#Hiring, #OpenToWork) but are not actually posting an open role",
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
Reply with ONLY a JSON object on one line — no explanation, no markdown fences.
Format: {"match": true, "company": "CompanyName", "role": "Job Title"}
Use null for company or role if you cannot determine them.

IMPORTANT extraction rules:
- "company" must be the hiring organisation's name (e.g. "Airbnb", "Stripe"). NEVER put a city, country, or location there.
- "role" must be the exact job title (e.g. "Senior Software Engineer"). NEVER put a company name or location there.

A post is match:true when ALL of the following are true:
${yesLines.join("\n")}

A post is match:false when ANY of these apply:
${noLines.join("\n")}

---EXAMPLES---

[TRUE POSITIVES — posts that ARE real job openings]

Post: "Excited to share that my team at Airbnb is hiring a Senior Software Engineer! Remote-friendly, open to candidates in India. DM me or apply via the link."
Answer: {"match": true, "company": "Airbnb", "role": "Senior Software Engineer"}

Post: "We're growing the backend team at Confluent. Looking for a strong Senior Backend Engineer — remote India welcome. Ping me if interested."
Answer: {"match": true, "company": "Confluent", "role": "Senior Backend Engineer"}

Post: "Our team at Indeed is expanding! Hiring Senior Software Engineers in Bangalore and Hyderabad. Referrals welcome, comment below."
Answer: {"match": true, "company": "Indeed", "role": "Senior Software Engineer"}

Post: "GitLab is hiring a Senior Backend Engineer — fully remote, India candidates welcome."
Answer: {"match": true, "company": "GitLab", "role": "Senior Backend Engineer"}

Post: "Zoom is looking for an AI Engineer to join the platform team in India. Apply here: [link]"
Answer: {"match": true, "company": "Zoom", "role": "AI Engineer"}

Post: "We have an opening for a Staff Engineer at Razorpay, Bangalore. Strong distributed systems background preferred. Apply below."
Answer: {"match": true, "company": "Razorpay", "role": "Staff Engineer"}

Post: "Hiring alert! Swiggy is looking for a Senior SDE-2 for our growth team. Remote-first, India. Drop your resume in comments."
Answer: {"match": true, "company": "Swiggy", "role": "Senior SDE-2"}

Post: "We're building the future of fintech at Cred. Open role: Senior Software Engineer – Platform. Location: Bangalore or remote. Apply: [link]"
Answer: {"match": true, "company": "Cred", "role": "Senior Software Engineer"}

[LOCATION IS NOT COMPANY — never put city/country in the company field]

Post: "Exciting opportunity in Bangalore! Hiring a Senior Backend Engineer at a leading fintech startup. Remote-friendly. Apply now."
Answer: {"match": true, "company": null, "role": "Senior Backend Engineer"}

Post: "We are hiring a Senior Software Engineer in Hyderabad for our core infrastructure team at Myntra."
Answer: {"match": true, "company": "Myntra", "role": "Senior Software Engineer"}

Post: "Remote India | Senior Full Stack Engineer | Fast-growing SaaS startup | Apply here: [link]"
Answer: {"match": true, "company": null, "role": "Senior Full Stack Engineer"}

[WRONG SENIORITY / WRONG FUNCTION]

Post: "Airbnb is hiring a Software Engineering Intern for summer 2025. Based in San Francisco, USA."
Answer: {"match": false, "company": "Airbnb", "role": "Software Engineering Intern"}

Post: "Confluent is looking for a Junior Backend Engineer in New York City. Great opportunity for new grads!"
Answer: {"match": false, "company": "Confluent", "role": "Junior Backend Engineer"}

Post: "We are hiring an Associate Product Manager at Flipkart, Bangalore. 0–2 years experience welcome."
Answer: {"match": false, "company": "Flipkart", "role": "Associate Product Manager"}

Post: "Meesho is hiring a Senior Data Analyst in Bangalore. Strong SQL and Python skills required."
Answer: {"match": false, "company": "Meesho", "role": "Senior Data Analyst"}

Post: "Looking for a Graduate Software Engineer to join our UK team at HSBC. Fresh grads encouraged to apply."
Answer: {"match": false, "company": "HSBC", "role": "Graduate Software Engineer"}

[WRONG LOCATION — US/UK/Europe/on-site only]

Post: "We are hiring a Senior Software Engineer at Stripe — fully remote but US only."
Answer: {"match": false, "company": "Stripe", "role": "Senior Software Engineer"}

Post: "Shopify is hiring a Senior Backend Engineer. This role is based in our Ottawa office — no remote option."
Answer: {"match": false, "company": "Shopify", "role": "Senior Backend Engineer"}

Post: "Meta is looking for a Senior SWE in London. Hybrid, UK-based candidates only."
Answer: {"match": false, "company": "Meta", "role": "Senior Software Engineer"}

[TARGET COMPANY NOT IN LIST]

Post: "My team at Microsoft is hiring a Senior Software Engineer — remote, India welcome."
Answer: {"match": false, "company": "Microsoft", "role": "Senior Software Engineer"}

[PERSON LOOKING FOR A JOB — not a company posting a role]

Post: "I recently accepted an offer for a Backend Engineer role but it was revoked. I am now actively exploring new opportunities in software development and backend engineering. I have experience in Node.js and Go. Would appreciate any referrals. #OpenToWork #Hiring"
Answer: {"match": false, "company": null, "role": null}

Post: "Hi everyone – I am looking for a new role (Immediate Joiner) in Human Resources and Talent Acquisition. Open to opportunities in Lahore. Feel free to connect for relevant opportunities. #OpenToWork #HR"
Answer: {"match": false, "company": null, "role": null}

Post: "Actively looking for Senior SDE / Backend Engineer roles. 6 years of experience in distributed systems. Open to remote opportunities. DM me or drop a referral! #OpenToWork #SoftwareEngineer"
Answer: {"match": false, "company": null, "role": null}

Post: "I am a Senior Software Engineer with 8 years of experience. Recently laid off. Looking for my next opportunity in India or remote. Reach out if you have any leads. #hiring #OpenToWork"
Answer: {"match": false, "company": null, "role": null}

Post: "IIT grad | 4 YOE | SDE-2 at a product company | Exploring new opportunities. Happy to connect with recruiters. #JobSearch"
Answer: {"match": false, "company": null, "role": null}

[PERSON ANNOUNCING THEY JOINED / GOT HIRED]

Post: "Just accepted an offer at Google as a Senior SWE! Dreams do come true."
Answer: {"match": false, "company": "Google", "role": "Senior Software Engineer"}

Post: "Thrilled to share that I am joining Zepto as a Senior Software Engineer next month! Grateful for all the support."
Answer: {"match": false, "company": "Zepto", "role": "Senior Software Engineer"}

Post: "Excited to announce that I have joined Atlassian as a Senior Backend Engineer! New chapter begins."
Answer: {"match": false, "company": "Atlassian", "role": "Senior Backend Engineer"}

[MARKETING / PROMOTIONAL CONTENT — not job postings]

Post: "Do you truly know which of your delivery partners might be hiding a criminal past? We analyzed 5.8M+ background verifications to uncover where the risk is hiding before your next hiring surge. Download our report."
Answer: {"match": false, "company": null, "role": null}

Post: "5 things people get wrong about the Canada visitor visa. Save this post if you are planning to apply. ELLE Immigration helps families and professionals navigate Canada visitor visas. 30-min consultation $50. #CanadaImmigration"
Answer: {"match": false, "company": null, "role": null}

Post: "Struggling to find top tech talent? Our AI-powered recruiting platform shortlists candidates 10x faster. Book a demo today. #TalentAcquisition #Hiring"
Answer: {"match": false, "company": null, "role": null}

Post: "We help companies reduce time-to-hire by 40%. Join 500+ companies already using our platform. Try for free: [link]"
Answer: {"match": false, "company": null, "role": null}

[COURSES / EDUCATION / EVENTS — not job postings]

Post: "Want to learn about human rights issues and the role of business? Enrol today for our Masters Course this September. Apply here: [link] #Education"
Answer: {"match": false, "company": null, "role": null}

Post: "🚀 Launch your career with our 6-month Full Stack Bootcamp. Hiring partners include top MNCs. Apply now: [link] #Bootcamp #LearningAndDevelopment"
Answer: {"match": false, "company": null, "role": null}

Post: "Join us for a free webinar on system design interviews. Learn from engineers at FAANG. Register here: [link]"
Answer: {"match": false, "company": null, "role": null}

[CAREER ADVICE / COMMENTARY / MOTIVATIONAL]

Post: "Hot take: the best engineers are not the ones who grind LeetCode."
Answer: {"match": false, "company": null, "role": null}

Post: "5 things I wish I knew before my Senior Engineer interview at Amazon."
Answer: {"match": false, "company": "Amazon", "role": null}

Post: "Recruiter tip: always tailor your resume for each job. Here is how."
Answer: {"match": false, "company": null, "role": null}

Post: "The tech layoffs of 2024 were a wake-up call. Here is what the job market looks like now and what you should do."
Answer: {"match": false, "company": null, "role": null}

Post: "Rejected after 6 rounds at a top startup. Here is what I learned from the experience. #SoftwareEngineering"
Answer: {"match": false, "company": null, "role": null}

[STEALTH / UNVERIFIABLE COMPANY]

Post: "We are hiring a Senior SWE at our early-stage stealth startup — remote, great equity."
Answer: {"match": false, "company": null, "role": "Senior Software Engineer"}

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

  // ── Stage 2a: Ollama HTTP helper ─────────────────────────────────────────
  // format: optional JSON Schema object passed as Ollama's `format` field.
  // When present Ollama uses constrained decoding — the model is physically
  // forced to emit tokens that match the schema, so JSON.parse never throws.
  async _ollamaChat(messages, numPredict = 10, format = null) {
    const url  = `${this.ollamaCfg.host}/api/chat`;
    const body = {
      model:  this.ollamaCfg.model,
      stream: false,
      think:  false,
      options: { temperature: 0, num_predict: numPredict },
      messages,
    };
    if (format) body.format = format;
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const raw = (data.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
    return raw.trim();
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
      // If Ollama is unreachable, fall back to regex-only result
      logger.warn(`⚠️  Ollama unavailable (${err.message}) — falling back to regex for this post`);
      isMatch = true; // pass through so nothing is silently dropped
      reason  = "Ollama unavailable — regex gate passed";
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
