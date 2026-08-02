/**
 * Capture one full set of readings from quality-gate-sgd against a subject project.
 *
 * Dumps every stage of the pipeline, RAW and UNSORTED. Sorting here would hide
 * ordering nondeterminism, which is one of the things this check is looking for.
 *
 *   node capture.mjs <tool-dir> <subject-dir> <out.json>
 */

import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [toolDir, subjectDir, outPath] = process.argv.slice(2);
if (!toolDir || !subjectDir || !outPath) {
  console.error("usage: node capture.mjs <tool-dir> <subject-dir> <out.json>");
  process.exit(2);
}

const TOOL = resolve(toolDir);
const SUBJECT = resolve(subjectDir);

// The tool reads all of its configuration from the environment at first use.
process.env.QUALITY_PROJECT_ROOT = SUBJECT;
process.env.QUALITY_PROJECT_NAME = "stability-subject";
process.env.QUALITY_CACHE_FILE = resolve(SUBJECT, ".quality-gate-cache.json");

const metricsMod = await import(`${TOOL}/dist/metrics.js`);
const targetsMod = await import(`${TOOL}/dist/targets/index.js`);
const rulesMod = await import(`${TOOL}/dist/rules.js`);

const started = Date.now();

// --- widest layer: individual findings, with locations -----------------------
let located = null;
let locatedError = null;
try {
  located = targetsMod.extractLocatedIssues({
    skipSonarQube: true,
    skipTypescript: false,
    skipEslint: false,
  });
} catch (e) {
  locatedError = String(e && e.stack ? e.stack : e);
}

// --- totals ------------------------------------------------------------------
let metrics = null;
let metricsError = null;
try {
  metrics = metricsMod.extractAllMetrics({
    scriptsToRun: [],          // skip running project scripts; they are not the parsing surface
    skipSonarQube: true,
    skipCustomDimensions: true,
  });
} catch (e) {
  metricsError = String(e && e.stack ? e.stack : e);
}

// --- verdict -----------------------------------------------------------------
let evaluation = null;
let evaluationError = null;
try {
  const rules = rulesMod.loadRules({ coverageOnly: true });
  evaluation = rulesMod.evaluateRules(rules, metrics ?? { scripts: {} }, undefined);
} catch (e) {
  evaluationError = String(e && e.stack ? e.stack : e);
}

// --- liveness: independent hard-evidence check --------------------------------
//
// The tool's own extractors convert a crashed OR timed-out linter into an empty
// findings array (`const output = result.stdout || '[]'`), so its own counts can
// never tell us whether it actually ran. Everything below re-spawns the SAME
// commands the tool spawns -- straight from this script, independent of
// `located`/`metrics` above -- and judges liveness from raw process evidence
// (exit code, byte counts, parseability, elapsed time), not from parsed finding
// counts. `located` is only consulted afterward, to sanity-check our count
// against the tool's, never to decide whether the tool ran.

const ESLINT_BUDGET_MS = 120_000;
const TSC_BUDGET_MS = 60_000;
// The liveness probe has to outlive the failure it is trying to detect. At
// spawnSync's 1 MiB default it truncates on exactly the large-output subjects
// where the tool silently zeroes out -- and would then agree with the tool for
// the very same wrong reason, which is worse than not checking at all.
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;
// Below this, "0 errors" is as likely an empty-include no-op as a genuine clean
// pass -- a real project-wide type-check takes measurable wall time.
const TSC_MIN_REAL_RUN_MS = 1_000;

function packageHasScript(subjectDir, scriptName) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(subjectDir, "package.json"), "utf-8"));
    return typeof pkg?.scripts?.[scriptName] === "string";
  } catch {
    return false;
  }
}

function captureEslintLiveness(subjectDir, toolReportedCount) {
  const t0 = Date.now();
  const result = spawnSync("npx", ["eslint", "--format", "json", "src/"], {
    cwd: subjectDir,
    encoding: "utf-8",
    shell: true,
    timeout: ESLINT_BUDGET_MS,
    maxBuffer: PROBE_MAX_BUFFER,
  });
  const elapsedMs = Date.now() - t0;
  const stdout = result.stdout ?? "";
  const stdoutBytes = Buffer.byteLength(stdout, "utf-8");
  const exitCode = result.status; // null on timeout or signal kill

  let parsedOk = false;
  let filesCount = null;
  let messageCount = null;
  try {
    const parsed = JSON.parse(stdout);
    parsedOk = Array.isArray(parsed);
    if (parsedOk) {
      filesCount = parsed.length;
      messageCount = parsed.reduce(
        (n, f) => n + (Array.isArray(f?.messages) ? f.messages.length : 0),
        0,
      );
    }
  } catch {
    parsedOk = false;
  }

  const nonZeroOrNullExit = exitCode === null || exitCode !== 0;
  const emptyStdout = stdoutBytes === 0;
  // Killed, rather than merely slow. A process that exits with its OWN status
  // code ran to completion, so elapsed time says nothing about whether the
  // measurement finished; a process that was killed may have been cut off
  // mid-output no matter how quickly it happened.
  //
  // This replaces an `elapsedMs > budget * 0.5` rule that ignored exit status
  // entirely. It was wrong in both directions: it flagged a clean 30.6s run
  // against a 60s budget whose output was byte-identical to a 25.0s run that
  // passed (a coin flip on machine load), and it cleared a killed process that
  // happened to die early.
  const killed = exitCode === null;
  // Evidence eslint actually enumerated real files, beyond a bare zero count.
  const workDoneEvidence = filesCount !== null && filesCount > 0;
  const zeroBoth = parsedOk && messageCount === 0 && toolReportedCount === 0;

  let verdict;
  if (nonZeroOrNullExit && emptyStdout) verdict = "not-measured";
  else if (!parsedOk) verdict = "not-measured"; // stdout didn't parse -> the tool would have silently swallowed this too
  else if (killed) verdict = "suspect";   // may have been cut off mid-output
  else if (zeroBoth && !workDoneEvidence) verdict = "suspect";
  else verdict = "measured";

  return {
    command: "npx eslint --format json src/",
    exitCode,
    stdoutBytes,
    parsedOk,
    filesCount,
    messageCount,
    elapsedMs,
    budgetMs: ESLINT_BUDGET_MS,
    killed,
    toolReportedCount,
    verdict,
  };
}

function captureTypescriptLiveness(subjectDir, toolReportedCount) {
  const scriptExists = packageHasScript(subjectDir, "type-check");

  const t0 = Date.now();
  const result = spawnSync("npm", ["run", "type-check"], {
    cwd: subjectDir,
    encoding: "utf-8",
    shell: true,
    timeout: TSC_BUDGET_MS,
    maxBuffer: PROBE_MAX_BUFFER,
  });
  const elapsedMs = Date.now() - t0;
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  const combinedBytes = Buffer.byteLength(combined, "utf-8");
  const exitCode = result.status;

  const errorRegex = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
  const errorCount = (combined.match(errorRegex) ?? []).length;

  const nonZeroOrNullExit = exitCode === null || exitCode !== 0;
  const emptyOutput = combinedBytes === 0;
  // See captureEslintLiveness: being killed implies possible truncation;
  // being slow does not.
  const killed = exitCode === null;

  // ...but a numeric exit code is NOT proof of completion. A wrapper script or
  // an outer timeout can abort mid-run and still exit numerically: a
  // `type-check` that self-aborted with 124 after 1.8s of a 3s budget emitted
  // only npm's banner, no diagnostics, and was accepted as `measured` when
  // `killed` was the sole signal.
  //
  // tsc reports 0 for clean and 2 for diagnostics found; 1 shows up from some
  // CLI-level failures. Anything else means the command did not finish as a
  // type-check, whatever its exit status claims. Unlike eslint, tsc output is
  // regex-scanned rather than parsed, so a truncated run still "reads" as zero
  // errors -- there is no parse step to catch it.
  const TSC_COMPLETION_EXITS = new Set([0, 1, 2]);
  const unexpectedExit = !killed && !TSC_COMPLETION_EXITS.has(exitCode);
  const workDoneEvidence = elapsedMs >= TSC_MIN_REAL_RUN_MS;
  const zeroBoth = errorCount === 0 && toolReportedCount === 0;

  let verdict;
  if (!scriptExists) verdict = "not-measured"; // absent script is itself a measurement failure
  else if (nonZeroOrNullExit && emptyOutput) verdict = "not-measured";
  else if (killed || unexpectedExit) verdict = "suspect"; // may have been cut off mid-output
  else if (zeroBoth && !workDoneEvidence) verdict = "suspect";
  else verdict = "measured";

  return {
    command: "npm run type-check",
    scriptExists,
    exitCode,
    combinedBytes,
    errorCount,
    elapsedMs,
    budgetMs: TSC_BUDGET_MS,
    killed,
    unexpectedExit,
    toolReportedCount,
    verdict,
  };
}

function captureCoverageLiveness(subjectDir, toolReportedCount) {
  const summaryPath = resolve(subjectDir, "coverage", "coverage-summary.json");
  const exists = existsSync(summaryPath);

  let byteSize = null;
  let parsedOk = false;
  let fileEntryCount = null;

  if (exists) {
    try {
      byteSize = statSync(summaryPath).size;
      const data = JSON.parse(readFileSync(summaryPath, "utf-8"));
      parsedOk = data !== null && typeof data === "object";
      if (parsedOk) {
        fileEntryCount = Object.keys(data).filter((k) => k !== "total").length;
      }
    } catch {
      parsedOk = false;
    }
  }

  const zeroBoth = parsedOk && fileEntryCount === 0 && toolReportedCount === 0;

  let verdict;
  if (!exists) verdict = "not-measured"; // coverage file missing
  else if (!parsedOk) verdict = "not-measured";
  else if (zeroBoth) verdict = "suspect";
  else verdict = "measured";

  return {
    path: summaryPath,
    exists,
    byteSize,
    parsedOk,
    fileEntryCount,
    toolReportedCount,
    verdict,
  };
}

const liveness = {
  eslint: captureEslintLiveness(SUBJECT, located?.eslint?.length ?? null),
  typescript: captureTypescriptLiveness(SUBJECT, located?.typescript?.length ?? null),
  coverage: captureCoverageLiveness(SUBJECT, located?.coverage?.length ?? null),
};

// Absolute paths differ by checkout location, not by behavior. Everything else
// is left exactly as produced.
const stripAbs = (o) =>
  JSON.parse(JSON.stringify(o ?? null).split(SUBJECT).join("<SUBJECT>").split(TOOL).join("<TOOL>"));

// The four issue arrays are hoisted to the top level so each one gets diffed
// as a set of findings rather than dumped whole on any difference.
writeFileSync(
  outPath,
  JSON.stringify(
    {
      "issues.coverage": stripAbs(located?.coverage ?? null),
      "issues.typescript": stripAbs(located?.typescript ?? null),
      "issues.eslint": stripAbs(located?.eslint ?? null),
      "issues.sonarqube": stripAbs(located?.sonarqube ?? null),
      "issues.summary": stripAbs(located?.summary ?? null),
      locatedError: stripAbs(locatedError),
      metrics: stripAbs(metrics),
      metricsError: stripAbs(metricsError),
      evaluation: stripAbs(evaluation),
      evaluationError: stripAbs(evaluationError),
      liveness: stripAbs(liveness),
    },
    null,
    2,
  ),
);

console.error(`captured -> ${outPath}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
