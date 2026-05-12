/**
 * Prompts
 * =======
 * Two focused LLM calls:
 *   1. EXTRACTION — understand the post, extract facts (no config influence)
 *   2. MATCHING   — given extracted facts + user config, decide match + reason
 */

const hasAll = (arr) => arr.some((v) => String(v).toLowerCase() === "all");

// ─── CALL 1: EXTRACTION ──────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are a structured data extractor for LinkedIn posts.
Reply with ONLY valid JSON on one line — no markdown, no explanation.

{"is_job_posting":<bool>,"company":<str|null>,"role":<str|null>,"location":<str|null>}

is_job_posting = true ONLY if a company or recruiter is actively posting an open vacancy for others to apply to.
is_job_posting = false for:
- Person seeking work (open to work, job search, seeking referrals, exploring opportunities)
- New-job announcements: "I'm joining X", "I've joined", "I will be joining", "I accepted an offer at",
  "excited/thrilled/happy to join/announce I'm joining", "starting my new role at", "I'll be starting at"
  — ANY first-person account of the author themselves starting or having started a new job → ALWAYS false
- Career advice, interview tips, motivational posts, opinions, commentary
- Marketing / promotional content (HR software, background checks, immigration, recruiting ads)
- Educational content (courses, bootcamps, webinars, university programs)
- Team / workplace updates (milestones, colleague promotions, manager on leave)
- Employer explicitly hiding identity ("stealth startup", "cannot share company name") → false

company: the HIRING company name. null if not stated.

role: the specific job title being hired for. Normalize abbreviations:
  SDE = SWE = Software Development Engineer → "Software Engineer" (keep seniority prefix)
  Sr. / Sr → "Senior",  Jr. / Jr → "Junior",  BE → "Backend Engineer",  FE → "Frontend Engineer"
  DO NOT normalize DevOps, SRE, Infrastructure Engineer, Data Engineer to "Software Engineer".
  Infer seniority from experience clues:
    0-2 years / SDE-1 / L3 / E3 / intern / graduate / associate / entry-level → add "Junior" prefix
    3-5 years / SDE-2 / L4 / E4 → add "Mid-Level" prefix  ← NOT senior
    5+ years / SDE-3 / L5 / E5 / "Senior" / "Sr." → add "Senior" prefix
    Staff / Principal / L6 / E6 → add "Staff" prefix ONLY for tech/engineering roles
  IMPORTANT: if a post lists multiple non-tech roles (chef, cook, driver, nurse, accountant, etc.),
  output the first listed role title verbatim — do NOT invent "Staff" as a title.
  "looking for talented staff" is NOT a job title — extract the actual listed position.
  null if no specific job title is stated.

location: normalize ALL remote variants (WFH, remote-first, "Remote India", fully remote) → "Remote".
  "Remote but US only" / "UK-based only" → output the restriction ("US only", "UK only").
  Keep city names as-is ("Bangalore", "London", "Ottawa"). null if not mentioned.`;

// ─── CALL 2: MATCHING ────────────────────────────────────────────────────────
const buildMatchPrompt = (config) => {
  const skipCompanies = hasAll(config.companies);
  const skipRoles     = hasAll(config.roles);
  const skipLocations = hasAll(config.locations);

  const companyRule = skipCompanies
    ? "Companies: ANY company is acceptable (no filter)"
    : `Companies: ONLY accept if company is one of — ${config.companies.join(", ")}`;

  const roleRule = skipRoles
    ? "Roles: ANY software or technical role is acceptable (intern, junior, mid, senior, staff — all OK)"
    : `Roles: ONLY accept if role matches one of — ${config.roles.join(", ")}`;

  const locationRule = skipLocations
    ? "Locations: ANY location is acceptable (no filter)"
    : `Locations: ONLY accept if location matches one of — ${config.locations.join(", ")}
  (if no location was extracted → location check PASSES automatically)`;

  const seniorityNote = skipRoles ? "" : `
Seniority matching rules:
  "Junior" / "Associate" / "Intern" / "Entry-Level" / "Graduate" do NOT match a "Senior X" target.
  "Mid-Level" / SDE-2 does NOT match "Senior X".
  "Software Engineer" with no seniority prefix does NOT match "Senior Software Engineer".
  "Staff" or "Principal" DOES match a "Senior X" target (Staff ≥ Senior).
  SDE-3 = Senior. SDE-2 = Mid. SDE-1 = Junior.`;

  return `You are a job preference matcher.
Given a user's preferences and an extracted job post, decide if the job matches ALL preferences.
Reply with ONLY valid JSON on one line.

{"match":<bool>,"reason":<one-sentence explanation>}

━━━ USER PREFERENCES ━━━
${companyRule}
${roleRule}
${locationRule}
━━━━━━━━━━━━━━━━━━━━━━━━
${seniorityNote}

Non-engineering roles NEVER match a software engineering preference:
PM, Product Manager, Designer, UX, Data Analyst, Data Scientist, DevOps, SRE,
Support Engineer, QA, Scrum Master, Engineering Manager, Director, VP,
Chef, Cook, Sous Chef, Pastry Chef, Baker, Chocolatier, CDP, Waiter, Bartender,
Nurse, Doctor, Driver, Accountant, Sales, Marketing, HR, Recruiter,
any hospitality / culinary / healthcare / physical / manual-labour role → always match: false

If the role is clearly not a software, AI, or computer-science engineering position → match: false.

match = true ONLY if the job satisfies ALL active preferences simultaneously.
If ANY preference is violated → match: false.`;
};

module.exports = { hasAll, EXTRACTION_PROMPT, buildMatchPrompt };
