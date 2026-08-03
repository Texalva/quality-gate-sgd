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
 * Exit: 0 accepted | 1 regression | 2 vacuous (nothing was proven either way)
 *
 *
 * Why the bar is byte-identity
 * ----------------------------
 * The subject is a frozen Apollo checkout (`verify-fixture.mjs` hashes it) and
 * the tool is deterministic against it (`compare.mjs` showed two runs
 * byte-identical across every section). Nothing in a capture is legitimately
 * variable: absolute paths are stripped, and the only timing lives in the
 * liveness block, which is excluded.
 *
 * So exact equality is not an aspiration here, it is the demonstrated normal
 * state, and any deviation is a behaviour change that needs explaining.
 *
 * This replaced a tolerant comparison that keyed lint findings by rule ID and
 * severity, on the reasoning that "a refactor moves code, so file:line
 * comparison would report movement as regression". That reasoning was simply
 * wrong: the refactor moves code in the TOOL, not in the frozen subject the
 * findings point at. The tolerance bought nothing and cost a great deal --
 * `verify-gate.mjs` shows every lint finding could be relocated to a fabricated
 * file with a rewritten message and still be ACCEPTED, along with ten other
 * mutations.
 *
 * The tolerant analysis survives below as DIAGNOSTICS. It explains the shape of
 * a difference for whoever reads the rejection; it no longer grants permission.
 *
 * Re-baselining is the deliberate escape hatch, and it should feel like one.
 * The rejection output names every differing section precisely so that adopting
 * a new golden means writing down a reason for each.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const [basePath, candPath] = process.argv.slice(2);
if (!basePath || !candPath) {
  console.error("usage: node accept-refactor.mjs <baseline.json> <candidate.json>");
  process.exit(2);
}

const GATED_DIMENSIONS = ["eslint", "typescript", "coverage"];

/**
 * Keys excluded from the equality check, each for a stated reason. Everything
 * else in a capture is compared, including fields added later -- the union of
 * both files' keys is walked rather than a list maintained here, so a new
 * capture field is gated by default instead of on remembering to add it.
 */
const NOT_COMPARED = {
  liveness:
    "Meta-evidence about whether measurement happened, not a measurement. Gated separately below, and its elapsedMs/byte fields vary between runs by nature.",
  captureSha:
    "Provenance of the instrument. Checked as a precondition below rather than diffed as a reading.",
  subject:
    "Provenance of the measured checkout. Also a precondition -- two readings of different subjects are not comparable at all, so reporting the difference as a regression would name the wrong culprit.",
};

const vacuous = [];
const findings = [];
const fail = (check, detail) => findings.push({ check, detail });

// --- 0. is this comparison capable of failing at all? -----------------------
//
// Checked before the files are even read. Handing the same path in twice is
// structurally incapable of producing a regression, so answering ACCEPTED to it
// launders a non-check into a pass -- the same vacuous-evidence failure this
// harness exists to catch, one level up.
//
// Compared by inode, not by pathname. `resolve()` is purely lexical, so a
// symlink, a hard link, or `/proc/self/cwd/...` yields two different strings
// naming one file, and a string comparison waves it through -- demonstrated
// with /proc/self/cwd against an earlier version of this check.
function fileIdentity(filePath) {
  try {
    const stat = statSync(filePath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    // Unreadable is a different complaint; let the read below raise it.
    return null;
  }
}

const [baseId, candId] = [fileIdentity(basePath), fileIdentity(candPath)];

if (resolve(basePath) === resolve(candPath) || (baseId !== null && baseId === candId)) {
  console.error("VACUOUS -- baseline and candidate are the same file:\n");
  console.error(`  ${resolve(basePath)}`);
  console.error(`  ${resolve(candPath)}`);
  console.error(`  (both are inode ${baseId})`);
  console.error("\nA self-comparison cannot fail, so it proves nothing. Capture a candidate first.");
  process.exit(2);
}

const base = JSON.parse(readFileSync(basePath, "utf8"));
const cand = JSON.parse(readFileSync(candPath, "utf8"));

// --- 1. same instrument? ----------------------------------------------------
//
// Two captures taken by different versions of capture.mjs differ for reasons
// that have nothing to do with the tool under test. That is not a regression
// and not a pass; it is a measurement of the instrument, so it exits vacuous.
if (base.captureSha !== cand.captureSha) {
  vacuous.push(
    `captured by different versions of capture.mjs ` +
      `(baseline=${String(base.captureSha).slice(0, 12)}, candidate=${String(cand.captureSha).slice(0, 12)})`,
  );
} else if (base.captureSha === undefined) {
  vacuous.push(
    "neither capture records which version of capture.mjs produced it, so their comparability is unknown",
  );
}

// --- 1b. same subject? ------------------------------------------------------
//
// `verify-fixture.mjs` checks this too, but only when somebody remembers to run
// it. Reading it out of the captures makes the gate self-enforcing, because a
// golden compared against a silently-changed subject reports confidence it has
// not earned -- and it does so in the ACCEPTED direction as readily as the
// other, since a drifted subject can just as easily produce matching numbers.
const subjectState = (capture) => capture.subject;

if (base.subject === undefined || cand.subject === undefined) {
  vacuous.push(
    'a capture does not record which subject state it measured, so the two cannot be shown to be comparable'
  );
} else if (base.subject.unreadable || cand.subject.unreadable) {
  // Both unreadable would otherwise compare EQUAL and sail through below.
  vacuous.push(
    `the subject checkout could not be read at capture time ` +
      `(baseline=${base.subject.unreadable ? 'unreadable' : 'ok'}, ` +
      `candidate=${cand.subject.unreadable ? 'unreadable' : 'ok'})`
  );
} else if (JSON.stringify(subjectState(base)) !== JSON.stringify(subjectState(cand))) {
  vacuous.push(
    `measured against different subject states ` +
      `(baseline head=${String(base.subject.head).slice(0, 10)} diff=${String(base.subject.trackedDiffSha).slice(0, 10)}, ` +
      `candidate head=${String(cand.subject.head).slice(0, 10)} diff=${String(cand.subject.trackedDiffSha).slice(0, 10)})`
  );
}

// --- 2. liveness: did both sides actually measure anything? -----------------
for (const dim of GATED_DIMENSIONS) {
  const vb = base?.liveness?.[dim]?.verdict ?? "not-measured";
  const vc = cand?.liveness?.[dim]?.verdict ?? "not-measured";
  if (vb !== "measured" || vc !== "measured") {
    vacuous.push(`${dim} was not confirmed as measured (baseline=${vb}, candidate=${vc})`);
  }
}

if (vacuous.length > 0) {
  console.error("VACUOUS -- refactor is neither accepted nor rejected:\n");
  for (const v of vacuous) console.error(`  ${v}`);
  console.error(
    "\nA dimension that did not run cannot testify to preservation, and captures\n" +
      "taken by different instruments cannot be compared. Fix the measurement,\n" +
      "recapture, and re-run this gate.",
  );
  process.exit(2);
}

// --- 3. does the tool still agree with the outside witness? -----------------
//
// The liveness probe re-runs each tool itself and counts findings from raw
// output, never consulting what the tool under test reported. Where those two
// counts agree in the baseline, that agreement is a real invariant and losing
// it means the tool is misreading output the probe read fine.
//
// Checked on BOTH captures, not just as a baseline-to-candidate diff. That is
// the point: section 4 compares the candidate against a golden, so it goes
// quiet the moment a broken reading is adopted AS the golden. This check does
// not, because its witness is outside both files.
//
// Both the ISSUE LIST and the METRIC are checked against the probe. Comparing
// only the issue list left the metric unwitnessed, and the metric is what the
// gate's ceilings read -- a rebaselined null, string, or NaN there would slip
// past and then be skipped as non-numeric by rules.ts, which is a pass.
//
// Coverage is absent: its probe counts files in the summary report (178) while
// the tool counts under-covered findings (279). Different quantities, so there
// is no agreement to preserve.
const CROSS_CHECKS = [
  {
    label: "eslint issue count",
    probe: (c) => c.liveness?.eslint?.messageCount,
    tool: (c) => c.liveness?.eslint?.toolReportedCount,
  },
  {
    label: "eslint error+warning total",
    probe: (c) => c.liveness?.eslint?.messageCount,
    tool: (c) =>
      c.metrics?.eslint === undefined
        ? undefined
        : c.metrics.eslint.errors + c.metrics.eslint.warnings,
  },
  {
    label: "typescript issue count",
    probe: (c) => c.liveness?.typescript?.errorCount,
    tool: (c) => c.liveness?.typescript?.toolReportedCount,
  },
  {
    label: "typescript error total",
    probe: (c) => c.liveness?.typescript?.errorCount,
    tool: (c) => c.metrics?.typescript?.errors,
  },
];

for (const check of CROSS_CHECKS) {
  const readings = {
    baseline: { probe: check.probe(base), tool: check.tool(base) },
    candidate: { probe: check.probe(cand), tool: check.tool(cand) },
  };

  if (readings.baseline.probe !== readings.baseline.tool) {
    // Not an invariant to preserve, then -- but say so out loud rather than
    // skipping in silence, because silence here looks identical to a pass.
    fail(`${check.label}: probe and tool disagreed in the BASELINE`, {
      ...readings.baseline,
      note: "The golden itself is suspect. This check cannot protect a reading whose baseline already disagrees.",
    });
    continue;
  }

  if (readings.candidate.probe !== readings.candidate.tool) {
    fail(`${check.label}: no longer matches the independent probe`, readings);
  }
}

// --- 3b. which dimensions actually discriminate? ----------------------------
//
// A dimension measuring zero on both sides contributes nothing. The probe sees
// zero because the subject is genuinely clean, the tool sees zero, and `0 === 0`
// holds however broken the adapter is -- a provider hardcoded to
// `{errors: 0, issues: []}` stays byte-identical and passes every check above.
//
// True of typescript against this fixture, which is a clean Apollo checkout.
// That coverage lives in `verify-ground-truth.mjs` instead, against a synthetic
// subject with three hand-derived type errors. Recorded here rather than left
// implied, because a check that cannot fail looks exactly like one that passed.
const inertDimensions = GATED_DIMENSIONS.filter(
  (dim) => (base[`issues.${dim}`] ?? []).length === 0 && (cand[`issues.${dim}`] ?? []).length === 0
);

// --- 4. exact equality of every measured section ----------------------------
const sectionKeys = [...new Set([...Object.keys(base), ...Object.keys(cand)])]
  .filter((k) => !(k in NOT_COMPARED))
  .sort();

const issueKey = (i) =>
  [i.file, i.line, i.column, i.source, i.dimension, i.code, i.message].join(" ");

/** Sorted deep copy, so an ordering-only difference can be named as one. */
const canonical = (v) => {
  if (Array.isArray(v)) {
    const looksLikeIssues =
      v.length > 0 && v.every((x) => x && typeof x === "object" && "file" in x);
    const mapped = v.map(canonical);
    return looksLikeIssues ? mapped.sort((x, y) => (issueKey(x) < issueKey(y) ? -1 : 1)) : mapped;
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  }
  return v;
};

const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);

const bag = (arr) => {
  const m = new Map();
  for (const x of arr ?? []) m.set(issueKey(x), (m.get(issueKey(x)) ?? 0) + 1);
  return m;
};

/** Distinct rule+severity pairs and their counts -- the readable shape of a lint change. */
const ruleCounts = (issues) => {
  const m = new Map();
  for (const i of issues ?? []) {
    const k = `${i.code ?? "(no-rule)"} @ sev=${i.severity ?? "?"}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};

/** Every leaf of a nested object, as dotted paths, so metric drift names itself. */
const leaves = (v, prefix = "") => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [[prefix, v]];
  return Object.entries(v).flatMap(([k, sub]) => leaves(sub, prefix ? `${prefix}.${k}` : k));
};

/** Why the two differ, in the most specific terms the section's shape allows. */
function diagnose(section, vb, vc) {
  if (Array.isArray(vb) && Array.isArray(vc)) {
    const orderOnly = eq(canonical(vb), canonical(vc));
    const [mb, mc] = [bag(vb), bag(vc)];
    const lost = [...mb].filter(([k, n]) => n > (mc.get(k) ?? 0));
    const gained = [...mc].filter(([k, n]) => n > (mb.get(k) ?? 0));

    const detail = {
      shape: orderOnly ? "SAME FINDINGS, DIFFERENT ORDER" : "FINDINGS DIFFER",
      baselineCount: vb.length,
      candidateCount: vc.length,
      lost: lost.length,
      gained: gained.length,
      sampleLost: lost.slice(0, 3).map(([k]) => k),
      sampleGained: gained.slice(0, 3).map(([k]) => k),
    };

    // Rule-level rollup, kept from the old tolerant gate. It answers "which
    // rules moved" far more legibly than three sample finding keys can.
    const [rb, rc] = [ruleCounts(vb), ruleCounts(vc)];
    const ruleDrift = [...new Set([...rb.keys(), ...rc.keys()])]
      .map((rule) => ({ rule, was: rb.get(rule) ?? 0, now: rc.get(rule) ?? 0 }))
      .filter((r) => r.was !== r.now);
    if (ruleDrift.length) detail.ruleDrift = ruleDrift;

    return detail;
  }

  const [lb, lc] = [new Map(leaves(vb)), new Map(leaves(vc))];
  const changed = [...new Set([...lb.keys(), ...lc.keys()])]
    .filter((path) => !eq(lb.get(path), lc.get(path)))
    .map((path) => ({ path, baseline: lb.get(path), candidate: lc.get(path) }));

  return changed.length ? { changed } : { baseline: vb, candidate: vc };
}

for (const section of sectionKeys) {
  if (eq(base[section], cand[section])) continue;
  fail(section, diagnose(section, base[section], cand[section]));
}

// --- report -----------------------------------------------------------------
console.log(
  JSON.stringify(
    {
      compared: sectionKeys,
      notCompared: NOT_COMPARED,
      crossChecked: CROSS_CHECKS.map((c) => c.label),
      noDiscriminatingPower: inertDimensions.length
        ? {
            dimensions: inertDimensions,
            why: "Zero findings on both sides, so every comparison of them holds regardless of whether the adapter works. An adapter hardcoded to return nothing would pass here.",
            coveredInstead: "tools/refactor-harness/verify-ground-truth.mjs, against a synthetic subject with hand-derived findings.",
          }
        : undefined,
      regressions: findings,
    },
    null,
    2,
  ),
);

for (const dim of inertDimensions) {
  console.error(
    `NO DISCRIMINATING POWER: ${dim} is zero on both sides, so nothing here could have caught a dead ${dim} adapter. ` +
      `verify-ground-truth.mjs is what covers it.`,
  );
}

if (findings.length > 0) {
  console.error(`\nREJECTED: ${findings.length} difference(s) from the golden baseline.`);
  for (const f of findings) console.error(`  - ${f.check}`);
  console.error(
    "\nThe subject is frozen and the tool is deterministic against it, so a\n" +
      "difference here is a behaviour change. If it is an intended one, re-baseline\n" +
      "deliberately and record why for each section named above.",
  );
  process.exit(1);
}

console.error(
  `ACCEPTED: ${sectionKeys.length} sections byte-identical, ` +
    `${GATED_DIMENSIONS.length} dimensions confirmed measured, ` +
    `${CROSS_CHECKS.length} readings cross-checked against an independent probe` +
    `${inertDimensions.length ? `, ${inertDimensions.length} dimension(s) inert (see above)` : ""}.`,
);
process.exit(0);
