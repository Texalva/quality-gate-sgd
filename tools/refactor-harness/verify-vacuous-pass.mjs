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
 * the whole chain -- provider, extraction, rule evaluation, and for two cases the
 * shipped CLI including its cache -- against the result. Two of those layers have
 * no other coverage at all: nothing else in this repo runs `dist/cli.js`, and
 * nothing else can ask what the NEXT run reports, which is where an ungated
 * measurement failure went silent. The unit tests cover the same ground with
 * mocked subprocesses, which is exactly the weakness: the original defect was in
 * what a real spawnSync
 * returns, and no mock would have predicted `status: 0` alongside ENOBUFS, or
 * npm answering a missing script with the same exit code tsc uses for
 * diagnostics.
 *
 * It also gives the type-check dimension the discriminating power the Apollo
 * golden cannot. Apollo type-checks clean, so 0 == 0 there holds whether the
 * adapter works or is a stub returning nothing.
 *
 * Exit: 0 every sabotage was caught | 1 at least one produced a passing gate |
 * 2 a fixture stopped reproducing the condition it stands for, so its result is
 * not evidence either way
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBJECT = join(HERE, "synthetic-subject");
const TOOL = resolve(process.argv[2] ?? join(HERE, "..", ".."));

/**
 * Coverage output left in the subject by an earlier run, NOT copied into the
 * working directory each case gets.
 *
 * Both are gitignored, so whether they exist depends entirely on what was last run
 * in this checkout -- and they were being copied. MEASURED: `synthetic-subject/`
 * held a `coverage/` from a previous session, so every working copy started with a
 * readable 25% report that no case had asked for, and the first case here to depend
 * on the report being ABSENT reported a live measurement instead. Its probe caught
 * that, which is what probes are for, but the contamination is the root cause and
 * belongs here rather than in each case.
 *
 * Exact paths rather than a substring test: `src/lint-issues.ts` and the tool's own
 * `coverage.ts` both contain the word.
 *
 * The consequence for the control below is deliberate -- it now runs
 * `test:coverage` and grades a report THIS run wrote, instead of silently grading
 * whatever the checkout happened to be carrying.
 */
const STALE_REPORT_DIRS = [join(SUBJECT, "coverage"), join(SUBJECT, "coverage-lambda")];

/**
 * The parent environment with every variable this tool reads stripped out.
 *
 * The subject is a throwaway copy and the rules are injected per case, but the
 * ENVIRONMENT was inherited whole -- so the harness's answer depended on the shell
 * it was run from. MEASURED by an adversarial reviewer: running this file from a
 * project that exports `QUALITY_COVERAGE_REQUIRED=false` made a CORRECT
 * implementation report two failures, because the two cases that need the coverage
 * requirement ON silently ran with it off. The harness exited 1 while nothing was
 * wrong with the tool.
 *
 * That is the same class of defect as a fixture going inert, and worse in one way:
 * an inert fixture reports a false `ok`, whereas this reported a false FAILURE, so
 * the next person would go looking for a bug that was not there.
 *
 * Stripped by PREFIX rather than by an allowlist of known names, so a variable added
 * to config.ts later cannot silently start leaking in. Each case then sets exactly
 * what it means through `env`, and the generated script sets the rest.
 */
function hermeticEnv(extra = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("QUALITY_") && !key.startsWith("SONARQUBE_")
    )
  );
  return { ...clean, ...extra };
}

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
 * The two coverage numbers the ordering case tells apart.
 *
 * MEASURED, not chosen: `test:coverage` in the subject is `vitest run --coverage`
 * and the report it writes says `"statements":{"total":16,"covered":4,"pct":25}`,
 * which GROUND-TRUTH.md derives by hand from the source. 10 is planted because no
 * generation of this subject produces it, so "the gate said 10" can only mean it
 * graded the file that was there before the run.
 */
const SUBJECT_STATEMENTS_PCT = 25;
const PLANTED_STALE_PCT = 10;

/**
 * What the subject reports when coverage is pointed at its one branchless module.
 *
 * Hand-derived first, then MEASURED, and they agree. `src/lint-issues.ts` holds 5
 * statements (`console.log`, `console.warn`, `return a == b`, `let sum = 0`,
 * `return sum`) in 3 functions and NO branches at all -- no `if`, no ternary, no
 * `&&`. The case's own test calls `total()`, covering 2 of the 5. Measured output
 * of `vitest run --coverage` with `include: ["src/lint-issues.ts"]`:
 *
 *   statements {total: 5, covered: 2, pct: 40}
 *   functions  {total: 3, covered: 1, pct: 33.33}
 *   branches   {total: 0, covered: 0, pct: 100}
 *
 * That branches pct is istanbul's own 0/0 == 100 convention, so this fixture
 * cannot tell a synthesized 100 apart from istanbul's -- what it CAN tell apart is
 * the revision that dropped a zero-denominator dimension instead, where
 * `coverage.unit.branches` came back absent and every ceiling and monotonic rule
 * on it was silently skipped. The 40 beside it is the load-bearing half: it proves
 * the report was a live partial measurement rather than a zero-shaped one, which
 * `measured-nothing` would have refused.
 */
const BRANCHLESS_STATEMENTS_PCT = 40;
const BRANCHLESS_BRANCHES_PCT = 100;

/**
 * The ruleset of a project that gates its build and never asked for coverage.
 *
 * This is critical (ii)'s project: `typescript.errors` and `eslint.errors` gated,
 * no coverage rule anywhere, and a stray gitignored `coverage/` directory that
 * something else left behind.
 *
 * The thresholds are the subject's OWN hand-derived numbers (GROUND-TRUTH.md: 3
 * tsc errors across three codes, 2 eslint errors), because the cases using this
 * assert the gate comes back `pass` -- a ceiling of 0 would fail them for a reason
 * that has nothing to do with coverage, and they would then be unable to tell a
 * correctly-ignored measurement failure from a gate that failed anyway.
 *
 * `requiredScripts: []` for the same reason: a script rule is a third way to fail,
 * and this ruleset exists to leave exactly one candidate failure on the table.
 *
 * Used by two cases now -- the library-level ungated one, and the two-run CLI case,
 * which writes it to `rules.json` because the CLI loads its own rules. The absence
 * of a MONOTONIC rule is load-bearing for that second one: `monotonicSkipped`
 * suppresses caching on its own, so a monotonic rule here would make the second run
 * re-measure whether or not measurement failures suppress it.
 */
const GATES_BUILD_ONLY = {
  ceilings: { "typescript.errors": 3, "eslint.errors": 2 },
  requiredScripts: [],
};

/**
 * The same project the moment it adds one coverage floor.
 *
 * 50 is the value both embedded defaults and `init` write, and the subject's real
 * 25% is below it -- but that is not what the case asserts. It asserts the
 * MEASUREMENT failure becomes a failed rule now that something reads the
 * dimension, which is the half of DECISION 1 that the ungated case cannot see.
 */
const GATES_BUILD_AND_COVERAGE = {
  ...GATES_BUILD_ONLY,
  floors: { "coverage.unit.statements": 50 },
};

/**
 * Each sabotage names the real-world event it stands in for, and every one of
 * them used to produce `{errors: 0}` and a green gate.
 *
 * `expectKind` is the MeasurementFailure the provider should classify it as.
 * Asserting the kind rather than just "some failure" is what stops a provider
 * that lumps everything into one bucket from passing: the kinds exist because
 * a missing tool, a crash, and a truncation need different responses.
 *
 * `gateCeiling` is how a case says which rule grades the dimension it breaks. A
 * measurement failure becomes a failed RULE only when some rule reads that
 * dimension (see evaluateMeasurements): an unconditional failure hard-failed
 * projects over `coverage.lambda`, a suite the provider always attempts and
 * almost nobody has. The coverage-only defaults already gate `coverage.unit.*`,
 * `typescript.errors` and `eslint.errors`, so only the `custom.*` cases have to
 * supply one -- which is exactly the project their `stands_for` describes: a
 * custom dimension is gated by a ceiling and by nothing else.
 *
 * `gateRules` is the other half of that, and it exists because `gateCeiling` can
 * only ADD a rule. Two cases below need a ruleset with NO coverage rule in it at
 * all -- the project critical (ii) describes, which gates its type-checker and its
 * linter and never asked for coverage -- and that is a replacement of
 * `rules.rules`, not an addition to it. The pair is the point: whichever direction
 * is tested alone is satisfiable by a gating rule that answers the same way for
 * every dimension.
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
    gateCeiling: "custom.brokenCount",
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
    gateCeiling: "custom.brokenCount",
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
    // This case asserts ZERO failures of any kind, and it runs no scripts, so with
    // the stale `coverage/` no longer copied into the working directory there is
    // genuinely no coverage report for the gate to read. Declaring that is what a
    // project in this shape does; the alternative -- running `test:coverage` to
    // manufacture a report -- would add a full vitest run to a case that has nothing
    // to do with coverage. The zero-failure assertion stays intact for everything
    // this case is about.
    //
    // BOTH are needed, and the pair is instructive: the opt-out is honoured only
    // when no rule grades coverage, and the default ruleset here is
    // `loadRules({coverageOnly: true})`, which grades `coverage.unit.*`. Setting the
    // variable alone left the report required -- correctly -- and this case failed
    // with a `report-missing` it had no opinion about. So it also has to say that
    // its project grades the build and nothing else.
    env: { QUALITY_COVERAGE_REQUIRED: "false" },
    gateRules: GATES_BUILD_ONLY,
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
    gateCeiling: "custom.fromConfig",
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
    sabotage: (dir) => {
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
      );

      // The rules the CLI will load, because the CLI loads its own -- this case
      // cannot inject a ceiling the way the library-level ones do. `custom.*` is
      // gated by a ceiling and by nothing else, and a measurement failure becomes
      // a failed rule only when a rule reads the dimension, so without this file
      // the case would be asserting that the gate fails over a dimension the
      // project never asked it to grade.
      //
      // `requiredScripts: []` deliberately: the CLI substitutes `['quality']` for
      // an ABSENT requiredScripts, and the subject has no `quality` script, so
      // omitting it would add a phantom failing script to the run.
      writeFileSync(
        join(dir, "rules.json"),
        JSON.stringify(
          {
            version: "1.0.0",
            description: "gates the custom dimension this case breaks",
            rules: {
              ceilings: { "custom.fromConfig": 0 },
              requiredScripts: [],
            },
          },
          null,
          2
        )
      );
    },
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
    name: "coverage config matches no files",
    stands_for:
      "`coverage.include` still points at a directory a restructure renamed. The test suite passes, the report is written by the run itself, and every denominator in it is 0. istanbul computes each `pct` as percent(covered, total), which returns 100 for 0/0, so copying `total.<dim>.pct` through reported a project that measured NOTHING as fully covered -- satisfying every floor, including the 50/50 pair `init` generates.",
    dimension: "coverage.unit",
    expectKind: "measured-nothing",
    // The real path, not a planted file: the subject's own `vitest run --coverage`
    // writes the all-zero report during this run. What istanbul 3.2.7 actually
    // emits for it, measured rather than assumed, is
    // `{"total":{"lines":{"total":0,...,"pct":"Unknown"},...}}` with an empty
    // coverage-final.json beside it -- so the fixture also covers the non-numeric
    // `pct` that type-checked its way into a `number` field for years.
    scriptsToRun: ["test:coverage"],
    // The suite has to PASS. A coverage config matching nothing is not a broken
    // test run, and if the sabotage broke the run instead, this case would be
    // measuring that.
    expectScriptsPassing: ["test:coverage"],
    // And a dimension reported as unmeasurable must not simultaneously arrive as
    // a number: that combination is the vacuous pass with a warning attached.
    expectNoCoverageMetrics: true,
    sabotage: (dir) => pointCoverageAtNothing(dir),
    fixtureProbe: (dir) => requireNothingMeasured(dir),
  },
  {
    name: "coverage graded from the PREVIOUS run",
    stands_for:
      "extractAllMetrics built its result as one object literal, and JS evaluates literal properties top-to-bottom -- so `coverage:` read coverage-summary.json BEFORE `scripts:` ran the very npm scripts that rewrite it. The gate graded the previous generation of the code and reported it as this one.",
    // `test:coverage` in the subject is `vitest run --coverage`, so the report on
    // disk after the run is the real 25%, not the 10% planted below.
    scriptsToRun: ["test:coverage"],
    expectScriptsPassing: ["test:coverage"],
    expectCoverage: {
      statements: SUBJECT_STATEMENTS_PCT,
      notStatements: PLANTED_STALE_PCT,
      provenance: "the gate's own run of `test:coverage` produced",
    },
    sabotage: (dir) => plantStaleCoverageReport(dir),
    fixtureProbe: (dir) => requireReportRewrittenByRun(dir),
  },
  {
    name: "a codebase with no branches at all",
    stands_for:
      "A declarations-and-re-exports package, or any module with no conditional in it: real statements, zero branches. istanbul renders 0/0 as 100 and the revision that refused to launder that DROPPED the dimension instead -- which reshaped the vacuous pass rather than closing it, since evaluateFloors then failed forever on a floor `init` had just written while evaluateCeilings and evaluateMonotonic silently skipped theirs.",
    scriptsToRun: ["test:coverage"],
    expectScriptsPassing: ["test:coverage"],
    expectBranchlessCoverage: {
      branches: BRANCHLESS_BRANCHES_PCT,
      statements: BRANCHLESS_STATEMENTS_PCT,
    },
    sabotage: (dir) => pointCoverageAtBranchlessSource(dir),
    fixtureProbe: (dir) => requireBranchlessMeasurement(dir),
  },
  // --- #43: the report that was never written ---------------------------------
  //
  // Three cases, and the trio is the claim. The first is the defect: a ratchet
  // that cannot ratchet has to go red. The second is the false positive the fix
  // must not create: the same absence, for a project that grades no coverage rule,
  // is an advisory and not a verdict. The third is the escape hatch, without which
  // the second case's project pays an advisory and a lost cache on every run
  // forever. Any one of them alone is satisfiable by an implementation that gets
  // the other two wrong.
  //
  // All three run `test`, not `test:coverage`. That is the real event: the subject's
  // `test` is `vitest run` with no `--coverage`, so the script that
  // `requiredScripts` names EXITS 0 and writes nothing. Nothing here has to look
  // broken for the report to be missing.
  {
    name: "a coverage ratchet with no report",
    stands_for:
      "#43: a project whose only coverage rule is a monotonic ratchet, whose test script stopped writing a report -- a rename, a dropped --coverage flag, a reporter removed from the vitest config. An absent summary produced no metric AND no measurement failure, and evaluateFloors is the only evaluator that reports a missing metric: evaluateCeilings and evaluateMonotonic both `continue` on an undefined value. So the ratchet silently stopped ratcheting, the run still counted as having evaluated it, and the pass was cached as fully earned.",
    dimension: "coverage.unit",
    expectKind: "report-missing",
    // The ratchet is the ONLY coverage rule. A floor would prove nothing: a missing
    // floor metric has always failed loudly, which is the asymmetry this case is
    // about. There is no baseline either (the library path passes `undefined`), so
    // the monotonic rule cannot fail on its own comparison -- the only thing that
    // can turn this red is the measurement failure reaching a rule that reads the
    // dimension.
    gateRules: {
      ...GATES_BUILD_ONLY,
      monotonic: [{ direction: "up", metrics: ["coverage.unit.branches"] }],
    },
    scriptsToRun: ["test"],
    expectScriptsPassing: ["test"],
    // And the dimension must not arrive as a number as well: a reported failure
    // beside a fabricated 100% is the vacuous pass with a warning stapled to it.
    expectNoCoverageMetrics: true,
    sabotage: () => undefined,
    fixtureProbe: (dir) => requireNoCoverageReport(dir),
  },
  {
    name: "no report, and no coverage rule",
    stands_for:
      "The false positive the fix above must not create: a project that gates its type-checker and its linter, has no coverage directory, and never asked for any. Requiring the report unconditionally would fail it over a dimension no rule reads -- the same mistake that hard-failed two-suite projects on `coverage.lambda`. Rule scoping is what keeps the cost to an advisory.",
    dimension: "coverage.unit",
    expectKind: "report-missing",
    expectReportedButUngated: true,
    gateRules: GATES_BUILD_ONLY,
    scriptsToRun: ["test"],
    sabotage: () => undefined,
    fixtureProbe: (dir) => requireNoCoverageReport(dir),
  },
  {
    name: "the declared opt-out silences it",
    stands_for:
      "The escape hatch the case above needs: an ungated failure is printed on every run AND suppresses the cache write, so without a way to say `this project has no coverage`, a typescript-and-eslint-only project pays an advisory and a full re-measurement forever. QUALITY_COVERAGE_REQUIRED=false is that declaration, and it has to produce NO failure at all -- not a quieter one.",
    env: { QUALITY_COVERAGE_REQUIRED: "false" },
    gateRules: GATES_BUILD_ONLY,
    scriptsToRun: ["test"],
    // Three assertions, not one. `expectMetric` gives zero failures of any kind
    // alongside a real measurement -- the opt-out removes the failure rather than
    // demoting it, and does not take the other dimensions with it. The other two
    // close the ways this case was satisfiable by a wrong implementation: coverage
    // must still be ABSENT rather than fabricated as 100%, and the gate must PASS
    // rather than fail with nothing recorded.
    expectMetric: { name: "okCount", value: 7 },
    expectNoCoverageMetrics: true,
    expectGateStatus: "pass",
    sabotage: () => undefined,
    fixtureProbe: (dir) => requireNoCoverageReport(dir),
  },
  {
    name: "the opt-out cannot silence a graded ratchet",
    stands_for:
      "Reproduced by two independent adversarial reviews of the first version, which consulted QUALITY_COVERAGE_REQUIRED alone: set the opt-out, keep (or later add) a coverage ratchet, remove the report, and the provider returned neither a number nor a failure -- so evaluateMonotonic hit its silent `continue`, the gate reported pass with zero failed rules, and the pass was cached. The requirement was added to close exactly that, and an env var reopened it. The opt-out is a claim that the project has no coverage; a project that grades coverage has contradicted it, and the contradiction resolves toward measuring.",
    dimension: "coverage.unit",
    expectKind: "report-missing",
    // The opt-out is SET, and must not be honoured, because the ruleset below
    // grades coverage.
    env: { QUALITY_COVERAGE_REQUIRED: "false" },
    gateRules: {
      ...GATES_BUILD_ONLY,
      monotonic: [{ direction: "up", metrics: ["coverage.unit.branches"] }],
    },
    scriptsToRun: ["test"],
    expectScriptsPassing: ["test"],
    expectNoCoverageMetrics: true,
    sabotage: () => undefined,
    fixtureProbe: (dir) => requireNoCoverageReport(dir),
  },
  {
    name: "a configured second suite that wrote nothing",
    stands_for:
      "Reproduced by adversarial review. The first version hardcoded the lambda summary as never-required, because config.ts resolves the directory as `process.env.QUALITY_COVERAGE_LAMBDA_DIR || 'coverage-lambda'` and a project that asked for a second suite was indistinguishable from one that had never heard of the idea. So a project that DID configure one -- and gated it -- lost it in silence: no metric, no failure, pass, cached. The distinction now comes from config, not from the path.",
    dimension: "coverage.lambda",
    expectKind: "report-missing",
    // Explicitly configured, and deliberately not the `coverage-lambda` default:
    // a case that used the default would pass even if the fix only special-cased
    // that one string.
    env: { QUALITY_COVERAGE_LAMBDA_DIR: "coverage-integration" },
    gateRules: {
      ...GATES_BUILD_ONLY,
      ceilings: { ...GATES_BUILD_ONLY.ceilings, "coverage.lambda.branches": 100 },
    },
    // The UNIT report is written by this run and is fine. That is the point: one
    // suite measuring cleanly must not excuse the configured one that did not, and
    // it also proves the failure is not just "nothing was measured anywhere".
    scriptsToRun: ["test:coverage"],
    expectScriptsPassing: ["test:coverage"],
    sabotage: () => undefined,
    fixtureProbe: (dir) => requireNoConfiguredLambdaReport(dir),
  },
  {
    name: "broken coverage no rule grades",
    stands_for:
      "critical (ii): a project that gates its type-checker and its linter, never asked for coverage, and has a stray gitignored coverage/ directory holding a report a killed run left half-written. An unconditional measurement failure hard-failed it over a dimension no rule reads, with no way to opt out -- extractAllMetrics has skipSonarQube and skipCustomDimensions and nothing for coverage. Same shape as the two-suite project that hard-failed on `coverage.lambda`, which lambdaDir populates unconditionally.",
    dimension: "coverage.unit",
    expectKind: "unparseable-output",
    expectReportedButUngated: true,
    gateRules: GATES_BUILD_ONLY,
    scriptsToRun: [],
    sabotage: (dir) => plantCorruptCoverageReport(dir),
    fixtureProbe: (dir) => requireReportUnreadable(dir),
  },
  {
    name: "the same broken report under a floor",
    stands_for:
      "The other half of the pair, and the reason the half above is not evidence on its own: a filter answering 'no rule grades this' for EVERY dimension would pass that case while quietly disabling the loud channel for every project that does gate coverage. Same corrupt report, same subject, one floor added.",
    dimension: "coverage.unit",
    expectKind: "unparseable-output",
    gateRules: GATES_BUILD_AND_COVERAGE,
    scriptsToRun: [],
    sabotage: (dir) => plantCorruptCoverageReport(dir),
    fixtureProbe: (dir) => requireReportUnreadable(dir),
  },
  {
    name: "a failed suite under a UNION floor",
    stands_for:
      "`coverage.union.*` is COMPUTED from the unit and lambda summaries, and the prefix matcher treated `coverage.union` and `coverage.unit` as unrelated strings. So a project whose only coverage rule is a union floor had the lambda read failure demoted to an advisory, while mergeCoverageReports quietly summed the union from the unit suite ALONE and the gate graded that number. Exit 0 over a coverage figure derived from a report it could not read.",
    dimension: "coverage.lambda",
    expectKind: "unparseable-output",
    // The union floor is the ONLY coverage rule, and the number satisfies it: the
    // subject's unit suite really is 25%. The failure has to arrive through the
    // derivation edge or not at all -- nothing here names `coverage.lambda`.
    gateRules: {
      ceilings: { "typescript.errors": 3, "eslint.errors": 2 },
      floors: { "coverage.union.statements": 20 },
      requiredScripts: [],
    },
    scriptsToRun: ["test:coverage"],
    expectScriptsPassing: ["test:coverage"],
    sabotage: (dir) => plantCorruptLambdaReport(dir),
    fixtureProbe: (dir) => requireUnionSummedFromUnitAlone(dir),
  },
  {
    name: "the SAME ungated failure on a second run",
    stands_for:
      "The advisory for a dimension no rule grades is the ONLY report those failures get, and it was a one-shot. A run with an ungated failure wrote a cache entry, and the next run on the same commit took the cached-pass exit -- which prints `✓ Quality gate PASSED (cached)` and exits 0 without ever reading `metrics.measurementFailures`, which the entry demonstrably carried. So the day after a stray coverage-lambda directory appeared, CI went back to reporting a clean pass over a reading it never took.",
    viaCli: true,
    cliRuns: 2,
    // Only the library-level cases can be judged on `metrics`; this one is judged
    // on what the binary PRINTED on each of two runs, because that is all a CI job
    // and its human ever see -- and the defect lived entirely in which of two exits
    // the second run took.
    expectUngatedEveryRun: /coverage\.lambda \(unparseable-output\)/,
    sabotage: (dir) => {
      // The second suite, truncated: `coverage.lambda` is the dimension the tool
      // measures unconditionally and almost nobody configures a rule for, so it is
      // the shape an adopter actually meets. The unit report is left alone, so the
      // gate has a complete reading of everything it grades and PASSES -- which is
      // required, because only a pass reaches the exit this case is about.
      plantCorruptLambdaReport(dir);

      // The CLI loads its own rules, so this case cannot inject a ruleset the way
      // the library-level ones do. The same build-only project as the ungated
      // library case, with its hand-derived thresholds, and deliberately:
      //   - NO coverage rule, so the lambda failure is ungated (the derivation edge
      //     means a `coverage.union.*` rule would gate it -- see the union case).
      //   - `requiredScripts: []`, so no script rewrites a report mid-run and the
      //     working tree stays clean, which keeps both runs on one cache key.
      //   - NO monotonic rule, which is load-bearing: `monotonicSkipped` also
      //     suppresses caching, and with one configured the second run would
      //     re-measure whether or not measurement failures suppress it, and the case
      //     would pass against the defect.
      writeFileSync(
        join(dir, "rules.json"),
        JSON.stringify(
          {
            version: "1.0.0",
            description: "gates the build, never asked for coverage",
            rules: GATES_BUILD_ONLY,
          },
          null,
          2
        )
      );
    },
    fixtureProbe: (dir, got) => requireBothRunsOnOneCacheKey(dir, got),
  },
  {
    name: "custom extractor succeeds but prints no number",
    stands_for:
      "A command that exits 0 having found nothing to read -- `cat report.json || echo missing`. The first number ANYWHERE in stdout was taken as the metric, and prose with no digits in it became 0.",
    dimension: "custom.brokenCount",
    expectKind: "unparseable-output",
    gateCeiling: "custom.brokenCount",
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
 * Overwrites the subject's coverage summary with a report from a DIFFERENT,
 * worse generation of the code: 10% everywhere, where the truth is 25/40/14/21.
 *
 * CONTENT is the whole signal. The report is deliberately NOT backdated: nothing
 * in the gate judges a report's age (a rule that did was removed -- see the header
 * of this file's coverage cases and backlog #39), so a timestamp here would be
 * decoration, and a fixture whose distinguishing property the tool never reads is
 * how a case comes to pass for a reason nobody intended. 10% is chosen because no
 * generation of this subject produces it, so "the gate said 10" can only mean it
 * graded the file that was there before the run.
 *
 * The subject's coverage/ is gitignored, so a case must plant its own report
 * rather than assume one is there -- and must CREATE the directory, because
 * `writeFileSync` into a missing one throws ENOENT (measured: `threw: ENOENT ...
 * no such file or directory, open`). Without the mkdir this whole harness
 * crashes on any checkout that has never run the subject's tests, which is every
 * fresh clone and every CI job.
 */
function plantStaleCoverageReport(dir) {
  const entry = (pct) => ({ total: 100, covered: pct, skipped: 0, pct });
  mkdirSync(join(dir, "coverage"), { recursive: true });
  writeFileSync(
    join(dir, "coverage", "coverage-summary.json"),
    JSON.stringify({
      total: {
        statements: entry(PLANTED_STALE_PCT),
        branches: entry(PLANTED_STALE_PCT),
        functions: entry(PLANTED_STALE_PCT),
        lines: entry(PLANTED_STALE_PCT),
      },
    })
  );
}

/**
 * Plants a coverage report from a coverage run that died mid-write.
 *
 * Truncated rather than scrambled, because that is the shape a killed writer
 * leaves behind: valid JSON up to the byte it stopped at. The gate must call this
 * `unparseable-output` and must not confuse it with an ABSENT report, which is
 * silent by design -- `lambdaDir` defaults to `coverage-lambda`, a directory
 * almost nobody has, so treating absence as a failure would fail every
 * single-suite project.
 */
function plantCorruptCoverageReport(dir) {
  mkdirSync(join(dir, "coverage"), { recursive: true });
  writeFileSync(
    join(dir, "coverage", "coverage-summary.json"),
    '{"total":{"statements":{"total":16,"covered":4,"skipped":0,"pct":2'
  );
}

/**
 * The same half-written report, in the SECOND suite.
 *
 * `lambdaDir` defaults to `coverage-lambda` and the provider always attempts it,
 * so this is the two-suite project whose integration report a killed run left
 * truncated -- while the unit report is written cleanly by this run. That split is
 * the point: `mergeCoverageReports` sums `coverage.union` from whichever summaries
 * parsed, so the union number arrives looking like a measurement of the whole
 * project when one of its two inputs was never read.
 */
function plantCorruptLambdaReport(dir) {
  mkdirSync(join(dir, "coverage-lambda"), { recursive: true });
  writeFileSync(
    join(dir, "coverage-lambda", "coverage-summary.json"),
    '{"total":{"statements":{"total":16,"covered":4,"skipped":0,"pct":2'
  );
}

/**
 * Points the subject's coverage at its one module with no branches in it, and
 * gives that module a test.
 *
 * Two edits, because a branchless report is only worth grading if it is a LIVE
 * measurement. `src/lint-issues.ts` has 5 statements in 3 functions and no
 * conditional of any kind -- no `if`, no ternary, no `&&` -- so narrowing
 * `include` to it makes the branch denominator 0 while the statement denominator
 * stays real. The added test calls `total()`, covering 2 of those 5: without it the
 * whole report would read 0% beside a vacuous 100%, and the case could not tell a
 * live partial reading from a dead one.
 *
 * Rewrites the pattern rather than replacing the file, and says so instead of
 * quietly changing nothing when the pattern is gone -- same rule as
 * pointCoverageAtNothing, for the same reason: a sabotage that did not apply is an
 * inert fixture, not a passing case.
 */
function pointCoverageAtBranchlessSource(dir) {
  const configPath = join(dir, "vitest.config.ts");
  const before = readFileSync(configPath, "utf8");
  const after = before.replace('include: ["src/**/*.ts"]', 'include: ["src/lint-issues.ts"]');

  if (after === before) {
    return (
      `${configPath} no longer contains \`include: ["src/**/*.ts"]\`, so this case did not ` +
      "narrow coverage to a branchless module at all"
    );
  }

  writeFileSync(configPath, after);
  writeFileSync(
    join(dir, "tests", "branchless.test.ts"),
    `import { expect, test } from "vitest";

import { total } from "../src/lint-issues.js";

// Covers 2 of the 5 statements in the subject's one branchless module, so the
// report this case grades carries a real denominator beside the empty one.
test("total returns its initial sum", () => {
  expect(total()).toBe(0);
});
`
  );

  return undefined;
}

/**
 * Points the subject's coverage config at source that does not exist.
 *
 * This is how an adopter reaches an empty coverage report: `src/` gets renamed or
 * a package moves, `coverage.include` keeps the old glob, and the suite goes on
 * passing. Nothing about the run looks wrong -- vitest exits 0, writes both
 * reporters, and every number in them is 0.
 *
 * Rewrites the pattern rather than replacing the file, so the sabotage cannot
 * silently diverge from the rest of the subject's coverage configuration (which
 * provider, which reporters, which reportsDirectory). If the pattern it rewrites
 * is no longer there, it says so instead of quietly changing nothing -- a
 * sabotage that did not apply is an inert fixture, not a passing case.
 */
function pointCoverageAtNothing(dir) {
  const configPath = join(dir, "vitest.config.ts");
  const before = readFileSync(configPath, "utf8");
  const after = before.replace('include: ["src/**/*.ts"]', 'include: ["lib/**/*.ts"]');

  if (after === before) {
    return (
      `${configPath} no longer contains \`include: ["src/**/*.ts"]\`, so this case ` +
      "did not change the coverage configuration at all"
    );
  }

  writeFileSync(configPath, after);
  return undefined;
}

// --- fixture inertness -------------------------------------------------------
//
// Every probe below runs AFTER the gate, against the same copy the gate read,
// and returns a reason string when the fixture has stopped reproducing the
// condition its case is named for. That is not a failure -- it is worse than
// one: the case would report `ok` while testing nothing. So it exits 2, the same
// answer verify-baseline-resolution.mjs gives when its --depth 1 clone comes back
// not actually shallow.

/** The `total` section of the report ON DISK once the run is over. */
function coverageTotalOnDisk(dir) {
  const reportPath = join(dir, "coverage", "coverage-summary.json");

  let raw;
  try {
    raw = readFileSync(reportPath, "utf8");
  } catch (error) {
    return { why: `${reportPath} is not readable after the run (${error.code ?? error.message})` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { why: `${reportPath} is not JSON after the run (${raw.length} bytes)` };
  }

  if (!parsed?.total) {
    return { why: `${reportPath} has no \`total\` section after the run` };
  }

  return { total: parsed.total, statementsPct: parsed.total.statements?.pct };
}

/**
 * The missing-report cases: there must be NO coverage summary after the run.
 *
 * The condition these cases reproduce is absence, and absence is the easiest
 * fixture condition in this file to lose by accident -- anything that makes the
 * subject's `test` script write coverage, or leaves a report behind from an
 * earlier step, turns all three of them into assertions about a project that has
 * coverage after all. Checked with existsSync rather than through
 * coverageTotalOnDisk, because "unreadable" and "not there" are different
 * conditions and only the second one is this fixture's.
 */
function requireNoCoverageReport(dir) {
  const reportPath = join(dir, "coverage", "coverage-summary.json");
  if (!existsSync(reportPath)) return undefined;

  const seen = coverageTotalOnDisk(dir);
  return (
    `${reportPath} EXISTS after the run (${seen.why ?? `statements=${JSON.stringify(seen.statementsPct)}%`}), ` +
    "so this case is not exercising a project whose coverage report was never written"
  );
}

/**
 * The configured-second-suite case: the lambda directory must be absent, and the
 * UNIT report must be present.
 *
 * Both halves are the fixture. Without the second, the case degrades into "nothing
 * was measured anywhere", which the unit cases already cover and which a wrong
 * implementation could satisfy by requiring only the first suite.
 */
function requireNoConfiguredLambdaReport(dir) {
  const lambdaPath = join(dir, "coverage-integration", "coverage-summary.json");
  if (existsSync(lambdaPath)) {
    return (
      `${lambdaPath} EXISTS after the run, so this case is not exercising a configured ` +
      "second suite that wrote nothing"
    );
  }

  const unit = coverageTotalOnDisk(dir);
  if (unit.why) {
    return (
      `the UNIT report is not usable after the run (${unit.why}), so this case cannot show ` +
      "that a clean first suite fails to excuse a missing configured second one"
    );
  }
  return undefined;
}

/** The ordering case: the run must actually have replaced the planted report. */
function requireReportRewrittenByRun(dir) {
  const seen = coverageTotalOnDisk(dir);
  if (seen.why) return seen.why;

  if (seen.statementsPct === PLANTED_STALE_PCT) {
    return (
      `the planted ${PLANTED_STALE_PCT}% report is still on disk after the run, so ` +
      "`npm run test:coverage` no longer writes coverage and reading it before or after the " +
      "scripts is indistinguishable"
    );
  }
  if (seen.statementsPct !== SUBJECT_STATEMENTS_PCT) {
    return (
      `the subject's own coverage run now reports ${JSON.stringify(seen.statementsPct)}% ` +
      `statements rather than ${SUBJECT_STATEMENTS_PCT}%, so this case is comparing the gate's ` +
      "answer against a number that is no longer ground truth"
    );
  }
  return undefined;
}

/**
 * The branchless control: an EMPTY branch denominator beside a real, partly
 * covered statement denominator.
 *
 * Both halves are fixture conditions rather than assertions about the tool. A
 * branch denominator that came back non-zero means `include` is matching something
 * with a conditional in it and the case is not branchless; a statement denominator
 * of zero, or zero covered statements, means the 100 the gate reports would be
 * sitting beside a dead measurement, which is the `measured-nothing` case rather
 * than this one.
 */
function requireBranchlessMeasurement(dir) {
  const seen = coverageTotalOnDisk(dir);
  if (seen.why) return seen.why;

  const branches = seen.total.branches?.total;
  if (branches !== 0) {
    return (
      `the report this run wrote has ${JSON.stringify(branches)} branches in its denominator ` +
      "rather than 0, so `include` is matching a module with a conditional in it and nothing " +
      "here exercises a branchless codebase"
    );
  }

  const statements = seen.total.statements;
  if (!(statements?.total > 0) || !(statements?.covered > 0)) {
    return (
      `the report this run wrote covers ${JSON.stringify(statements?.covered)} of ` +
      `${JSON.stringify(statements?.total)} statements, so the empty branch denominator would sit ` +
      "beside a dead measurement rather than a live one -- that is the measured-nothing case, not " +
      "this one"
    );
  }
  return undefined;
}

/**
 * The rule-scoping pair: the planted report must still be unreadable.
 *
 * Inverted, like the CI probe: here a report that PARSES is the inert fixture.
 * Both cases in the pair are about what happens to a coverage measurement that
 * failed, so a healthy reading would leave them asserting the gating rule against
 * a dimension that measured fine -- the ungated case would report `ok` for a gate
 * that passed because there was nothing wrong, and the gated one would go red for
 * the same reason.
 */
function requireReportUnreadable(dir) {
  const seen = coverageTotalOnDisk(dir);

  if (!seen.why) {
    return (
      `the planted report parsed after the run and reports ${JSON.stringify(seen.statementsPct)}% ` +
      "statements, so nothing in this case exercises a coverage measurement that FAILED"
    );
  }
  if (!seen.why.includes("not JSON")) {
    return `${seen.why} -- which is not the half-written report this case plants`;
  }
  return undefined;
}

/**
 * The union case: the union number the gate graded must really have been summed
 * from the unit suite alone.
 *
 * Two fixture conditions, and the case is evidence of nothing without both. The
 * lambda summary must still be unparseable -- a report that parses leaves no
 * failed measurement to be gated through the derivation edge. And the unit report
 * must be the live 25% this run wrote, because that is what makes the union floor
 * PASS as a number: if the union were failing its floor anyway, the gate would go
 * red without ever consulting the measurement failure, and the case would be
 * asserting nothing about the edge.
 */
function requireUnionSummedFromUnitAlone(dir) {
  const lambdaPath = join(dir, "coverage-lambda", "coverage-summary.json");
  let lambdaRaw;
  try {
    lambdaRaw = readFileSync(lambdaPath, "utf8");
  } catch {
    return `${lambdaPath} is gone after the run, so there is no failed lambda read to gate on`;
  }
  try {
    JSON.parse(lambdaRaw);
    return (
      `${lambdaPath} parses after the run (${lambdaRaw.length} bytes), so the lambda suite ` +
      "measured fine and nothing here exercises a failure reaching a union rule"
    );
  } catch {
    // Unparseable, as planted.
  }

  const seen = coverageTotalOnDisk(dir);
  if (seen.why) return seen.why;
  if (seen.statementsPct !== SUBJECT_STATEMENTS_PCT) {
    return (
      `the unit report says ${JSON.stringify(seen.statementsPct)}% statements rather than the ` +
      `${SUBJECT_STATEMENTS_PCT}% this run should have written, so the union floor of 20 may be ` +
      "failing on its own and the gate's verdict would not be about the derivation edge"
    );
  }
  return undefined;
}

/**
 * The two-run case: both runs must have been the SAME question.
 *
 * A cached-pass defect is only reachable when run 2 looks up the key run 1 wrote,
 * so this case's entire condition is that the key did not move between them. If it
 * did, run 2 re-measures for a reason that has nothing to do with caching and
 * prints the advisory again -- reporting `ok` for a build that has the defect.
 * MEASURED, not hypothetical: with the cache file inside the subject directory the
 * untracked file dirtied the tree and run 2 keyed on `wip:e3b0c44` instead of
 * `0692f2d`, and the case passed against a dist/ with the defect reintroduced. See
 * the note on runCliAgainst.
 *
 * Reads the RUN OUTPUT rather than the subject, which is why probes take the result
 * as a second argument: what a fixture reproduces here is a property of the two
 * invocations, and there is nothing on disk that records it.
 *
 * Also checks the planted report is still unreadable, for the reason the gating
 * pair's probe does: a lambda summary that parsed would leave no failed measurement
 * for anything to suppress, and the case would be asserting the advisory over a
 * healthy reading.
 */
function requireBothRunsOnOneCacheKey(dir, got) {
  const lambdaPath = join(dir, "coverage-lambda", "coverage-summary.json");
  let lambdaRaw;
  try {
    lambdaRaw = readFileSync(lambdaPath, "utf8");
  } catch {
    return `${lambdaPath} is gone after the runs, so there is no failed measurement to report`;
  }
  try {
    JSON.parse(lambdaRaw);
    return (
      `${lambdaPath} parses after the runs (${lambdaRaw.length} bytes), so the lambda suite ` +
      "measured fine and nothing here exercises a failure that has to be repeated"
    );
  } catch {
    // Unparseable, as planted.
  }

  const runs = got.cliRuns ?? [];
  if (runs.length !== 2) {
    return `this case needs exactly two CLI runs to compare; it made ${runs.length}`;
  }

  // Whichever line the CLI printed -- `Commit: <sha>` for a clean tree, `WIP
  // changes on <sha> (content: <hash>)` for a dirty one. Both identify the cache
  // key, and a case that silently switched from one to the other between runs is
  // exactly the failure this probe is for.
  const keyOf = (output) =>
    (/^Commit: (\S+)$/m.exec(output) ?? /^WIP changes on .*\(content: (\S+)\)$/m.exec(output))?.[1] ??
    null;

  const keys = runs.map((r) => keyOf(r.output));
  if (keys.some((k) => k === null)) {
    return (
      "at least one run printed no cache key line at all, so there is no evidence the two runs " +
      `asked the same question: keys=${JSON.stringify(keys)}`
    );
  }
  if (keys[0] !== keys[1]) {
    return (
      `run 1 keyed on ${keys[0]} and run 2 on ${keys[1]}, so run 2 could not have hit the entry ` +
      "run 1 wrote -- it re-measured for an unrelated reason, and would print the advisory again " +
      "even with the caching defect present"
    );
  }
  return undefined;
}

/** The empty-config case: the report the run wrote must measure nothing at all. */
function requireNothingMeasured(dir) {
  const seen = coverageTotalOnDisk(dir);
  if (seen.why) return seen.why;

  const measured = ["statements", "branches", "functions", "lines"]
    .map((dimension) => ({ dimension, denominator: seen.total[dimension]?.total }))
    .filter((d) => d.denominator !== 0);

  if (measured.length > 0) {
    return (
      "the report this run wrote still measures " +
      `${measured.map((d) => `${JSON.stringify(d.denominator)} ${d.dimension}`).join(", ")}, ` +
      "so the coverage configuration is matching files again and nothing here exercises an " +
      "empty measurement"
    );
  }
  return undefined;
}

/**
 * Runs the tool's real pipeline against a subject directory.
 *
 * Deliberately NOT through capture.mjs: this needs the gate's verdict on a
 * broken subject, which is a different question from what capture.mjs records.
 *
 * Takes the case OBJECT for the same reason withSabotagedCopy does: six positional
 * fields, four of them optional and three of them about the RULES rather than about
 * the measurement, is a call site where a silently-shifted argument would change
 * which ruleset a case was graded under without changing what it printed.
 */
function runGateAgainst(subjectDir, testCase) {
  const customDimensions = testCase.customDimensions ?? [WORKING_CUSTOM_DIMENSION];
  const discoverConfig = testCase.discoverConfig ?? false;
  const scriptsToRun = testCase.scriptsToRun ?? [];
  const gateCeiling = testCase.gateCeiling ?? null;
  const gateRules = testCase.gateRules ?? null;

  // `discoverConfig` takes the route the CLI takes: extractAllMetricsAsync,
  // which finds and loads the project's config itself. The other route hands
  // the dimensions in, which tests the extractor but not the discovery.
  //
  // `scriptsToRun` defaults to [] so every pre-existing case is unchanged. It is
  // a parameter at all because the coverage-ordering defect is only reachable
  // when the gate RUNS a script that rewrites a report it also reads -- which
  // the mocked unit tests structurally cannot express, since nothing there
  // actually writes a file.
  const extraction = discoverConfig
    ? `await metricsMod.extractAllMetricsAsync({
      scriptsToRun: ${JSON.stringify(scriptsToRun)},
      skipSonarQube: true,
      coverageAbsenceIsFailure,
    })`
    : `metricsMod.extractAllMetrics({
      scriptsToRun: ${JSON.stringify(scriptsToRun)},
      skipSonarQube: true,
      skipCustomDimensions: false,
      customDimensions: ${JSON.stringify(customDimensions)},
      coverageAbsenceIsFailure,
    })`;

  // Set BEFORE the tool is imported, and that ordering is the whole reason this is
  // a template rather than a spawn option: `getConfig` memoises on first call, so a
  // variable applied after any module has read config would be ignored without
  // changing anything the case prints.
  const caseEnv = Object.entries(testCase.env ?? {})
    .map(([key, value]) => `    process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join("\n");

  const script = `
    process.env.QUALITY_PROJECT_ROOT = ${JSON.stringify(subjectDir)};
    process.env.QUALITY_PROJECT_NAME = 'vacuous-pass-control';
    process.env.QUALITY_CACHE_FILE = ${JSON.stringify(join(subjectDir, ".qg-cache.json"))};
${caseEnv}

    const metricsMod = await import(${JSON.stringify(`${TOOL}/dist/metrics.js`)});
    const rulesMod = await import(${JSON.stringify(`${TOOL}/dist/rules.js`)});

    // RULES FIRST, then measure. The order is load-bearing now: whether an absent
    // coverage report is a failed measurement depends on whether any rule grades
    // coverage, so the effective ruleset has to exist before the measurement is
    // taken. It used to measure first, which cost nothing while every measurement
    // decision was rules-independent.
    const rules = rulesMod.loadRules({ coverageOnly: true, silent: true });

    // A whole ruleset in place of the defaults, for the cases that are about a
    // rule that is ABSENT. REPLACES rules.rules rather than merging into it:
    // merging can only ever add a rule, and 'this project has no coverage rule at
    // all' is not expressible that way.
    const gateRules = ${JSON.stringify(gateRules)};
    if (gateRules !== null) {
      rules.rules = gateRules;
    }

    // The rule that grades the dimension this case breaks. A measurement failure
    // becomes a failed rule only when something reads that dimension, so a case
    // whose dimension the coverage-only defaults never mention has to say which
    // rule its project would have written. See the note on SABOTAGES.
    const gateCeiling = ${JSON.stringify(gateCeiling)};
    if (gateCeiling !== null) {
      rules.rules.ceilings = { ...(rules.rules.ceilings ?? {}), [gateCeiling]: 0 };
    }

    // The SHIPPED resolver, imported rather than reimplemented. This decides
    // whether QUALITY_COVERAGE_REQUIRED=false is honoured, and it is honoured only
    // when no rule reads coverage. A harness that re-derived that rule would keep
    // reporting ok while the binary decided something else -- which is the same
    // class of defect as a fixture going inert.
    const coverageAbsenceIsFailure = rulesMod.coverageAbsenceIsFailure(rules);

    const metrics = ${extraction};

    const evaluation = rulesMod.evaluateRules(rules, metrics, undefined);

    process.stdout.write(JSON.stringify({
      status: evaluation.status,
      failedRuleTypes: evaluation.failedRules.map(r => r.type),
      failures: (metrics.measurementFailures ?? []).map(f => ({ kind: f.kind, dimension: f.dimension })),
      eslintErrors: metrics.eslint?.errors ?? null,
      typescriptErrors: metrics.typescript?.errors ?? null,
      custom: metrics.custom ?? null,
      scripts: metrics.scripts ?? null,
      coverage: metrics.coverage?.unit ?? null,
    }));
  `;

  // cwd matters for the custom extractors: their commands are relative to the
  // project being measured, not to wherever this harness was invoked from.
  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: subjectDir,
    env: hermeticEnv(),
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
 * The only cases here that exercise the product rather than a function inside it,
 * and they exist because of gaps the library-level cases could not see. One:
 * `extractAllMetricsAsync` is the only extraction path that loads custom
 * dimensions, and until this batch nothing called it -- every library-level test
 * above would have passed while the shipped CLI ran the synchronous version and
 * silently skipped every `custom.*` ceiling. Two: the CACHE. Whether a run is
 * remembered, and what a remembered run prints, is decided in cli.js and nowhere
 * else, so a defect in the cached-pass early exit is invisible to every case that
 * calls `evaluateRules` directly.
 *
 * The copy is turned into a git repository first because the gate refuses to run
 * without one -- `hasUncommittedChanges()` throws rather than assuming a clean
 * tree, which is a deliberate fix from an earlier batch.
 *
 * `runs` is how many times to invoke the binary against the same commit, for the
 * cases that are about what the SECOND run does. The commit is made once, before
 * the first run, so every run keys on the same cache key -- which is the whole
 * point, and is fragile enough to be worth stating: the cache file is written
 * OUTSIDE the subject directory deliberately. MEASURED with it inside, against a
 * dist/ that had the caching defect reintroduced:
 *
 *   RUN 1  Commit: 0692f2d                            ... PASSED  (advisory printed)
 *   RUN 2  WIP changes on 0692f2d (content: e3b0c44)   ... PASSED  (advisory printed)
 *   $ git status --porcelain
 *   ?? .qg-cache.json
 *
 * An untracked `.qg-cache.json` makes the tree dirty, so run 2 keys on a WIP
 * content hash instead of the commit, misses the cache it just wrote, re-measures
 * and prints the advisory again -- passing the case while the defect it exists to
 * catch is present. Put the file outside the repository and run 2 keys on
 * `0692f2d` and serves the entry, which is the condition the case needs.
 */
function runCliAgainst(subjectDir, runs = 1) {
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

  const cliRuns = [];
  for (let i = 0; i < runs; i += 1) {
    const proc = spawnSync(
      process.execPath,
      [join(TOOL, "dist", "cli.js"), "run", "--coverage-only"],
      {
        cwd: subjectDir,
        // hermeticEnv, not `...process.env`: an inherited QUALITY_* variable made
        // this harness's verdict depend on the shell it was launched from. See
        // hermeticEnv.
        env: hermeticEnv({
          QUALITY_PROJECT_ROOT: subjectDir,
          QUALITY_PROJECT_NAME: "vacuous-pass-cli",
          // Outside the subject: see the note above. `subjectDir` is
          // `<mkdtemp>/subject`, so this is the throwaway root, deleted with it.
          QUALITY_CACHE_FILE: join(subjectDir, "..", ".qg-cache.json"),
        }),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    cliRuns.push({ status: proc.status, output: (proc.stdout ?? "") + (proc.stderr ?? "") });
  }

  // `status`/`output` are the FIRST run's, so a single-run case reads exactly what
  // it read before this parameter existed.
  return { cliRuns, status: cliRuns[0].status, output: cliRuns[0].output };
}

/**
 * Runs one case against a throwaway copy of the subject.
 *
 * Takes the case OBJECT rather than five positional fields, because two of those
 * fields are now about the fixture rather than about the tool: a sabotage may
 * report that it could not be applied, and a case may carry a probe that reads
 * the subject one last time before the copy is deleted.
 */
function withSabotagedCopy(testCase) {
  // node_modules is symlinked rather than copied: the subject's is ~200 MB and
  // copying it per sabotage would make this unrunnable.
  const dir = mkdtempSync(join(tmpdir(), "qg-vacuous-"));
  const work = join(dir, "subject");
  cpSync(SUBJECT, work, {
    recursive: true,
    dereference: false,
    filter: (src) => !src.includes("node_modules") && !STALE_REPORT_DIRS.includes(src),
  });
  symlinkSync(join(SUBJECT, "node_modules"), join(work, "node_modules"), "dir");

  try {
    // A sabotage that returns a STRING is telling us it did not apply -- the
    // subject changed under it. Running the gate anyway would report a clean
    // measurement of an unsabotaged copy as a caught breakage.
    const notApplied = testCase.sabotage ? testCase.sabotage(work) : undefined;
    if (typeof notApplied === "string") return { inert: notApplied };

    const got = testCase.viaCli
      ? runCliAgainst(work, testCase.cliRuns ?? 1)
      : runGateAgainst(work, testCase);

    // Read the subject once more before the copy goes away. A fixture that has
    // stopped reproducing its condition must not be able to report a pass.
    //
    // The RESULT is passed too, because one fixture condition is not on disk at
    // all: whether two CLI runs asked the same question is only visible in what
    // they printed. Every other probe ignores the second argument.
    const inert = testCase.fixtureProbe ? testCase.fixtureProbe(work, got) : undefined;
    return typeof inert === "string" ? { ...got, inert } : got;
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
//
// `test:coverage` because the control has to WRITE the report it is then graded on.
// It used to run no scripts at all and pass anyway, on a `coverage/` that STALE_REPORT_DIRS
// now keeps out of the copy -- so the control's clean reading came from an artifact
// of whatever was last run in the checkout, and deleting that directory by hand
// would have broken the control with a message about coverage.
const control = withSabotagedCopy({ scriptsToRun: ["test:coverage"] });
const results = [];

/** Every case decided so far, in the order they ran. */
function printResults() {
  for (const r of results) {
    console.log(`${r.passed ? "ok  " : "FAIL"} ${r.name.padEnd(36)} ${r.detail}`);
  }
  console.log();
}

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
  const got = withSabotagedCopy(sabotage);

  // A fixture that no longer reproduces its condition is reported as exit 2 --
  // never as a pass, and never as a failure of the tool. The case would still
  // print `ok` for several of these (the ordering case whose subject stopped
  // writing coverage grades a planted report nobody rewrote and finds nothing
  // wrong with it), which is the same species of vacuous success this whole file
  // exists to catch.
  if (got.inert) {
    printResults();
    console.error(`FIXTURE NOT EXERCISING THE CONDITION: ${sabotage.name}\n`);
    console.error(`  ${got.inert}\n`);
    console.error(
      "  Nothing this case reports is evidence either way, so it is not a pass. Fix the fixture\n" +
        "  (or the subject it is built from) and run this again."
    );
    process.exit(2);
  }

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

  // The two-run case: the advisory for an ungated failure has to appear on EVERY
  // run, so it is judged on both invocations rather than on one.
  //
  // Four assertions, and each one is a way the case could otherwise pass wrongly.
  // Both runs must exit 0, because a gate that FAILED would never have reached the
  // cached-pass exit and the case would be about something else. Both must name the
  // dimension, which is the actual deliverable -- run 1 alone is the pre-fix
  // behaviour. And run 2 must not have taken the cache at all: `Using cached
  // result` absent is the mechanism, since a run that short-circuits there cannot
  // print the advisory no matter what else is true.
  if (sabotage.expectUngatedEveryRun) {
    const [first, second] = got.cliRuns;
    const named = (run) => sabotage.expectUngatedEveryRun.test(run.output ?? "");
    const servedFromCache = /Using cached result/.test(second.output ?? "");
    const passed =
      first.status === 0 &&
      second.status === 0 &&
      named(first) &&
      named(second) &&
      !servedFromCache;

    results.push({
      name: sabotage.name,
      passed,
      stands_for: sabotage.stands_for,
      detail: passed
        ? "both runs exited 0 and both named the unmeasured dimension; the second re-measured " +
          "rather than serving a cached pass"
        : first.status !== 0
          ? `the FIRST run exited ${first.status}, so it never reached the cached-pass path this ` +
            `case is about. Output: ${(first.output ?? "").slice(-600)}`
          : !named(first)
            ? `the first run never named the unmeasured dimension: ${(first.output ?? "").slice(-600)}`
            : servedFromCache
              ? "the second run served a CACHED pass, so the ungated failure was reported once and " +
                `never again: ${(second.output ?? "").slice(-500)}`
              : `the second run exited ${second.status} without naming the unmeasured dimension: ` +
                `${(second.output ?? "").slice(-600)}`,
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

  // Every remaining case may assert that specific npm scripts came back green.
  // For the coverage cases that is load-bearing: the graded number is only
  // attributable to the gate's own run if the suite that writes the report
  // PASSED, and a sabotage that broke the test run instead would otherwise look
  // like a catch.
  const scriptsPassed = (sabotage.expectScriptsPassing ?? []).every(
    (script) => got.scripts?.[script] === "pass"
  );

  // `expectCoverage` is the reverse assertion for the ordering defect: the gate
  // must report the number the scripts it ran actually produced, NOT the one
  // that was on disk when it started. Asserting the wrong value is absent as
  // well as the right one present, because "25" could also arrive from a
  // provider that ignored the planted file entirely.
  if (sabotage.expectCoverage) {
    const { statements, notStatements, provenance } = sabotage.expectCoverage;
    const got_value = got.coverage?.statements;
    const passed =
      got.failures.length === 0 &&
      got_value === statements &&
      got_value !== notStatements &&
      scriptsPassed &&
      got.custom?.okCount === 7;

    results.push({
      name: sabotage.name,
      passed,
      stands_for: sabotage.stands_for,
      detail: passed
        ? `graded coverage.unit.statements=${got_value} with no measurement failure -- the value ` +
          `${provenance}, not the ${notStatements} planted before it`
        : `expected coverage.unit.statements=${statements} (never ${notStatements}) with no failures; ` +
          `got ${got_value}, scripts=${JSON.stringify(got.scripts)}, ` +
          `failures=${JSON.stringify(got.failures)}, okCount=${got.custom?.okCount}`,
    });
    continue;
  }

  // A codebase with no branches is not a broken measurement. The gate must report
  // the empty dimension as fully covered -- 0 of 0 branches missed is complete
  // coverage of the branches there are -- rather than failing it or dropping it.
  //
  // Both numbers are asserted, and the second is the load-bearing one: a chain
  // that answered 100 to every coverage dimension would satisfy the first half
  // alone, and so would one that reported a zero-shaped report as fully covered,
  // which is the vacuous pass this file is named for.
  if (sabotage.expectBranchlessCoverage) {
    const { branches, statements } = sabotage.expectBranchlessCoverage;
    const gotBranches = got.coverage?.branches;
    const gotStatements = got.coverage?.statements;
    const passed =
      got.failures.length === 0 &&
      gotBranches === branches &&
      gotStatements === statements &&
      scriptsPassed &&
      got.custom?.okCount === 7;

    results.push({
      name: sabotage.name,
      passed,
      stands_for: sabotage.stands_for,
      detail: passed
        ? `branches=${gotBranches} over an empty denominator, beside a live statements=${gotStatements}`
        : `expected branches=${branches} and statements=${statements} with no failures; got ` +
          `coverage.unit=${JSON.stringify(got.coverage)}, scripts=${JSON.stringify(got.scripts)}, ` +
          `failures=${JSON.stringify(got.failures)}, okCount=${got.custom?.okCount}`,
    });
    continue;
  }

  // The ungated half of the rule-scoping pair: a measurement failure on a
  // dimension no rule reads must be REPORTED and must not fail the gate.
  //
  // Three assertions, and dropping any one of them makes this satisfiable by the
  // wrong implementation. The failure has to be present in
  // `metrics.measurementFailures` with the right kind, or a provider that simply
  // stopped noticing would pass. It must not appear in `failedRuleTypes`, which is
  // the filter's actual job. And the gate has to come back `pass`, because a
  // measurement nothing grades cannot change a verdict -- if it does, the advisory
  // channel has been wired into the loud one somewhere else.
  if (sabotage.expectReportedButUngated) {
    const failure = got.failures.find((f) => f.dimension === sabotage.dimension);
    const gradedIt = got.failedRuleTypes.includes("measurement");
    const passed =
      failure?.kind === sabotage.expectKind &&
      !gradedIt &&
      got.status === "pass" &&
      got.custom?.okCount === 7;

    results.push({
      name: sabotage.name,
      passed,
      stands_for: sabotage.stands_for,
      detail: passed
        ? `${sabotage.dimension}: ${failure.kind} reported, no rule reads it, gate passed`
        : failure === undefined
          ? `${sabotage.dimension} was not reported as unmeasured at all: ` +
            `failures=${JSON.stringify(got.failures)}, coverage.unit=${JSON.stringify(got.coverage)}`
          : gradedIt
            ? `the gate failed on a measurement no rule grades: failedRuleTypes=[${got.failedRuleTypes}], ` +
              `failures=${JSON.stringify(got.failures)}`
            : `expected gate=pass with '${sabotage.expectKind}' reported on ${sabotage.dimension}; ` +
              `got gate=${got.status}, failedRuleTypes=[${got.failedRuleTypes}], ` +
              `failures=${JSON.stringify(got.failures)}, okCount=${got.custom?.okCount}`,
    });
    continue;
  }

  // A case carrying `expectMetric` is the reverse assertion: this must NOT be
  // reported as broken, and must produce a specific value. Without those, a
  // chain that called every run broken would score a perfect result.
  if (sabotage.expectMetric) {
    const { name, value } = sabotage.expectMetric;
    const got_value = got.custom?.[name];

    // Two optional guards, and the case that needed them is the coverage opt-out.
    // "No failures and okCount=7" was satisfiable by an implementation that turned
    // an absent opted-out report into a fabricated 100% -- which is the vacuous pass
    // itself -- and by one that returned `status: "fail"` with no failure recorded.
    // A case whose whole claim is "nothing was measured and nothing broke" has to
    // say both halves out loud. Found by adversarial review of the case.
    const coverageAbsent =
      sabotage.expectNoCoverageMetrics !== true || got.coverage === null;
    const statusOk =
      sabotage.expectGateStatus === undefined || got.status === sabotage.expectGateStatus;

    const passed =
      got.failures.length === 0 && got_value === value && coverageAbsent && statusOk;

    results.push({
      name: sabotage.name,
      passed,
      stands_for: sabotage.stands_for,
      detail: passed
        ? `measured ${name}=${got_value} with no failures` +
          `${sabotage.expectNoCoverageMetrics === true ? ", coverage.unit absent rather than fabricated" : ""}` +
          `${sabotage.expectGateStatus === undefined ? "" : `, gate ${got.status}`}`
        : `expected ${name}=${value} and no failures` +
          `${sabotage.expectNoCoverageMetrics === true ? " and no coverage.unit number" : ""}` +
          `${sabotage.expectGateStatus === undefined ? "" : ` and gate=${sabotage.expectGateStatus}`}` +
          `; got ${name}=${got_value}, failures=${JSON.stringify(got.failures)}, ` +
          `coverage.unit=${JSON.stringify(got.coverage)}, gate=${got.status}`,
    });
    continue;
  }

  const failure = got.failures.find((f) => f.dimension === sabotage.dimension);
  const failedOnMeasurement = got.failedRuleTypes.includes("measurement");

  // One broken dimension must not take the healthy ones down with it, or a
  // chain that gave up at the first failure would score perfectly here.
  const collateral = got.custom?.okCount !== 7;

  // A dimension the tool says it could not measure must not also hand back a
  // NUMBER for that dimension. Reporting both is how the failure gets treated as
  // advisory: the metric still reaches the quality score, the trajectory and
  // every consumer that reads `metrics.coverage` without checking
  // `measurementFailures`.
  const metricsWithheld = sabotage.expectNoCoverageMetrics ? got.coverage === null : true;

  const passed =
    got.status === "fail" &&
    failedOnMeasurement &&
    failure?.kind === sabotage.expectKind &&
    metricsWithheld &&
    scriptsPassed &&
    !collateral;

  results.push({
    name: sabotage.name,
    passed,
    stands_for: sabotage.stands_for,
    detail: passed
      ? `${sabotage.dimension}: ${failure.kind}, gate failed on it`
      : collateral && failure?.kind === sabotage.expectKind
        ? `caught ${sabotage.dimension} but lost the healthy dimension too: okCount=${got.custom?.okCount}`
        : !metricsWithheld && failure?.kind === sabotage.expectKind
          ? `named ${sabotage.dimension} as unmeasured AND reported it as a number: ` +
            `coverage.unit=${JSON.stringify(got.coverage)}`
          : !scriptsPassed
            ? `the scripts this case needs green did not pass: scripts=${JSON.stringify(got.scripts)}, ` +
              `so it was measuring a broken run rather than ${sabotage.name}`
            : `expected gate=fail with a '${sabotage.expectKind}' measurement failure on ${sabotage.dimension}; ` +
              `got gate=${got.status}, failedRuleTypes=[${got.failedRuleTypes}], ` +
              `failures=${JSON.stringify(got.failures)}, ` +
              `eslintErrors=${got.eslintErrors}, typescriptErrors=${got.typescriptErrors}, ` +
              `coverage.unit=${JSON.stringify(got.coverage)}, ` +
              `custom=${JSON.stringify(got.custom)}`,
  });
}

// --- report -------------------------------------------------------------------
printResults();

const escaped = results.filter((r) => !r.passed);

/**
 * Which of three things a case is.
 *
 * Counted rather than assumed, and three categories rather than two, because the
 * summary line is itself a claim about coverage. A control that measured cleanly
 * and a breakage that was reported without failing the gate are different results,
 * and calling either one "a broken measurement that failed the gate" would
 * overstate what this file demonstrates.
 */
function caseKind(testCase) {
  if (testCase.expectReportedButUngated || testCase.expectUngatedEveryRun) return "ungated";
  if (testCase.expectMetric || testCase.expectCoverage || testCase.expectBranchlessCoverage) {
    return "control";
  }
  return "breakage";
}

if (escaped.length === 0) {
  const kinds = SABOTAGES.map(caseKind);
  const breakages = kinds.filter((k) => k === "breakage").length;
  const ungated = kinds.filter((k) => k === "ungated").length;
  // The unsabotaged control is a result without a SABOTAGES entry, so it is
  // counted here rather than by caseKind.
  const controls = results.length - breakages - ungated;

  console.log(
    `NO VACUOUS PASS: ${breakages} broken measurements all failed the gate, ` +
      `${ungated} broken measurement(s) no rule grades were reported without failing it, ` +
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
