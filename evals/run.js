#!/usr/bin/env node
/**
 * Eval Runner
 * ===========
 * Runs the benchmark against the live Ollama classifier.
 *
 * Usage:
 *   node evals/run.js
 *   node evals/run.js --filter true_positive
 *   node evals/run.js --case tp_001
 *   node evals/run.js --runs 5 --verbose
 *   node evals/run.js --ollama-model qwen2.5:3b
 *   node evals/run.js --no-color
 *
 * Exit code: 0 = all pass, 1 = regressions found, 2 = fatal error
 */

const path = require("path");
const fs   = require("fs");

// ─── CLI ARGS ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg  = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };
const hasFlag = (flag) => argv.includes(flag);

const ollamaHost  = getArg("--ollama-host",  null);
const ollamaModel = getArg("--ollama-model", null);
const filterTag   = getArg("--filter",       null);
const filterCase  = getArg("--case",         null);
const numRuns     = Math.max(1, parseInt(getArg("--runs", "3"), 10));
const verbose     = hasFlag("--verbose");
const noColor     = hasFlag("--no-color") || !process.stdout.isTTY;

// ─── COLORS ──────────────────────────────────────────────────────────────────
const c = noColor
  ? { reset:"", green:"", red:"", yellow:"", bold:"", dim:"", cyan:"" }
  : { reset:"\x1b[0m", green:"\x1b[32m", red:"\x1b[31m", yellow:"\x1b[33m",
      bold:"\x1b[1m",  dim:"\x1b[2m",    cyan:"\x1b[36m" };

// ─── LOAD BENCHMARK ──────────────────────────────────────────────────────────
const benchmarkPath = path.join(__dirname, "benchmark.json");
const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, "utf8"));

const resolvedHost  = ollamaHost  || benchmark.ollamaDefaults.host;
const resolvedModel = ollamaModel || benchmark.ollamaDefaults.model;

// ─── FILTER CASES ────────────────────────────────────────────────────────────
let cases = benchmark.cases;
if (filterCase) {
  cases = cases.filter((c) => c.id === filterCase);
  if (cases.length === 0) { console.error(`No case with id "${filterCase}"`); process.exit(2); }
} else if (filterTag) {
  cases = cases.filter((c) => c.tags.includes(filterTag));
  if (cases.length === 0) { console.error(`No cases with tag "${filterTag}"`); process.exit(2); }
}

// ─── LOAD ANALYZER ───────────────────────────────────────────────────────────
const PostAnalyzer = require("../src/analyzer");

// ─── COMPARISON HELPERS ──────────────────────────────────────────────────────
// Company and role matching: case-insensitive substring match in either direction
// to handle minor phrasing differences (e.g. "Senior SWE" vs "Senior Software Engineer").
const normalise = (s) => (s || "").toLowerCase().trim();

const companyMatches = (result, golden) => {
  if (golden.company === null) return result.company === null;
  if (result.company === null) return false;
  return normalise(result.company) === normalise(golden.company);
};

const roleMatches = (result, golden) => {
  if (golden.role === null) return result.role === null;
  if (result.role === null) return false;
  const r = normalise(result.role);
  const g = normalise(golden.role);
  return r === g || r.includes(g) || g.includes(r);
};

const locationMatches = (result, golden) => {
  if (golden.location === null || golden.location === undefined) return true; // skip if golden doesn't assert
  if (result.location === null || result.location === undefined) return false;
  return normalise(result.location) === normalise(golden.location);
};

// ─── REGRESSION THRESHOLD ────────────────────────────────────────────────────
// "differ for more than 1/3 runs" → regression when correct runs < numRuns * 2/3
const passThreshold = (correct, total) => correct >= Math.ceil(total * 2 / 3);

// ─── RUN A SINGLE CASE ───────────────────────────────────────────────────────
async function runCase(testCase) {
  const config = {
    ...testCase.config,
    ollama: { host: resolvedHost, model: resolvedModel },
  };
  const analyzer = new PostAnalyzer(config);
  const runs = [];
  for (let i = 0; i < numRuns; i++) {
    try {
      const result = await analyzer.analyzePost(testCase.post);
      runs.push({ isMatch: result.isMatch, company: result.company, role: result.role, location: result.matchedLocation });
    } catch (err) {
      runs.push({ isMatch: null, company: null, role: null, location: null, error: err.message });
    }
  }
  return runs;
}

// ─── SCORE A CASE ────────────────────────────────────────────────────────────
function score(runs, golden) {
  const isMatchCorrect  = runs.filter((r) => r.isMatch === golden.isMatch).length;
  const companyCorrect  = runs.filter((r) => companyMatches(r, golden)).length;
  const roleCorrect     = runs.filter((r) => roleMatches(r, golden)).length;
  const locationCorrect = runs.filter((r) => locationMatches(r, golden)).length;
  return {
    isMatchCorrect,
    companyCorrect,
    roleCorrect,
    locationCorrect,
    isRegression: !passThreshold(isMatchCorrect, numRuns),
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${c.bold}╔══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}║       Job Alert Classifier — Eval Suite              ║${c.reset}`);
  console.log(`${c.bold}╚══════════════════════════════════════════════════════╝${c.reset}\n`);
  console.log(`${c.dim}Ollama : ${resolvedHost} / ${resolvedModel}${c.reset}`);
  console.log(`${c.dim}Cases  : ${cases.length}  |  Runs per case: ${numRuns}  |  Pass threshold: ≥${Math.ceil(numRuns * 2 / 3)}/${numRuns}${c.reset}\n`);

  let regressions          = 0;
  let companyAsserts       = 0;
  let companyCorrectTotal  = 0;
  let roleAsserts          = 0;
  let roleCorrectTotal     = 0;
  let locationAsserts      = 0;
  let locationCorrectTotal = 0;

  const regressionList = [];

  for (const testCase of cases) {
    const runs      = await runCase(testCase);
    const sc        = score(runs, testCase.golden);
    const indicator = sc.isRegression ? `${c.red}${c.bold}FAIL${c.reset}` : `${c.green}PASS${c.reset}`;
    const runScore  = `[${sc.isMatchCorrect}/${numRuns}]`;

    // Company soft indicator (only shown when golden asserts a specific value)
    let companyTag = `${c.dim}—${c.reset}`;
    if (testCase.golden.company !== null) {
      const ok = passThreshold(sc.companyCorrect, numRuns);
      companyTag = ok ? `${c.green}✓${c.reset}` : `${c.yellow}✗${c.reset}`;
      companyAsserts++;
      if (ok) companyCorrectTotal++;
    }

    let roleTag = `${c.dim}—${c.reset}`;
    if (testCase.golden.role !== null) {
      const ok = passThreshold(sc.roleCorrect, numRuns);
      roleTag = ok ? `${c.green}✓${c.reset}` : `${c.yellow}✗${c.reset}`;
      roleAsserts++;
      if (ok) roleCorrectTotal++;
    }

    let locationTag = `${c.dim}—${c.reset}`;
    if (testCase.golden.location != null) {
      const ok = passThreshold(sc.locationCorrect, numRuns);
      locationTag = ok ? `${c.green}✓${c.reset}` : `${c.yellow}✗${c.reset}`;
      locationAsserts++;
      if (ok) locationCorrectTotal++;
    }

    const regressionSuffix = sc.isRegression ? `  ${c.red}← REGRESSION${c.reset}` : "";

    console.log(
      `  ${indicator}  ${c.dim}${testCase.id.padEnd(18)}${c.reset}` +
      `  ${runScore.padEnd(7)}` +
      `  co=${companyTag}  role=${roleTag}  loc=${locationTag}` +
      `  ${c.dim}${testCase.description}${c.reset}` +
      regressionSuffix
    );

    if (sc.isRegression || verbose) {
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        const correctMark = r.isMatch === testCase.golden.isMatch
          ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
        console.log(
          `         run${i + 1}: ${correctMark}` +
          `  isMatch=${r.isMatch}  company=${JSON.stringify(r.company)}  role=${JSON.stringify(r.role)}  location=${JSON.stringify(r.location)}` +
          (r.error ? `  ${c.red}ERROR: ${r.error}${c.reset}` : "")
        );
      }
    }

    if (sc.isRegression) {
      regressions++;
      regressionList.push(testCase.id);
    }
  }

  // ── Summary ──
  const passed = cases.length - regressions;
  const pct    = cases.length > 0 ? ((passed / cases.length) * 100).toFixed(1) : "0.0";
  const resultColor = regressions === 0 ? c.green : c.red;

  console.log(`\n${c.dim}${"─".repeat(58)}${c.reset}\n`);
  console.log(`${c.bold}Summary${c.reset}`);
  console.log(`  Total cases      : ${cases.length}`);
  console.log(`  ${resultColor}Passed (isMatch)  : ${passed} / ${cases.length}  (${pct}%)${c.reset}`);
  console.log(`  ${regressions > 0 ? c.red : c.dim}Regressions      : ${regressions}${c.reset}`);

  if (companyAsserts > 0) {
    const cpct = ((companyCorrectTotal / companyAsserts) * 100).toFixed(1);
    const ccol = companyCorrectTotal === companyAsserts ? c.green : c.yellow;
    console.log(`  ${ccol}Company extract  : ${companyCorrectTotal}/${companyAsserts}  (${cpct}%)${c.reset}`);
  }
  if (roleAsserts > 0) {
    const rpct = ((roleCorrectTotal / roleAsserts) * 100).toFixed(1);
    const rcol = roleCorrectTotal === roleAsserts ? c.green : c.yellow;
    console.log(`  ${rcol}Role extract     : ${roleCorrectTotal}/${roleAsserts}  (${rpct}%)${c.reset}`);
  }
  if (locationAsserts > 0) {
    const lpct = ((locationCorrectTotal / locationAsserts) * 100).toFixed(1);
    const lcol = locationCorrectTotal === locationAsserts ? c.green : c.yellow;
    console.log(`  ${lcol}Location extract : ${locationCorrectTotal}/${locationAsserts}  (${lpct}%)${c.reset}`);
  }

  if (regressionList.length > 0) {
    console.log(`\n${c.red}Regressed cases: ${regressionList.join(", ")}${c.reset}`);
  }

  console.log();
  process.exit(regressions > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(2);
});
