/**
 * Classifier Prompt
 * =================
 * Builds the few-shot system prompt sent to Ollama for job post classification.
 * Separated from analyzer.js so the prompt can be edited and tested independently.
 */

const hasAll = (arr) => arr.some((v) => String(v).toLowerCase() === "all");

const buildSystemPrompt = (config) => {
  const skipCompanies = hasAll(config.companies);
  const skipRoles     = hasAll(config.roles);
  const skipLocations = hasAll(config.locations);

  const yesLines = [
    "  1. It announces a currently open job position (not filled, not past)",
  ];

  if (skipRoles) {
    yesLines.push(
      "  2. The role is a software engineering or technical position"
    );
  } else {
    yesLines.push(
      `  2. The role EXACTLY matches one of: ${config.roles.join(", ")}`,
      "     — Function must match: do NOT accept PM, designer, data analyst, or other non-engineering roles unless explicitly listed"
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
      `  4. If a location IS mentioned, it must be one of: ${config.locations.join(", ")}`,
      "     — If NO location is mentioned in the post, the location check passes — do NOT reject on location alone",
      "     — If a location IS mentioned and it is US-only, UK-only, Europe-only, or on-site outside the target list, answer NO"
    );
  }

  const noLines = [
    "  - Career advice, interview tips, or motivational content",
    "  - Personal workplace or life updates: manager on leave, team news, office culture, promotions of colleagues, birthdays, work anniversaries — anything not about an open position",
    "  - Someone sharing that THEY got hired or accepted an offer (even if the offer was later revoked)",
    "  - Someone posting that THEY are looking for a job, open to work, seeking referrals, or exploring opportunities — these are job-seekers, NOT job postings",
    "  - Market commentary, layoff news, or industry trends",
    "  - Marketing or promotional content: background check services, immigration consultants, HR software, recruiting tools, or sponsored ads",
    "  - Educational courses, bootcamps, certifications, or university programmes",
    "  - Posts that only mention hiring in a hashtag (#Hiring, #OpenToWork) but are not actually posting an open role",
    "  - Wrong function: PM, TPM, designer, data analyst, QA, DevOps (unless explicitly listed)",
  ];
  if (!skipCompanies) noLines.push("  - The company in the post is NOT in the target list — even if role and location match perfectly, answer NO if the company is not listed");
  if (!skipRoles)     noLines.push("  - The role does not EXACTLY match the target list — DevOps, SRE, infrastructure, data, design, or management roles are NO unless explicitly listed");
  if (!skipLocations) noLines.push(
    "  - A location IS mentioned in the post and it is not in the target list",
    "  - A location IS mentioned and the role is US-only, UK-only, Europe-only, or on-site outside the target list"
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

Post: "We're building the future of fintech at Cred. Open role: Senior Software Engineer. Location: Bangalore or remote. Apply: [link]"
Answer: {"match": true, "company": "Cred", "role": "Senior Software Engineer"}

[LOCATION IS NOT COMPANY — never put city/country in the company field]

Post: "Exciting opportunity in Bangalore! Hiring a Senior Backend Engineer at a leading fintech startup. Remote-friendly. Apply now."
Answer: {"match": true, "company": null, "role": "Senior Backend Engineer"}

Post: "We are hiring a Senior Software Engineer in Hyderabad for our core infrastructure team at Myntra."
Answer: {"match": true, "company": "Myntra", "role": "Senior Software Engineer"}

Post: "Remote India | Senior Full Stack Engineer | Fast-growing SaaS startup | Apply here: [link]"
Answer: {"match": true, "company": null, "role": "Senior Full Stack Engineer"}

Post: "Bangalore | Senior Software Engineer | Top fintech startup | Remote India | Apply here: [link]"
Answer: {"match": true, "company": null, "role": "Senior Software Engineer"}

[WRONG FUNCTION — non-engineering roles are always rejected]

Post: "We are hiring an Associate Product Manager at Flipkart, Bangalore. 0-2 years experience welcome."
Answer: {"match": false, "company": "Flipkart", "role": "Associate Product Manager"}

Post: "Meesho is hiring a Senior Data Analyst in Bangalore. Strong SQL and Python skills required."
Answer: {"match": false, "company": "Meesho", "role": "Senior Data Analyst"}

Post: "We are hiring a Senior UX Designer to join our product team in Bangalore. Portfolio required."
Answer: {"match": false, "company": null, "role": "Senior UX Designer"}

[WRONG LOCATION — US/UK/Europe/on-site only]

Post: "We are hiring a Senior Software Engineer at Stripe — fully remote but US only."
Answer: {"match": false, "company": "Stripe", "role": "Senior Software Engineer"}

Post: "Shopify is hiring a Senior Backend Engineer. This role is based in our Ottawa office — no remote option."
Answer: {"match": false, "company": "Shopify", "role": "Senior Backend Engineer"}

Post: "Meta is looking for a Senior SWE in London. Hybrid, UK-based candidates only."
Answer: {"match": false, "company": "Meta", "role": "Senior Software Engineer"}

[TARGET COMPANY NOT IN LIST — reject even if role and location are perfect]

Post: "My team at Microsoft is hiring a Senior Software Engineer — remote, India welcome."
Answer: {"match": false, "company": "Microsoft", "role": "Senior Software Engineer"}

Post: "We are hiring a Senior Software Engineer at Razorpay. Remote India welcome. Excellent equity."
Answer: {"match": false, "company": "Razorpay", "role": "Senior Software Engineer"}

[ROLE NOT IN TARGET LIST — DevOps/SRE/infra are distinct roles, not interchangeable with SWE/Backend]

Post: "Hiring a Senior DevOps Engineer for our infrastructure team. Bangalore or remote India. Strong Kubernetes and Terraform background required."
Answer: {"match": false, "company": null, "role": "Senior DevOps Engineer"}

Post: "We are looking for a Senior SRE to join our platform reliability team. Remote India. Strong oncall and observability experience needed."
Answer: {"match": false, "company": null, "role": "Senior SRE"}

[NO LOCATION MENTIONED — passes the location check when location filter is active]

Post: "We are hiring a Senior Backend Engineer for our core infrastructure team. Strong Go and Kubernetes background required. DM me if interested."
Answer: {"match": true, "company": null, "role": "Senior Backend Engineer"}

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

Post: "Launch your career with our 6-month Full Stack Bootcamp. Hiring partners include top MNCs. Apply now: [link] #Bootcamp #LearningAndDevelopment"
Answer: {"match": false, "company": null, "role": null}

Post: "Join us for a free webinar on system design interviews. Learn from engineers at FAANG. Register here: [link]"
Answer: {"match": false, "company": null, "role": null}

[PERSONAL WORKPLACE UPDATES — not job postings]

Post: "I'm excited to share that my manager is on leave. Life is good. Bosses should take vacations more often."
Answer: {"match": false, "company": null, "role": null}

Post: "Happy to share that our team just hit 1 million users! So proud of everyone who made this happen."
Answer: {"match": false, "company": null, "role": null}

Post: "Excited to announce that our VP of Engineering just got promoted to CTO! Congratulations!"
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

module.exports = { hasAll, buildSystemPrompt };
