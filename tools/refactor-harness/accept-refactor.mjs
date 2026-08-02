#!/usr/bin/env node
/**
 * Decides whether a refactor of quality-gate-sgd preserved its behaviour, by
 * comparing a post-refactor capture against the frozen golden baseline.
 *
 *   node accept-refactor.mjs <baseline.json> <candidate.json>
 *
 * This is OUR validation harness. It is not, and must not become, a change to
 * how the tool itself compares runs -- the tool's ratchet semantics are the
 * subject under test, not the instrument.
 *
 * Checks run cheapest-and-sharpest first: liveness before content, exact
 * equality before tolerant set logic. A vacuous run must never be reported as
 * a pass, so liveness is a hard precondition rather than one signal among many.
 *
 * Exit: 0 accepted | 1 regression | 2 vacuous (nothing was proven either way)
 */

import { readFileSync } from "node:fs";

const [basePath, candPath] = process.argv.slice(2);
if (!basePath || !candPath) {
  console.error("usage: node accept-refactor.mjs <baseline.json> <candidate.json>");
  process.exit(2);
}

const base = JSON.parse(readFileSync(basePath, "utf8"));
const cand = JSON.parse(readFileSync(candPath, "utf8"));

const GATED_DIMENSIONS = ["eslint", "typescript", "coverage"];

const findings = [];
const fail = (check, detail) => findings.push({ severity: "REGRESSION", check, detail });
const note = (check, detail) => findings.push({ severity: "REVIEW", check, detail });

// --- 1. liveness: did both sides actually measure anything? -----------------
const vacuous = [];
for (const dim of GATED_DIMENSIONS) {
  const vb = base?.liveness?.[dim]?.verdict ?? "not-measured";
  const vc = cand?.liveness?.[dim]?.verdict ?? "not-measured";
  if (vb !== "measured" || vc !== "measured") {
    vacuous.push(`${dim} (baseline=${vb}, candidate=${vc})`);
  }
}

if (vacuous.length > 0) {
  console.error("VACUOUS -- refactor is neither accepted nor rejected:\n");
  for (const v of vacuous) console.error(`  ${v} was not confirmed as measured`);
  console.error(
    "\nA dimension that did not run cannot testify to preservation. Fix the\n" +
      "measurement, recapture, and re-run this gate.",
  );
  process.exit(2);
}

// --- 2. exact equality where the refactor must change nothing ---------------
//
// Same subject, same underlying compiler/coverage tooling -- so anything other
// than an exact match here means the refactor altered a reading.
const exactSections = ["issues.typescript", "issues.coverage", "issues.sonarqube"];

const issueKey = (i) =>
  [i.file, i.line, i.column, i.source, i.dimension, i.code, i.message].join(" ");

const bag = (arr) => {
  const m = new Map();
  for (const x of arr ?? []) m.set(issueKey(x), (m.get(issueKey(x)) ?? 0) + 1);
  return m;
};

for (const section of exactSections) {
  const [mb, mc] = [bag(base[section]), bag(cand[section])];
  const lost = [...mb].filter(([k, n]) => n > (mc.get(k) ?? 0));
  const gained = [...mc].filter(([k, n]) => n > (mb.get(k) ?? 0));
  if (lost.length || gained.length) {
    fail(section, {
      baselineCount: (base[section] ?? []).length,
      candidateCount: (cand[section] ?? []).length,
      lost: lost.length,
      gained: gained.length,
      sampleLost: lost.slice(0, 3).map(([k]) => k),
      sampleGained: gained.slice(0, 3).map(([k]) => k),
    });
  }
}

// --- 3. lint: keyed by rule ID + severity, not file:line --------------------
//
// A refactor moves code. Keying findings by file:line would report that
// movement as regression, drowning the real signal. Rule ID + severity is the
// property that must survive: the same rules must still fire, at the same
// severities, the same number of times.
//
// Losses fail. Gains are surfaced for review rather than failed outright --
// a refactor that surfaces MORE findings has not lost coverage of the subject,
// but it has changed behaviour and someone should look at it.
const ruleCounts = (issues) => {
  const m = new Map();
  for (const i of issues ?? []) {
    const k = `${i.code ?? "(no-rule)"} @ sev=${i.severity ?? "?"}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};

const [rb, rc] = [ruleCounts(base["issues.eslint"]), ruleCounts(cand["issues.eslint"])];

const lostRules = [];
const shrunkRules = [];
for (const [rule, n] of rb) {
  const got = rc.get(rule) ?? 0;
  if (got === 0) lostRules.push({ rule, was: n });
  else if (got < n) shrunkRules.push({ rule, was: n, now: got });
}
const newRules = [...rc].filter(([rule]) => !rb.has(rule)).map(([rule, n]) => ({ rule, now: n }));
const grewRules = [...rc]
  .filter(([rule, n]) => rb.has(rule) && n > rb.get(rule))
  .map(([rule, n]) => ({ rule, was: rb.get(rule), now: n }));

if (lostRules.length) fail("eslint: rules stopped firing entirely", lostRules);
if (shrunkRules.length) fail("eslint: rules fire fewer times", shrunkRules);
if (newRules.length) note("eslint: rules not in baseline", newRules);
if (grewRules.length) note("eslint: rules fire more often", grewRules);

// --- 4. headline metrics --------------------------------------------------
const metricPaths = [
  ["eslint.errors", (m) => m?.eslint?.errors],
  ["eslint.warnings", (m) => m?.eslint?.warnings],
  ["typescript.errors", (m) => m?.typescript?.errors],
  ["coverage.unit.branches", (m) => m?.coverage?.unit?.branches],
  ["coverage.unit.statements", (m) => m?.coverage?.unit?.statements],
  ["coverage.unit.lines", (m) => m?.coverage?.unit?.lines],
  ["coverage.unit.functions", (m) => m?.coverage?.unit?.functions],
];

for (const [label, get] of metricPaths) {
  const [vb, vc] = [get(base.metrics), get(cand.metrics)];
  if (vb !== vc) fail(`metric ${label}`, { baseline: vb, candidate: vc });
}

// --- 5. the gate's own verdict on the subject ------------------------------
// If the tool's pass/fail decision flips, behaviour changed regardless of
// whether the underlying counts look similar.
if (JSON.stringify(base.evaluation) !== JSON.stringify(cand.evaluation)) {
  fail("evaluation verdict changed", { baseline: base.evaluation, candidate: cand.evaluation });
}

// --- report ---------------------------------------------------------------
const regressions = findings.filter((f) => f.severity === "REGRESSION");
const reviews = findings.filter((f) => f.severity === "REVIEW");

console.log(JSON.stringify({ regressions, reviews }, null, 2));

if (regressions.length > 0) {
  console.error(`\nREJECTED: ${regressions.length} regression(s).`);
  for (const r of regressions) console.error(`  - ${r.check}`);
  process.exit(1);
}

if (reviews.length > 0) {
  console.error(
    `\nACCEPTED WITH REVIEW: no regressions, but ${reviews.length} additive change(s) need a human look.`,
  );
  for (const r of reviews) console.error(`  - ${r.check}`);
  process.exit(0);
}

console.error("ACCEPTED: behaviour preserved across all gated dimensions.");
process.exit(0);
