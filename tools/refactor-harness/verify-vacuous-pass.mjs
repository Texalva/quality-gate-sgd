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
 * A custom dimension that genuinely works, carried alongside every sabotaged one.
 *
 * Without it, a chain that failed EVERY custom extractor would pass all the
 * custom cases below for the wrong reason. This one has to keep reporting 7.
 */
const WORKING_CUSTOM_DIMENSION = {
  path: "custom.okCount",
  displayName: "Working Count",
  direction: "lower-better",
  extractor: { type: "script", command: "echo 7" },
};

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
  {
    name: "custom extractor command not installed",
    stands_for:
      "A custom dimension pointed at a tool nobody installed. Worse than the others: `custom.*` is gated by a ceiling and never by a floor, and a lower-better dimension is at its BEST at zero -- so the harder this failed, the better the project scored.",
    dimension: "custom.brokenCount",
    expectKind: "crashed",
    customDimensions: [
      { ...WORKING_CUSTOM_DIMENSION },
      {
        path: "custom.brokenCount",
        displayName: "Broken Count",
        direction: "lower-better",
        extractor: { type: "script", command: "definitely-not-a-real-binary --count" },
      },
    ],
  },
  {
    name: "custom extractor pipeline fails upstream",
    stands_for:
      "The DOCUMENTED extractor shape is a pipeline: `grep -r any src/ | wc -l`. A shell reports only the LAST stage's exit status, so when grep cannot read its input, wc still succeeds at counting nothing and prints 0. Clean exit, parseable number, perfect lower-better score -- the original defect reached through a pipe.",
    dimension: "custom.brokenCount",
    expectKind: "crashed",
    customDimensions: [
      { ...WORKING_CUSTOM_DIMENSION },
      {
        path: "custom.brokenCount",
        displayName: "Broken Count",
        direction: "lower-better",
        extractor: {
          type: "script",
          command: "grep -r pattern no-such-directory/ | wc -l",
        },
      },
    ],
  },
  {
    name: "custom extractor pipeline succeeds throughout",
    stands_for:
      "The control for pipefail. If enabling it turned every pipeline into a failure, the case above would pass for the wrong reason.",
    dimension: null,
    expectKind: null,
    expectMetric: { name: "pipedCount", value: 2 },
    customDimensions: [
      { ...WORKING_CUSTOM_DIMENSION },
      {
        path: "custom.pipedCount",
        displayName: "Piped Count",
        direction: "lower-better",
        extractor: { type: "script", command: "printf 'a\\nb\\n' | wc -l" },
      },
    ],
  },
  {
    name: "config file declares a broken extractor",
    stands_for:
      "Everything above hands the dimensions in directly. This one makes the tool DISCOVER them, which is the path the CLI takes -- and until this batch nothing took it: extractAllMetricsAsync was exported and never called, so no custom extractor ran and every configured custom.* ceiling was skipped for want of a metric.",
    dimension: "custom.fromConfig",
    expectKind: "crashed",
    discoverConfig: true,
    sabotage: (dir) =>
      writeFileSync(
        join(dir, "quality-gate.config.mjs"),
        `export const customDimensions = [
  {
    path: 'custom.okCount',
    displayName: 'Working Count',
    direction: 'lower-better',
    extractor: { type: 'script', command: 'echo 7' },
  },
  {
    path: 'custom.fromConfig',
    displayName: 'From Config',
    direction: 'lower-better',
    extractor: { type: 'script', command: 'definitely-not-a-real-binary' },
  },
];
`
      ),
  },
  {
    name: "the SHIPPED CLI runs the config's extractors",
    stands_for:
      "The finding the library-level cases structurally could not reach: only extractAllMetricsAsync loads custom dimensions, and the CLI called the synchronous one. Every case above would have passed while the actual `quality-gate run` skipped every custom.* ceiling for want of a metric.",
    viaCli: true,
    expectCliFailure: /custom\.fromConfig could not be measured/,
    sabotage: (dir) =>
      writeFileSync(
        join(dir, "quality-gate.config.mjs"),
        `export const customDimensions = [
  {
    path: 'custom.fromConfig',
    displayName: 'From Config',
    direction: 'lower-better',
    extractor: { type: 'script', command: 'definitely-not-a-real-binary' },
  },
];
`
      ),
  },
  {
    name: "config file that will not load",
    stands_for:
      "A syntax error in the config used to return an empty dimension list, which deleted every custom.* ceiling and let the gate pass having enforced fewer rules than it was configured with. Now it refuses to run at all.",
    discoverConfig: true,
    expectThrow: /Failed to load quality gate config/,
    sabotage: (dir) =>
      writeFileSync(join(dir, "quality-gate.config.mjs"), "export const customDimensions = ["),
  },
  {
    name: "custom extractor succeeds but prints no number",
    stands_for:
      "A command that exits 0 having found nothing to read -- `cat report.json || echo missing`. The first number ANYWHERE in stdout was taken as the metric, and prose with no digits in it became 0.",
    dimension: "custom.brokenCount",
    expectKind: "unparseable-output",
    customDimensions: [
      { ...WORKING_CUSTOM_DIMENSION },
      {
        path: "custom.brokenCount",
        displayName: "Broken Count",
        direction: "lower-better",
        extractor: {
          type: "script",
          command: "cat does-not-exist.json 2>/dev/null || echo 'report missing'",
        },
      },
    ],
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
function runGateAgainst(subjectDir, customDimensions, discoverConfig) {
  // `discoverConfig` takes the route the CLI takes: extractAllMetricsAsync,
  // which finds and loads the project's config itself. The other route hands
  // the dimensions in, which tests the extractor but not the discovery.
  const extraction = discoverConfig
    ? `await metricsMod.extractAllMetricsAsync({
      scriptsToRun: [],
      skipSonarQube: true,
    })`
    : `metricsMod.extractAllMetrics({
      scriptsToRun: [],
      skipSonarQube: true,
      skipCustomDimensions: false,
      customDimensions: ${JSON.stringify(customDimensions)},
    })`;

  const script = `
    process.env.QUALITY_PROJECT_ROOT = ${JSON.stringify(subjectDir)};
    process.env.QUALITY_PROJECT_NAME = 'vacuous-pass-control';
    process.env.QUALITY_CACHE_FILE = ${JSON.stringify(join(subjectDir, ".qg-cache.json"))};

    const metricsMod = await import(${JSON.stringify(`${TOOL}/dist/metrics.js`)});
    const rulesMod = await import(${JSON.stringify(`${TOOL}/dist/rules.js`)});

    const metrics = ${extraction};
    const rules = rulesMod.loadRules({ coverageOnly: true, silent: true });
    const evaluation = rulesMod.evaluateRules(rules, metrics, undefined);

    process.stdout.write(JSON.stringify({
      status: evaluation.status,
      failedRuleTypes: evaluation.failedRules.map(r => r.type),
      failures: (metrics.measurementFailures ?? []).map(f => ({ kind: f.kind, dimension: f.dimension })),
      eslintErrors: metrics.eslint?.errors ?? null,
      typescriptErrors: metrics.typescript?.errors ?? null,
      custom: metrics.custom ?? null,
    }));
  `;

  // cwd matters for the custom extractors: their commands are relative to the
  // project being measured, not to wherever this harness was invoked from.
  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: subjectDir,
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

/**
 * Runs the actual `quality-gate run` BINARY, not the library.
 *
 * This is the only case here that exercises the product rather than a function
 * inside it, and it exists because of a gap the library-level cases could not
 * see: `extractAllMetricsAsync` is the only extraction path that loads custom
 * dimensions, and until this batch nothing called it. Every library-level test
 * above would have passed while the shipped CLI ran the synchronous version and
 * silently skipped every `custom.*` ceiling.
 *
 * The copy is turned into a git repository first because the gate refuses to run
 * without one -- `hasUncommittedChanges()` throws rather than assuming a clean
 * tree, which is a deliberate fix from an earlier batch.
 */
function runCliAgainst(subjectDir) {
  const g = (...args) =>
    spawnSync("git", args, { cwd: subjectDir, encoding: "utf8", stdio: "pipe" });

  g("init", "-q");
  g("config", "user.email", "harness@example.com");
  g("config", "user.name", "Harness");
  g("config", "commit.gpgsign", "false");
  // node_modules is a symlink into the real subject; committing through it would
  // pull in ~200 MB. The subject's own .gitignore already excludes it.
  g("add", "-A");
  g("commit", "-q", "-m", "subject under test");

  const proc = spawnSync(process.execPath, [join(TOOL, "dist", "cli.js"), "run", "--coverage-only"], {
    cwd: subjectDir,
    env: {
      ...process.env,
      QUALITY_PROJECT_ROOT: subjectDir,
      QUALITY_PROJECT_NAME: "vacuous-pass-cli",
      QUALITY_CACHE_FILE: join(subjectDir, ".qg-cache.json"),
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return { status: proc.status, output: (proc.stdout ?? "") + (proc.stderr ?? "") };
}

function withSabotagedCopy(sabotage, customDimensions, discoverConfig, viaCli) {
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
    if (viaCli) return runCliAgainst(work);
    return runGateAgainst(
      work,
      customDimensions ?? [WORKING_CUSTOM_DIMENSION],
      discoverConfig ?? false
    );
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
  control.eslintErrors === 2 &&
  control.custom?.okCount === 7;

results.push({
  name: "control: unsabotaged subject measures cleanly",
  passed: controlOk,
  detail: controlOk
    ? "no measurement failures; 3 tsc errors, 2 lint errors and custom.okCount=7 as designed"
    : `expected 0 failures / 3 tsc / 2 eslint / okCount 7, got ${control.failures.length} failures / ` +
      `${control.typescriptErrors} tsc / ${control.eslintErrors} eslint / ` +
      `okCount ${control.custom?.okCount}`,
});

// --- every sabotage must fail the gate ---------------------------------------
for (const sabotage of SABOTAGES) {
  const got = withSabotagedCopy(
    sabotage.sabotage,
    sabotage.customDimensions,
    sabotage.discoverConfig,
    sabotage.viaCli
  );

  // The shipped binary: judged on its exit status and what it printed, since
  // that is all a user or a CI job gets.
  if (sabotage.expectCliFailure) {
    const failedLoudly = got.status !== 0;
    const named = sabotage.expectCliFailure.test(got.output ?? "");
    const passed = failedLoudly && named;

    results.push({
      name: sabotage.name,
      passed,
      stands_for: sabotage.stands_for,
      detail: passed
        ? `exited ${got.status} and named the unmeasured dimension`
        : !failedLoudly
          ? `the CLI exited 0 -- a broken custom extractor passed the gate. Output: ${(got.output ?? "").slice(-500)}`
          : `exited ${got.status}, but never mentioned the dimension it failed to measure. ` +
            `Output: ${(got.output ?? "").slice(-700)}`,
    });
    continue;
  }

  // A config that will not load is not a measurement that failed -- there is no
  // per-dimension reading to attach a failure to, and every dimension it
  // declares is affected at once. So it refuses to run rather than reporting.
  // What matters is that the refusal names the cause.
  if (sabotage.expectThrow) {
    const passed = got.crashed === true && sabotage.expectThrow.test(got.stderr ?? "");

    results.push({
      name: sabotage.name,
      passed,
      stands_for: sabotage.stands_for,
      detail: passed
        ? "refused to run, naming the unloadable config"
        : got.crashed
          ? `threw, but not with the expected diagnosis: ${(got.stderr ?? "").slice(0, 300)}`
          : `expected a refusal matching ${sabotage.expectThrow}; the run COMPLETED instead ` +
            `with failures=${JSON.stringify(got.failures)}, custom=${JSON.stringify(got.custom)}`,
    });
    continue;
  }

  if (got.crashed) {
    results.push({
      name: sabotage.name,
      passed: false,
      detail: `the tool threw instead of reporting a measurement failure: ${got.stderr}`,
    });
    continue;
  }

  // A case carrying `expectMetric` is the reverse assertion: this must NOT be
  // reported as broken, and must produce a specific value. Without those, a
  // chain that called every run broken would score a perfect result.
  if (sabotage.expectMetric) {
    const { name, value } = sabotage.expectMetric;
    const got_value = got.custom?.[name];
    const passed = got.failures.length === 0 && got_value === value;

    results.push({
      name: sabotage.name,
      passed,
      stands_for: sabotage.stands_for,
      detail: passed
        ? `measured ${name}=${got_value} with no failures`
        : `expected ${name}=${value} and no failures; got ${name}=${got_value}, ` +
          `failures=${JSON.stringify(got.failures)}`,
    });
    continue;
  }

  const failure = got.failures.find((f) => f.dimension === sabotage.dimension);
  const failedOnMeasurement = got.failedRuleTypes.includes("measurement");

  // One broken dimension must not take the healthy ones down with it, or a
  // chain that gave up at the first failure would score perfectly here.
  const collateral = got.custom?.okCount !== 7;

  const passed =
    got.status === "fail" &&
    failedOnMeasurement &&
    failure?.kind === sabotage.expectKind &&
    !collateral;

  results.push({
    name: sabotage.name,
    passed,
    stands_for: sabotage.stands_for,
    detail: passed
      ? `${sabotage.dimension}: ${failure.kind}, gate failed on it`
      : collateral && failure?.kind === sabotage.expectKind
        ? `caught ${sabotage.dimension} but lost the healthy dimension too: okCount=${got.custom?.okCount}`
        : `expected gate=fail with a '${sabotage.expectKind}' measurement failure on ${sabotage.dimension}; ` +
          `got gate=${got.status}, failedRuleTypes=[${got.failedRuleTypes}], ` +
          `failures=${JSON.stringify(got.failures)}, ` +
          `eslintErrors=${got.eslintErrors}, typescriptErrors=${got.typescriptErrors}, ` +
          `custom=${JSON.stringify(got.custom)}`,
  });
}

// --- report -------------------------------------------------------------------
for (const r of results) {
  console.log(`${r.passed ? "ok  " : "FAIL"} ${r.name.padEnd(36)} ${r.detail}`);
}
console.log();

const escaped = results.filter((r) => !r.passed);

if (escaped.length === 0) {
  // Counted rather than assumed: the controls that must NOT fail are part of the
  // suite, and reporting them as caught breakages would overstate the coverage.
  const breakages = SABOTAGES.filter((s) => !s.expectMetric).length;
  const controls = results.length - breakages;

  console.log(
    `NO VACUOUS PASS: ${breakages} broken measurements all failed the gate, ` +
      `${controls} control(s) measured cleanly.`
  );
  process.exit(0);
}

console.error(`VACUOUS PASS REACHABLE: ${escaped.length} case(s).\n`);
for (const r of escaped) {
  console.error(`  ${r.name}`);
  if (r.stands_for) console.error(`    ${r.stands_for}`);
  console.error(`    ${r.detail}\n`);
}
process.exit(1);
