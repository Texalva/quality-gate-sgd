#!/usr/bin/env node
/**
 * Asserts the tool reads the synthetic subject exactly as designed.
 *
 *   node tools/refactor-harness/verify-ground-truth.mjs [tool-dir]
 *
 * The apollo-client golden baseline answers "did this change alter what the
 * tool measures?" -- a purely relative question. It cannot answer "is the
 * measurement CORRECT?", and it never will, because it is itself the tool's
 * own output. Two places that matters:
 *
 *   1. A replacement lint backend (biome) has no "before" to differ against,
 *      so differential testing cannot validate it at all. Ground truth can.
 *   2. apollo-client type-checks clean, so `parseTypescriptOutput()` is
 *      completely unexercised by the golden baseline. A refactor could break
 *      tsc parsing outright and the golden comparison would still ACCEPT.
 *
 * Every expected value below is hand-derived from the subject's source, not
 * copied from a previous run -- see GROUND-TRUTH.md for the derivations.
 * This file is the single source of truth for the numbers.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBJECT = join(HERE, "synthetic-subject");
const TOOL = resolve(process.argv[2] ?? join(HERE, "..", ".."));
const OUT = join(tmpdir(), `qg-ground-truth-${process.pid}.json`);

// --- expectations ----------------------------------------------------------

const EXPECTED = {
  // src/lint-issues.ts: 2 errors (eqeqeq, prefer-const) and 4 warnings
  // (no-explicit-any x2, no-console x2). Both severities, four rules.
  eslint: { errors: 2, warnings: 4 },
  eslintRules: {
    "eqeqeq @major": 1,
    "prefer-const @major": 1,
    "@typescript-eslint/no-explicit-any @minor": 2,
    "no-console @minor": 2,
  },

  // src/type-errors.ts: three errors at three distinct codes.
  typescriptErrors: 3,
  typescriptCodes: ["TS2322", "TS2554", "TS2339"],

  // 10 branches: classify's two ifs and its ternary (6), neverCalled's
  // ternary (2), orphan's ternary (2). 4 covered: n<0 both arms, n===0 false
  // arm, the "odd" arm. 7 functions, 1 covered. 16 statements, 4 covered.
  coverage: { statements: 25, branches: 40, functions: 14.28, lines: 21.42 },
};

// --- run -------------------------------------------------------------------

const capture = spawnSync(
  process.execPath,
  [join(HERE, "capture.mjs"), TOOL, SUBJECT, OUT],
  { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
);

if (capture.status !== 0) {
  console.error(`capture.mjs failed (status ${capture.status})`);
  console.error(capture.stderr?.slice(0, 2000));
  process.exit(2);
}

const got = JSON.parse(readFileSync(OUT, "utf8"));
rmSync(OUT, { force: true });

// --- assert ----------------------------------------------------------------

const failures = [];

// Key insertion order is not part of the contract -- a rule-count map is the
// same map whichever order eslint happened to emit its findings in.
const canonical = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? JSON.stringify(Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])))
    : JSON.stringify(v);

const check = (label, expected, actual) => {
  const [e, a] = [canonical(expected), canonical(actual)];
  if (e !== a) failures.push({ label, expected: e, actual: a });
};

// Liveness first: a subject that did not measure cannot confirm anything.
for (const dim of ["eslint", "typescript", "coverage"]) {
  const verdict = got.liveness?.[dim]?.verdict ?? "not-measured";
  if (verdict !== "measured") {
    console.error(`VACUOUS: ${dim} reported "${verdict}" -- nothing below is meaningful.`);
    process.exit(2);
  }
}

check("metrics.eslint.errors", EXPECTED.eslint.errors, got.metrics?.eslint?.errors);
check("metrics.eslint.warnings", EXPECTED.eslint.warnings, got.metrics?.eslint?.warnings);
check("metrics.typescript.errors", EXPECTED.typescriptErrors, got.metrics?.typescript?.errors);

for (const [key, value] of Object.entries(EXPECTED.coverage)) {
  check(`coverage.unit.${key}`, value, got.metrics?.coverage?.unit?.[key]);
}

// Rule ID *and* severity, because a lint adapter that keeps every finding but
// reports warnings as errors would satisfy a count-only assertion.
const ruleCounts = {};
for (const issue of got["issues.eslint"] ?? []) {
  const key = `${issue.code} @${issue.severity}`;
  ruleCounts[key] = (ruleCounts[key] ?? 0) + 1;
}
check("issues.eslint by rule+severity", EXPECTED.eslintRules, ruleCounts);

// Sorted, since emission order is not part of the contract being asserted.
const tsCodes = (got["issues.typescript"] ?? []).map((i) => i.code);
check("issues.typescript codes", [...EXPECTED.typescriptCodes].sort(), [...tsCodes].sort());

// Every tsc error must carry a usable location; a parser that finds the codes
// but drops line numbers would otherwise pass.
const locatedTs = (got["issues.typescript"] ?? []).filter(
  (i) => Number.isInteger(i.line) && i.line > 0 && Number.isInteger(i.column) && i.column > 0,
);
check("issues.typescript with valid locations", EXPECTED.typescriptErrors, locatedTs.length);

// --- report ----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`GROUND TRUTH VIOLATED -- ${failures.length} mismatch(es):\n`);
  for (const f of failures) {
    console.error(`  ${f.label}`);
    console.error(`    expected: ${f.expected}`);
    console.error(`    actual:   ${f.actual}\n`);
  }
  process.exit(1);
}

console.log("GROUND TRUTH OK: eslint 2e/4w across 4 rules, tsc 3 errors at 3 codes, coverage 25/40/14.28/21.42");
process.exit(0);
