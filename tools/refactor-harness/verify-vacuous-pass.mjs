#!/usr/bin/env node
/**
 * End-to-end negative control for the vacuous pass.
 *
 *   node tools/refactor-harness/verify-vacuous-pass.mjs [tool-dir]
 *
 * Everything else in this harness asks whether a change altered what the tool
 * measures. This asks the older and more basic question: when a measurement
 * genuinely BREAKS, does the gate say so?
 *
 * It is the only check here that breaks a real tool in a real subject and runs
 * the whole chain -- provider, extraction, rule evaluation -- against the
 * result. The unit tests cover the same ground with mocked subprocesses, which
 * is exactly the weakness: the original defect was in what a real spawnSync
 * returns, and no mock would have predicted `status: 0` alongside ENOBUFS, or
 * npm answering a missing script with the same exit code tsc uses for
 * diagnostics.
 *
 * It also gives the type-check dimension the discriminating power the Apollo
 * golden cannot. Apollo type-checks clean, so 0 == 0 there holds whether the
 * adapter works or is a stub returning nothing.
 *
 * Exit: 0 every sabotage was caught | 1 at least one produced a passing gate
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBJECT = join(HERE, "synthetic-subject");
const TOOL = resolve(process.argv[2] ?? join(HERE, "..", ".."));

/**
 * Each sabotage names the real-world event it stands in for, and every one of
 * them used to produce `{errors: 0}` and a green gate.
 *
 * `expectKind` is the MeasurementFailure the provider should classify it as.
 * Asserting the kind rather than just "some failure" is what stops a provider
 * that lumps everything into one bucket from passing: the kinds exist because
 * a missing tool, a crash, and a truncation need different responses.
 */
const SABOTAGES = [
  {
    name: "type-check script missing",
    stands_for:
      "Apollo Client ships `typecheck`; this tool shells `npm run type-check`. npm answers exit 1, the same code tsc uses for diagnostics, with no diagnostics in its output.",
    dimension: "typescript",
    expectKind: "tool-missing",
    sabotage: (dir) => editPackageJson(dir, (pkg) => delete pkg.scripts["type-check"]),
  },
  {
    name: "type-check binary not installed",
    stands_for: "A dependency-install failure, or a tool assumed present that is not.",
    dimension: "typescript",
    expectKind: "crashed",
    sabotage: (dir) =>
      editPackageJson(dir, (pkg) => {
        pkg.scripts["type-check"] = "definitely-not-a-real-binary --noEmit";
      }),
  },
  {
    name: "type-check killed mid-run",
    stands_for:
      "An OOM kill or an outer timeout inside a wrapper script. Exits NUMERICALLY, so nothing about the status says it died -- and type-check output is regex-scanned, so there is no parse step to notice the missing diagnostics.",
    dimension: "typescript",
    expectKind: "crashed",
    sabotage: (dir) =>
      editPackageJson(dir, (pkg) => {
        pkg.scripts["type-check"] = "exit 2";
      }),
  },
  {
    name: "eslint config malformed",
    stands_for:
      "The original incident: a broken config makes eslint exit 2 having linted nothing, printing no report. `stdout || '[]'` turned that into a clean project.",
    dimension: "eslint",
    expectKind: "crashed",
    sabotage: (dir) => writeFileSync(join(dir, "eslint.config.mjs"), "this is not valid javascript {"),
  },
  {
    name: "eslint config exports the wrong shape",
    stands_for:
      "A config that loads but is not a config. eslint fails after startup rather than during it.",
    dimension: "eslint",
    expectKind: "crashed",
    sabotage: (dir) => writeFileSync(join(dir, "eslint.config.mjs"), "export default 42;"),
  },
];

function editPackageJson(dir, mutate) {
  const path = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  mutate(pkg);
  writeFileSync(path, JSON.stringify(pkg, null, 2));
}

/**
 * Runs the tool's real pipeline against a subject directory.
 *
 * Deliberately NOT through capture.mjs: this needs the gate's verdict on a
 * broken subject, which is a different question from what capture.mjs records.
 */
function runGateAgainst(subjectDir) {
  const script = `
    process.env.QUALITY_PROJECT_ROOT = ${JSON.stringify(subjectDir)};
    process.env.QUALITY_PROJECT_NAME = 'vacuous-pass-control';
    process.env.QUALITY_CACHE_FILE = ${JSON.stringify(join(subjectDir, ".qg-cache.json"))};

    const metricsMod = await import(${JSON.stringify(`${TOOL}/dist/metrics.js`)});
    const rulesMod = await import(${JSON.stringify(`${TOOL}/dist/rules.js`)});

    const metrics = metricsMod.extractAllMetrics({
      scriptsToRun: [],
      skipSonarQube: true,
      skipCustomDimensions: true,
    });
    const rules = rulesMod.loadRules({ coverageOnly: true, silent: true });
    const evaluation = rulesMod.evaluateRules(rules, metrics, undefined);

    process.stdout.write(JSON.stringify({
      status: evaluation.status,
      failedRuleTypes: evaluation.failedRules.map(r => r.type),
      failures: (metrics.measurementFailures ?? []).map(f => ({ kind: f.kind, dimension: f.dimension })),
      eslintErrors: metrics.eslint?.errors ?? null,
      typescriptErrors: metrics.typescript?.errors ?? null,
    }));
  `;

  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (proc.status !== 0) {
    return { crashed: true, stderr: (proc.stderr ?? "").slice(0, 1200) };
  }

  try {
    return JSON.parse(proc.stdout);
  } catch {
    return { crashed: true, stderr: `unparseable output: ${proc.stdout.slice(0, 400)}` };
  }
}

function withSabotagedCopy(sabotage) {
  // node_modules is symlinked rather than copied: the subject's is ~200 MB and
  // copying it per sabotage would make this unrunnable.
  const dir = mkdtempSync(join(tmpdir(), "qg-vacuous-"));
  const work = join(dir, "subject");
  cpSync(SUBJECT, work, {
    recursive: true,
    dereference: false,
    filter: (src) => !src.includes("node_modules"),
  });
  symlinkSync(join(SUBJECT, "node_modules"), join(work, "node_modules"), "dir");

  try {
    if (sabotage) sabotage(work);
    return runGateAgainst(work);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- control: the unsabotaged subject must NOT report a measurement failure --
//
// Without this, a chain that reported every run as broken would score a perfect
// pass below. The synthetic subject genuinely fails its coverage floors -- that
// is what it is for -- so the assertion is specifically about the absence of a
// MEASUREMENT failure, not about the verdict.
const control = withSabotagedCopy(null);
const results = [];

if (control.crashed) {
  console.error("CONTROL CRASHED -- nothing below is interpretable:\n");
  console.error(control.stderr);
  process.exit(2);
}

const controlOk =
  control.failures.length === 0 &&
  control.typescriptErrors === 3 &&
  control.eslintErrors === 2;

results.push({
  name: "control: unsabotaged subject measures cleanly",
  passed: controlOk,
  detail: controlOk
    ? "no measurement failures; 3 tsc errors and 2 lint errors as designed"
    : `expected 0 failures / 3 tsc / 2 eslint, got ${control.failures.length} failures / ` +
      `${control.typescriptErrors} tsc / ${control.eslintErrors} eslint`,
});

// --- every sabotage must fail the gate ---------------------------------------
for (const sabotage of SABOTAGES) {
  const got = withSabotagedCopy(sabotage.sabotage);

  if (got.crashed) {
    results.push({
      name: sabotage.name,
      passed: false,
      detail: `the tool threw instead of reporting a measurement failure: ${got.stderr}`,
    });
    continue;
  }

  const failure = got.failures.find((f) => f.dimension === sabotage.dimension);
  const failedOnMeasurement = got.failedRuleTypes.includes("measurement");
  const passed = got.status === "fail" && failedOnMeasurement && failure?.kind === sabotage.expectKind;

  results.push({
    name: sabotage.name,
    passed,
    stands_for: sabotage.stands_for,
    detail: passed
      ? `${sabotage.dimension}: ${failure.kind}, gate failed on it`
      : `expected gate=fail with a '${sabotage.expectKind}' measurement failure on ${sabotage.dimension}; ` +
        `got gate=${got.status}, failedRuleTypes=[${got.failedRuleTypes}], ` +
        `failures=${JSON.stringify(got.failures)}, ` +
        `eslintErrors=${got.eslintErrors}, typescriptErrors=${got.typescriptErrors}`,
  });
}

// --- report -------------------------------------------------------------------
for (const r of results) {
  console.log(`${r.passed ? "ok  " : "FAIL"} ${r.name.padEnd(36)} ${r.detail}`);
}
console.log();

const escaped = results.filter((r) => !r.passed);

if (escaped.length === 0) {
  console.log(`NO VACUOUS PASS: ${SABOTAGES.length} broken measurements all failed the gate, control clean.`);
  process.exit(0);
}

console.error(`VACUOUS PASS REACHABLE: ${escaped.length} case(s).\n`);
for (const r of escaped) {
  console.error(`  ${r.name}`);
  if (r.stands_for) console.error(`    ${r.stands_for}`);
  console.error(`    ${r.detail}\n`);
}
process.exit(1);
