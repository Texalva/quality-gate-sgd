#!/usr/bin/env node
/**
 * Negative control for the acceptance gate.
 *
 *   node verify-gate.mjs [--verbose]
 *
 * `accept-refactor.mjs` reporting ACCEPTED is evidence only if it was capable
 * of reporting REJECTED. This mutates the frozen golden into things a broken
 * refactor would plausibly produce, and asserts the gate catches each one.
 *
 * That is not a hypothetical worry. An earlier version of the gate compared
 * lint findings by rule ID and severity alone, which meant every finding could
 * be relocated to a fabricated file with a rewritten message and the gate still
 * said ACCEPTED. Eleven of the twenty-one cases in the first run of this file
 * escaped it. They are kept here permanently, not deleted once fixed, because
 * the gate is the thing standing between a refactor and a silent behaviour
 * change -- if it weakens again, this is what notices.
 *
 * The `unmutated` control matters as much as the mutations: without it, a gate
 * that rejected everything unconditionally would score a perfect run.
 *
 * Exit: 0 all controls behaved | 1 at least one mutation escaped
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "accept-refactor.mjs");
const GOLDEN = join(HERE, "golden-A.json");

const VERBOSE = process.argv.includes("--verbose");

/** accept-refactor.mjs's exit codes, named so the table below reads as intent. */
const ACCEPT = 0;
const REJECT = 1;
const VACUOUS = 2;

const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));

/** Drops half the lint findings while keeping every tool-reported count consistent. */
function halveEslintFindings(capture) {
  const kept = capture["issues.eslint"].slice(0, 500);
  capture["issues.eslint"] = kept;
  capture["issues.summary"].eslint = kept.length;
  capture.liveness.eslint.toolReportedCount = kept.length;
  return capture;
}

/**
 * Every case states the real refactor defect it stands in for. A mutation
 * nobody can name a cause for is a test of the gate's arithmetic, not of its
 * usefulness.
 *
 * `mutate` produces the candidate. `mutateBaseline`, where present, mutates the
 * baseline too -- which is how the cases that survive a re-baseline are
 * expressed, since those are exactly the ones a candidate-only mutation cannot
 * reach.
 *
 * `escapedBefore` records which ones the rule-ID-keyed gate accepted. It is
 * documentation of what this file bought, not something the run checks.
 */
const CASES = [
  {
    name: "unmutated",
    why: "Control. The gate must still accept an unchanged capture, or every result below is meaningless.",
    expect: ACCEPT,
    mutate: (c) => c,
  },

  // ---- findings ----------------------------------------------------------
  {
    name: "eslint-findings-relocated",
    why: "A lint adapter that loses file/line/message fidelity while still emitting the right rules at the right severities.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      for (const issue of c["issues.eslint"]) {
        issue.file = "<SUBJECT>/src/fabricated.ts";
        issue.line = 1;
        issue.column = 1;
        issue.message = "mangled";
      }
      return c;
    },
  },
  {
    name: "eslint-order-shuffled",
    why: "Emission order changed -- findings collected per-rule instead of per-file, say. Order is what the user sees first.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      c["issues.eslint"].reverse();
      return c;
    },
  },
  {
    name: "eslint-rule-dropped",
    why: "One rule stops being reported entirely -- a severity filter applied one step too early.",
    expect: REJECT,
    mutate: (c) => {
      const doomed = c["issues.eslint"][0].code;
      c["issues.eslint"] = c["issues.eslint"].filter((i) => i.code !== doomed);
      return c;
    },
  },
  {
    name: "eslint-warnings-promoted-to-errors",
    why: "Severity mapping inverted in the adapter. Counts survive; what fails the gate changes completely.",
    expect: REJECT,
    mutate: (c) => {
      for (const issue of c["issues.eslint"]) {
        issue.severity = "major";
        issue.dimension = "eslint.errors";
      }
      return c;
    },
  },
  {
    name: "coverage-finding-dropped",
    why: "An off-by-one in coverage parsing. Coverage feeds FLOOR rules, so losing findings loosens the gate.",
    expect: REJECT,
    mutate: (c) => {
      c["issues.coverage"].pop();
      return c;
    },
  },
  {
    name: "typescript-finding-injected",
    why: "A type-check parser that starts matching its own tool's banner lines as diagnostics.",
    expect: REJECT,
    mutate: (c) => {
      c["issues.typescript"].push({
        file: "<SUBJECT>/src/x.ts",
        line: 1,
        column: 1,
        source: "typescript",
        dimension: "typescript.errors",
        code: "TS2322",
        severity: "major",
        message: "phantom",
      });
      return c;
    },
  },

  // ---- metrics -----------------------------------------------------------
  {
    name: "eslint-rootcauses-collapsed",
    why: "rootCauses is the metric the gate rewards improving. Collapsing 57 to 3 fakes the exact progress it scores.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      c.metrics.eslint.rootCauses = 3;
      return c;
    },
  },
  {
    name: "coverage-union-drifted",
    why: "Union coverage recomputed differently. Only the rounded `unit` figures were ever compared.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      c.metrics.coverage.union.branches = 99.9;
      return c;
    },
  },
  {
    name: "sloc-changed",
    why: "SLOC is a denominator for density metrics; a counting change silently rescales them.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      c.metrics.sloc = 1;
      return c;
    },
  },
  {
    name: "summary-desynced",
    why: "The headline count drifting from the findings array -- the single most misleading shape this tool can emit.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      c["issues.summary"].eslint = 0;
      return c;
    },
  },

  // ---- errors the capture recorded but the gate never read ---------------
  {
    name: "located-error-appeared",
    why: "An extractor now throws and returns partial results. Findings can look plausible while the run was broken.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      c.locatedError = "TypeError: cannot read properties of undefined";
      return c;
    },
  },
  {
    name: "metrics-error-appeared",
    why: "Same, one layer up: totals threw, and whatever the gate reads next is stale or absent.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      c.metricsError = "Error: boom";
      return c;
    },
  },
  {
    name: "evaluation-error-appeared",
    why: "Rule evaluation threw. The verdict object compares equal because it is simply the old one.",
    expect: REJECT,
    escapedBefore: true,
    mutate: (c) => {
      c.evaluationError = "Error: rules failed to load";
      return c;
    },
  },

  // ---- verdict -----------------------------------------------------------
  {
    name: "evaluation-flipped-to-pass",
    why: "The subject genuinely fails. A refactor that turns it green is the vacuous pass this whole effort exists to prevent.",
    expect: REJECT,
    mutate: (c) => {
      c.evaluation = { status: "pass", failedRules: [] };
      return c;
    },
  },

  // ---- liveness ----------------------------------------------------------
  {
    name: "liveness-block-missing",
    why: "A capture with no liveness evidence proves nothing, however well its numbers match.",
    expect: VACUOUS,
    mutate: (c) => {
      delete c.liveness;
      return c;
    },
  },
  {
    name: "eslint-not-measured",
    why: "The classic vacuous pass: matching zero findings on both sides because the linter never ran.",
    expect: VACUOUS,
    mutate: (c) => {
      c.liveness.eslint.verdict = "not-measured";
      return c;
    },
  },
  {
    name: "typescript-suspect",
    why: "Liveness could not be confirmed. Unconfirmed is not the same as fine.",
    expect: VACUOUS,
    mutate: (c) => {
      c.liveness.typescript.verdict = "suspect";
      return c;
    },
  },
  {
    name: "probe-and-tool-disagree",
    why: "The independent probe read 1038 findings from the same output the tool read 1038 from. If the tool's count moves and the probe's does not, the tool is misreading -- and its own numbers cannot report that.",
    expect: REJECT,
    // Caught before too, but only incidentally: dropping 538 findings also
    // shrank the rule counts. The cross-check now catches it for the right
    // reason, which matters because the wrong reason stops working the moment
    // a broken reading is adopted as the golden.
    mutate: (c) => {
      // Everything the tool reports moves together and stays self-consistent,
      // so only the outside witness can tell it is wrong.
      c["issues.eslint"] = c["issues.eslint"].slice(0, 500);
      c["issues.summary"].eslint = 500;
      c.liveness.eslint.toolReportedCount = 500;
      return c;
    },
  },
  {
    name: "broken-reading-adopted-as-the-golden",
    why: "The case the cross-check exists for, and the only one section comparison structurally cannot cover. Both sides are mutated identically, as they would be after someone re-baselined a refactor that halved the findings -- so every section matches, and the only witness left is the probe, which sits outside both files.",
    expect: REJECT,
    escapedBefore: true,
    mutateBaseline: (c) => halveEslintFindings(c),
    mutate: (c) => halveEslintFindings(c),
  },
  {
    name: "metric-turned-into-a-string",
    why: "`errorCount: \"7\"` from a malformed report made `errors` the STRING \"07\", which rules.ts rejects as non-numeric and then SKIPS -- and a skipped ceiling passes. A wrong type is a green build here, not a type error.",
    expect: REJECT,
    mutate: (c) => {
      c.metrics.eslint.errors = String(c.metrics.eslint.errors);
      return c;
    },
  },
  {
    name: "metrics-section-vanished",
    why: "The whole metrics object absent. Every ceiling reads undefined and is skipped, so the gate passes on no evidence whatsoever.",
    expect: REJECT,
    mutate: (c) => {
      delete c.metrics;
      return c;
    },
  },
  {
    name: "baseline-probe-and-tool-already-disagree",
    why: "If the golden itself fails the cross-check, the check cannot vouch for that dimension in any candidate. Saying so beats skipping quietly, because silence here is indistinguishable from a pass.",
    expect: REJECT,
    mutateBaseline: (c) => {
      c.liveness.eslint.messageCount = 999;
      return c;
    },
    mutate: (c) => c,
  },
  {
    name: "captured-by-a-different-instrument",
    why: "Comparing captures taken by two versions of capture.mjs measures the instrument, not the subject.",
    expect: VACUOUS,
    mutate: (c) => {
      c.captureSha = "0".repeat(64);
      return c;
    },
  },
  {
    name: "subject-moved-between-captures",
    why: "The subject was edited or checked out elsewhere between runs, so the two readings are of different things. A drifted subject can produce matching numbers as easily as differing ones, which is why this cannot be left to a comparison.",
    expect: VACUOUS,
    mutate: (c) => {
      c.subject = { ...c.subject, head: "f".repeat(40) };
      return c;
    },
  },
  {
    name: "subject-unreadable-in-both-captures",
    why: "Both captures failed to read the checkout, so their `subject` blocks match -- equal for the worst possible reason. Recording the failure is only useful if the gate refuses it rather than diffing it.",
    expect: VACUOUS,
    mutateBaseline: (c) => {
      c.subject = { head: null, trackedDiffSha: null, unreadable: true };
      return c;
    },
    mutate: (c) => {
      c.subject = { head: null, trackedDiffSha: null, unreadable: true };
      return c;
    },
  },
  {
    name: "subject-provenance-absent",
    why: "A capture predating subject stamping cannot be shown comparable to one that has it.",
    expect: VACUOUS,
    mutate: (c) => {
      delete c.subject;
      return c;
    },
  },
];

const workDir = mkdtempSync(join(tmpdir(), "qg-verify-gate-"));

function runGate(baselinePath, candidatePath) {
  const proc = spawnSync(process.execPath, [GATE, baselinePath, candidatePath], {
    encoding: "utf8",
  });
  return { code: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

const NAMES = { [ACCEPT]: "ACCEPT", [REJECT]: "REJECT", [VACUOUS]: "VACUOUS" };
const describe = (code) => NAMES[code] ?? `exit ${code}`;

const results = [];

for (const testCase of CASES) {
  const candidatePath = join(workDir, `${testCase.name}.candidate.json`);
  writeFileSync(candidatePath, JSON.stringify(testCase.mutate(structuredClone(golden)), null, 2));

  let baselinePath = GOLDEN;
  if (testCase.mutateBaseline) {
    baselinePath = join(workDir, `${testCase.name}.baseline.json`);
    writeFileSync(
      baselinePath,
      JSON.stringify(testCase.mutateBaseline(structuredClone(golden)), null, 2),
    );
  }

  const { code, stdout, stderr } = runGate(baselinePath, candidatePath);
  const passed = code === testCase.expect;
  results.push({ ...testCase, actual: code, passed, stdout, stderr });
}

// Passing the same file twice can never fail, so a gate that answers ACCEPT to
// it is answering a question nobody asked. Checked separately from the mutation
// table because these are properties of the INVOCATION rather than of any
// capture's contents.
{
  const aliasPath = join(workDir, "golden-alias.json");
  symlinkSync(GOLDEN, aliasPath);

  const invocations = [
    {
      name: "same-file-compared-with-itself",
      why: "A self-comparison is structurally incapable of failing; reporting ACCEPTED for it launders a non-check as a pass.",
      paths: [GOLDEN, GOLDEN],
    },
    {
      name: "same-file-reached-through-a-symlink",
      why: "Pathname comparison is lexical, so a link gives one file two names and the self-comparison guard misses it. Identity has to be established by inode.",
      paths: [GOLDEN, aliasPath],
    },
    {
      name: "same-file-reached-through-proc-self-cwd",
      why: "The same lexical hole via a synthetic path rather than a link -- reproduced against an earlier version of the guard, which answered ACCEPTED.",
      paths: [GOLDEN, `/proc/self/cwd/${relative(process.cwd(), GOLDEN)}`],
    },
  ];

  for (const invocation of invocations) {
    const { code, stderr } = runGate(...invocation.paths);
    results.push({
      ...invocation,
      expect: VACUOUS,
      actual: code,
      passed: code === VACUOUS,
      stderr,
      stdout: "",
    });
  }
}

rmSync(workDir, { recursive: true, force: true });

const escaped = results.filter((r) => !r.passed);

for (const r of results) {
  const mark = r.passed ? "ok  " : "FAIL";
  console.log(`${mark} ${r.name.padEnd(38)} expected ${describe(r.expect)}, got ${describe(r.actual)}`);
  if (VERBOSE && !r.passed) {
    console.log(`       ${r.why}`);
    console.log(r.stderr.split("\n").map((l) => `       | ${l}`).join("\n"));
  }
}

console.log();

if (escaped.length === 0) {
  const rejections = results.filter((r) => r.expect !== ACCEPT).length;
  console.log(`GATE VERIFIED: ${rejections} mutations rejected, control accepted.`);
  process.exit(0);
}

console.error(`GATE TOO WEAK: ${escaped.length} of ${results.length} case(s) behaved wrongly.\n`);
for (const r of escaped) {
  console.error(`  ${r.name}: expected ${describe(r.expect)}, got ${describe(r.actual)}`);
  console.error(`    ${r.why}\n`);
}
process.exit(1);
