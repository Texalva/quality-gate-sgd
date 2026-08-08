/**
 * Rules Evaluation Engine
 * Evaluates quality metrics against defined rules
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  QualityRules,
  Metrics,
  EvaluationResult,
  FailedRule,
  UnevaluatedRule,
  CacheEntry,
} from './types.js';
import type { MeasurementEvidence } from './providers/types.js';
import { getConfig } from './config.js';
import { readEntryManager } from './runner.js';
import { measurementInputsHash } from './measurement-inputs.js';
import { getDefaultRules, isEmbeddedDefaults } from './defaults.js';
import { getMetricValue as getFitnessMetricValue } from './fitness.js';

// =============================================================================
// Module State
// =============================================================================

// Track whether we're using embedded defaults (for CLI messaging)
let _usingEmbeddedDefaults = false;

/**
 * Check if the currently loaded rules are embedded defaults.
 */
export function isUsingEmbeddedDefaults(): boolean {
  return _usingEmbeddedDefaults;
}

// =============================================================================
// Rules Loading
// =============================================================================

export interface LoadRulesOptions {
  /** Use coverage-only defaults if no rules file exists */
  coverageOnly?: boolean;
  /** Suppress warning about using defaults */
  silent?: boolean;
}

export function loadRules(options: LoadRulesOptions = {}): QualityRules {
  const config = getConfig();
  const { coverageOnly = false, silent = false } = options;

  // Check if rulesFile is absolute or relative
  const rulesPath = path.isAbsolute(config.rulesFile)
    ? config.rulesFile
    : path.join(config.projectRoot, config.rulesFile);

  if (!fs.existsSync(rulesPath)) {
    // Zero-config mode: use embedded defaults
    _usingEmbeddedDefaults = true;
    const defaults = getDefaultRules(coverageOnly);

    if (!silent) {
      console.error(
        `[zero-config] No rules.json found, using embedded defaults (${coverageOnly ? 'coverage-only' : 'full'})`
      );
      console.error(
        '             Run "npx quality-gate-sgd init" to create a custom configuration\n'
      );
    }

    return defaults;
  }

  _usingEmbeddedDefaults = false;
  const content = fs.readFileSync(rulesPath, 'utf-8');
  const rules = JSON.parse(content) as QualityRules;

  // Check if loaded rules are actually embedded defaults (for testing)
  if (isEmbeddedDefaults(rules)) {
    _usingEmbeddedDefaults = true;
  }

  return rules;
}

export function computeRulesHash(rules: QualityRules): string {
  const content = JSON.stringify(rules);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// =============================================================================
// Metric Value Access
// =============================================================================

/**
 * Metric lookup is `fitness.ts`'s exported `getMetricValue`, not a second copy.
 *
 * There used to be a private one here that walked the path segment by segment.
 * It could not resolve any `custom.` path with more than one segment after the
 * prefix, because `extractAllCustomMetrics` stores custom readings FLAT --
 * `metrics.custom['bundle.size']`, not `metrics.custom.bundle.size` -- and
 * `validateCustomDimensions` puts no constraint on segment count. So a ceiling
 * on `custom.bundle.size` resolved to `undefined` and `evaluateCeilings` took
 * its silent `continue`: measured 5,000,000 against a ceiling of 500,000, gate
 * PASSED, and the reading was complete so the pass was cached.
 *
 * The asymmetry was exactly inverted from what is safe. A BROKEN extractor on
 * that path WAS gated, because the failure's `dimension` string equals the rule
 * path and `isMeasurementUnderRule` matched it -- while a WORKING extractor
 * whose value violated the ceiling sailed through. `score` even printed the
 * violating number in its own table on the same tree.
 *
 * Two accessors that disagree about what a path means is a fight the gate
 * loses, so there is now one. Any future divergence has to be deliberate.
 */
const getMetricValue = getFitnessMetricValue;

// =============================================================================
// Measurement Evaluation
// =============================================================================

/**
 * Every metric path this configuration's rules name.
 *
 * All four rule surfaces, because a dimension is "under rule" if ANY of them
 * reads it: floors and ceilings key their thresholds by metric path, and a
 * monotonic rule lists several. `requiredScripts` is deliberately not here --
 * it names npm scripts, not dimensions, and a script name has no metric path to
 * match against. Checked rather than assumed: `rules.rules` has exactly these
 * four members (types.ts QualityRules), and grepping `rules.rules.` finds no
 * fifth reader in src/.
 *
 * The fitness score is not a rule surface either. It reads every registered
 * dimension whether or not the project gates it, and it reports what it could
 * not measure through `describeUnmeasured` instead of refusing to answer.
 */
function ruledMetricPaths(rules: QualityRules): readonly string[] {
  return [
    ...Object.keys(rules.rules.floors ?? {}),
    ...Object.keys(rules.rules.ceilings ?? {}),
    ...(rules.rules.monotonic ?? []).flatMap((rule) => rule.metrics),
  ];
}

/**
 * Whether two metric paths name the same subtree, in either direction.
 *
 * Either can be the more specific one -- a failure names `coverage.unit` while a
 * floor names `coverage.unit.branches`, and a failure names `custom.anyCount`
 * while a ceiling names `custom` -- so both prefixes are tested. On a segment
 * boundary, never a bare `startsWith`: `coverage.unit` must not match a rule on a
 * hypothetical `coverage.unittest`, and `custom` must not match `customs.duty`.
 */
function sameSubtree(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * Derived dimensions, and the dimensions their VALUE is computed from.
 *
 * A rule on a derived dimension is a rule on everything upstream of it, because
 * the derived number is arithmetic over the upstream measurements: if one of those
 * measurements failed, the derived number is not a reading of the project even
 * though its own computation "succeeded". Name matching cannot see this --
 * `coverage.union` and `coverage.unit` are unrelated strings one character apart --
 * so the edges are declared.
 *
 * REPRODUCED, twice, when they were not: a project with a
 * `coverage.union.statements` floor and a backdated unit report had its
 * `coverage.unit` measurement failure demoted to an advisory while the union
 * number DERIVED from that failed measurement was graded at 95 against a floor of
 * 80, exit 0; and a truncated `coverage-lambda` summary was dropped from the merge
 * with the union graded from the unit suite alone, exit 0. Both FAILED the gate
 * before rule-scoping narrowed it, and the advisory printed the false sentence
 * "nothing compares them against anything" -- the union rule compared them.
 *
 * ONE-DIRECTIONAL, deliberately. A failure upstream invalidates the derived
 * number; a failure on the derived number says nothing about the suites it was
 * summed from. `coverage.union`'s own `unparseable-output` (an unmergeable file
 * entry, providers/coverage.ts) is exactly that case: `unit` and `lambda` come
 * from `total`, which is validated on its own, and they are reported.
 *
 * `coverage.union` is the only edge here. The other derivations in the codebase
 * are NOT cross-dimension:
 *   - `typescript.rootCauses` / `eslint.rootCauses` are computed from the same
 *     provider run as their `.errors` sibling, so a failure on `typescript` or
 *     `eslint` already reaches them by subtree.
 *   - the trajectory normalizer's `coverageBranches`, `*PerKsloc` etc. are derived
 *     from `coverage.union ?? coverage.unit`, `sonarqube.*` and `sloc`, but they
 *     are not metric paths any rule can name -- `getMetricValue` resolves rules
 *     against `Metrics`, and no rule surface reaches NormalizedMetrics.
 *   - the fitness score aggregates every registered dimension and is not a rule
 *     surface either (see ruledMetricPaths).
 *   - `sonarqube.coverage` is downstream of A coverage report, but not of the one
 *     this tool reads: SonarQube imports its own configured lcov on its own
 *     schedule and the gate reads the resulting measure from the API. An edge from
 *     `coverage.unit` to it would assert a data path this tool cannot see, and
 *     would gate a Sonar number on a report Sonar may never have been given.
 */
const DERIVED_FROM: Readonly<Record<string, readonly string[]>> = {
  'coverage.union': ['coverage.unit', 'coverage.lambda'],
};

/**
 * The dimensions a rule on `metricPath` transitively depends on the measurement of.
 *
 * Itself, plus the upstreams of every derived dimension the path falls under. A
 * floor on `coverage.union.statements` therefore depends on `coverage.unit` and
 * `coverage.lambda` as well as on `coverage.union`.
 */
function measurementsBehind(metricPath: string): readonly string[] {
  const upstreams = Object.entries(DERIVED_FROM)
    .filter(([derived]) => sameSubtree(metricPath, derived))
    .flatMap(([, sources]) => sources);

  return [metricPath, ...upstreams];
}

/**
 * Whether any rule grades the dimension a measurement failed on -- directly, or
 * through a dimension DERIVED from it.
 *
 *   failure `coverage.unit`  + floor `coverage.unit.branches`   -> gated
 *   failure `typescript`     + ceiling `typescript.errors`      -> gated
 *   failure `custom.anyCount`+ ceiling `custom.anyCount`        -> gated
 *   failure `coverage.unit`  + floor `coverage.union.statements` -> gated (derived)
 *   failure `coverage.lambda`+ floor `coverage.union.statements` -> gated (derived)
 *   failure `coverage.lambda`+ floor `coverage.unit.branches`   -> NOT gated
 *   failure `coverage.union` + floor `coverage.unit.branches`   -> NOT gated
 */
export function isMeasurementUnderRule(
  rules: QualityRules,
  dimension: string
): boolean {
  return rulesReadingMeasurement(rules, dimension).length > 0;
}

/**
 * WHICH ruled metric paths depend on the measurement of a dimension.
 *
 * The same matcher `isMeasurementUnderRule` asks for a boolean, asked for the list,
 * so the two cannot disagree about what "grades this dimension" means -- including
 * the derivation edge, which is easy to forget: a `coverage.union.statements` floor
 * is a rule that reads `coverage.unit`.
 *
 * It exists because a boolean cannot be reported. The coverage-provenance advisory
 * has to NAME the rules that were graded against numbers of unestablished origin --
 * `evaluateAnalysisProvenance` needs the same thing for sonarqube -- and an adopter
 * told "some rule reads this" cannot act on it. Lives here, next to
 * `coverageAbsenceIsFailure`, so the CLI and the harness cannot re-derive it
 * differently.
 *
 * Deduped and sorted, because the caller puts it in a sentence.
 */
export function rulesReadingMeasurement(
  rules: QualityRules,
  dimension: string
): readonly string[] {
  const reading = ruledMetricPaths(rules).filter((metricPath) =>
    measurementsBehind(metricPath).some((required) => sameSubtree(required, dimension))
  );

  return [...new Set(reading)].sort();
}

/** Every coverage suite, so a caller can ask a question about each of them. */
const COVERAGE_SUITE_DIMENSIONS = ['coverage.unit', 'coverage.lambda'] as const;

/**
 * Whether an absent coverage report should be reported as a failed measurement.
 *
 * `QUALITY_COVERAGE_REQUIRED=false` says "this project has no coverage report and
 * never will". It exists for one narrow cost: a project grading only its
 * type-checker and its linter would otherwise get an ungated advisory on EVERY run
 * and never write a cache entry, because any measurement failure suppresses the
 * write. That is a real regression for a legitimate configuration, and the flag
 * removes it.
 *
 * It does NOT get to switch the measurement off for a project that grades coverage.
 * Two independent adversarial reviews reproduced the same hole in the version that
 * consulted the flag alone: set it, keep (or later add) a `coverage.unit.branches`
 * ceiling or an `up` ratchet with a live baseline, remove the report, and the
 * provider returned neither a number nor a failure -- so `evaluateCeilings` and
 * `evaluateMonotonic` hit their silent `continue`, the gate reported `status: "pass"`
 * with zero failed rules, and the pass was cached. That is precisely the defect the
 * requirement was added to close, reachable by an environment variable.
 *
 * So the flag is honoured only where its cost is actually incurred: when no rule
 * reads coverage, directly or through a dimension derived from it. A configuration
 * that both sets the flag and grades coverage has contradicted itself, and this
 * resolves the contradiction toward measuring. Refusing to run on the contradiction
 * was the alternative and it is worse: a monorepo exporting the variable once in CI
 * for the packages with no coverage could not then gate the ones that have it.
 *
 * One consequence is worth stating because it looks like a gap: toggling the flag
 * does not invalidate a cached entry. After this narrowing the flag can only ever
 * suppress an UNGATED advisory, never change a verdict, so an entry written under
 * one setting is a correct answer under the other.
 *
 * Lives here rather than in cli.ts so that the CLI and the refactor harness cannot
 * drift apart on it. The harness grades the library path directly, and a harness
 * that re-derived this rule would keep passing while the shipped binary decided
 * something else.
 */
export function coverageAbsenceIsFailure(rules: QualityRules): boolean {
  if (getConfig().coverage.required) return true;
  return COVERAGE_SUITE_DIMENSIONS.some((suite) => isMeasurementUnderRule(rules, suite));
}

/**
 * A measurement that could not be taken fails the gate -- when some rule grades
 * the dimension it was measuring.
 *
 * The failure itself is DETECTED and REPORTED unconditionally, and what this
 * function decides is only which of them become failed RULES:
 * `metrics.measurementFailures` carries them, `describeUnmeasured` renders them
 * for `score` and `suggest`, and the CLI lists them by name.
 *
 * Every dimension now HAS a channel, sonarqube included, so the qualification that
 * used to stand here is gone. It read: sonarqube has none, an expired token or an
 * unprovisioned projectKey loses the whole dimension with an empty failure list, and
 * every `sonarqube.*` ceiling hits the silent `continue` below while the run is
 * graded as a complete reading. `readSonarqubeMetrics` closed that -- it classifies
 * the loss as unreachable / access-denied / project-not-found / empty-measures and
 * `extractAllMetrics` carries it here like any other.
 *
 * This reverses the stance that stood here, and the reason is worth stating,
 * because the old stance was right when it was written. Every failure the tool
 * could then produce came from a dimension the default rules gate: a dead
 * type-checker or linter is guarded by `typescript.errors` and `eslint.errors`
 * ceilings that both embedded defaults ship, and the floor/ceiling asymmetry
 * was what made it necessary -- a missing FLOOR metric failed loudly
 * (`Metric '...' not available`) while a missing CEILING metric was skipped
 * without a word. So "evaluate regardless of the rules" cost nothing and closed
 * a real hole.
 *
 * That asymmetry is closed now, from the other side: `evaluateCeilings` reports an
 * absent ceiling metric as a rule that did not run, which the CLI prints and which
 * makes the entry baseline-only. So the hole this stance used to cover no longer
 * needs covering, and the narrowing costs nothing it used to.
 *
 * It stopped being right once a provider measured a suite nobody configured.
 * `lambdaDir` defaults to `coverage-lambda` and is populated unconditionally, so
 * the coverage provider always attempts a second suite; a project whose scripts
 * rewrite only the unit report then hard-failed on `coverage.lambda`, a
 * dimension no rule gates and which this codebase itself documents as "almost
 * nobody has". Same shape for a project that gates only `typescript.errors` and
 * `eslint.errors` and happens to have a stray gitignored `coverage/` directory,
 * and for a declarations-only package whose blank summary is legitimate.
 *
 * The gate fails on the measurements it NEEDS, and reports the rest. A
 * measurement nothing grades against cannot change a verdict, so promoting it to
 * a failure is noise -- and noise in the loud channel is what trains adopters to
 * stop reading it, which costs more than the hole it was closing.
 */
function evaluateMeasurements(
  rules: QualityRules,
  metrics: Metrics
): FailedRule[] {
  return (metrics.measurementFailures ?? [])
    .filter((failure) => isMeasurementUnderRule(rules, failure.dimension))
    .map((failure) => ({
      type: 'measurement' as const,
      rule: `${failure.dimension}.measurement`,
      // "could not be measured" is true of every kind but one. `stale-report`
      // arrives WITH a number -- the report parsed, `total` was valid, the suite has
      // a value in `metrics` -- and what failed is the claim that the number
      // describes this code. Printing "could not be measured" over a dimension the
      // same output reports a percentage for is the kind of confidently-false
      // sentence this file exists to remove.
      message:
        `${failure.dimension} ${
          failure.kind === 'stale-report'
            ? 'was measured, but nothing ties the number to this code'
            : 'could not be measured'
        } (${failure.kind}): ${failure.message} ` + describeEvidence(failure.evidence),
    }));
}

/**
 * Renders evidence for a human reading gate output.
 *
 * The REPORT variant is tested for explicitly and the process variant is the
 * FALLBACK, deliberately -- not two arms of an exhaustive switch. Evidence
 * objects built before the union existed carry no `via` tag at all (the
 * literals in tests/rules.test.ts are exactly this shape), and a
 * `switch (e.via)` with a `never` default would render those as nothing,
 * silently dropping the signal and elapsed time that make a kill diagnosable.
 * Ordering it this way makes the untagged case fall into the pre-existing
 * behaviour instead of into a new hole.
 */
function describeEvidence(evidence: MeasurementEvidence): string {
  if (evidence.via === 'report') {
    const attempts = evidence.attempts
      .map(
        (attempt) =>
          `${attempt.path} ${attempt.outcome}` +
          `${attempt.bytesRead === null ? '' : ` ${attempt.bytesRead}B`}` +
          `${attempt.modifiedMs === null ? '' : ` mtime=${new Date(attempt.modifiedMs).toISOString()}`}`
      )
      .join('; ');

    return `[${evidence.attempts.length} path(s) tried: ${attempts}, after ${evidence.elapsedMs}ms]`;
  }

  return (
    `[exit=${evidence.exitCode ?? 'killed'}` +
    `${evidence.signal ? ` signal=${evidence.signal}` : ''}` +
    ` after ${evidence.elapsedMs}ms, ` +
    `${evidence.stdoutBytes}B stdout, ${evidence.stderrBytes}B stderr]`
  );
}

// =============================================================================
// Floor Evaluation
// =============================================================================

function evaluateFloors(rules: QualityRules, metrics: Metrics): FailedRule[] {
  const failures: FailedRule[] = [];
  const floors = rules.rules.floors;

  if (!floors) {
    return failures;
  }

  for (const [metricPath, threshold] of Object.entries(floors)) {
    const value = getMetricValue(metrics, metricPath);

    if (value === undefined) {
      failures.push({
        type: 'floor',
        rule: metricPath,
        message: `Metric '${metricPath}' not available`,
      });
      continue;
    }

    if (value < threshold) {
      failures.push({
        type: 'floor',
        rule: metricPath,
        message: `${metricPath} is ${value.toFixed(1)}%, must be >= ${threshold}%`,
        baseline: threshold,
        current: value,
      });
    }
  }

  return failures;
}

// =============================================================================
// Ceiling Evaluation
// =============================================================================

/**
 * Ceilings, and the ones that could not be applied.
 *
 * The silent `continue` on an absent metric was the last vacuous pass with no
 * channel of its own, and this codebase already named it: a missing FLOOR metric
 * fails loudly (`Metric '...' not available`) while a missing CEILING metric was
 * skipped without a word. So `sonarqube.blocker: 0` was satisfied by a dimension
 * nobody measured, `custom.leaks: 0` by an extractor nobody configured, and the gate
 * printed a clean pass over both.
 *
 * It still does not FAIL, and that is deliberate -- see `evaluateMeasurements` for
 * why promoting an unmeasured dimension to a failure was tried and reversed. What
 * changes is that the rule is now REPORTED as unevaluated, which the CLI prints and
 * which marks the cache entry baseline-only, so no later run inherits the pass as a
 * verdict it never earned.
 *
 * A failure that already explains the absence is not reported twice: an unreachable
 * SonarQube produces one `sonarqube.measurement` failed rule, and every
 * `sonarqube.*` ceiling behind it is silent. The distinction is exactly "is there a
 * stated reason this is missing" -- if there is, it is reported there; if there is
 * not, it is reported here.
 */
function evaluateCeilings(
  rules: QualityRules,
  metrics: Metrics
): { failures: FailedRule[]; unevaluated: UnevaluatedRule[] } {
  const failures: FailedRule[] = [];
  const unevaluated: UnevaluatedRule[] = [];
  const ceilings = rules.rules.ceilings;

  if (!ceilings) {
    return { failures, unevaluated };
  }

  const explained = new Set<string>(
    (metrics.measurementFailures ?? []).map((failure) => failure.dimension)
  );

  for (const [metricPath, threshold] of Object.entries(ceilings)) {
    const value = getMetricValue(metrics, metricPath);

    if (value === undefined) {
      if (!dimensionOf(metricPath).some((dimension) => explained.has(dimension))) {
        unevaluated.push({
          type: 'skipped-dimension',
          rule: metricPath,
          metricPath,
          reason: 'dimension-skipped',
          message:
            `Ceiling '${metricPath}' <= ${threshold} was not applied: this run has no ` +
            'value for that metric, and nothing reported a reason it is missing. The ' +
            'dimension was skipped (--coverage-only), or nothing produces it.',
        });
      }
      continue;
    }

    if (value > threshold) {
      failures.push({
        type: 'ceiling',
        rule: metricPath,
        message: `${metricPath} is ${value}, must be <= ${threshold}`,
        baseline: threshold,
        current: value,
      });
    }
  }

  return { failures, unevaluated };
}

/**
 * Whether a rule on this metric path reads the sonarqube dimension, directly or through
 * a dimension derived from it.
 *
 * The same question `isMeasurementUnderRule` asks about a whole ruleset, asked about one
 * path, so the ceiling/floor/ratchet surfaces and the provenance surfaces cannot drift
 * apart on what "grades sonarqube" means.
 */
function gradesSonarqube(metricPath: string): boolean {
  return measurementsBehind(metricPath).some((required) => sameSubtree(required, 'sonarqube'));
}

/**
 * A rule applied to sonarqube numbers that could not be tied to a known analysis.
 *
 * ONE entry, not one per rule, and the message lists the rules it stands for. The
 * sentence is identical for all eight sonarqube ceilings a default ruleset ships, and
 * noise in the loud channel is what trains adopters to stop reading it -- the same
 * reasoning that makes the CLI drop `no-baseline` entries from the list it prints.
 *
 * GATED on some rule actually reading sonarqube, because the cost of reporting lands on
 * the cache: an entry with any unevaluated rule is written `monotonicEvaluated: false`,
 * which `isCacheValid` refuses as a VERDICT while `findBaselineEntry` still accepts it as
 * a BASELINE. Without the gate, a project that measures sonarqube and grades none of it
 * would be baseline-only forever and would re-scan on every run, over a provenance
 * nothing grades against.
 *
 * REPORTED rather than failed (D3): some editions may not expose the analysis identity
 * at all, and failing there would block every adopter on such a server over a hazard the
 * tool cannot even detect for them. What reporting buys is that the run is not servable
 * as a verdict.
 *
 * Where it buys NOTHING, stated because the sentence above oversells it: in ephemeral CI
 * the cache file is absent or gitignored, so the entry this advisory marks is discarded
 * when the job ends and the exit code -- the only thing CI reads -- is unchanged. The
 * advisory is then exactly what it says it is, an advisory. The cache tier bites only for
 * adopters who persist the cache file, which is what the tool already tells them to do.
 */
function evaluateAnalysisProvenance(
  rules: QualityRules,
  metrics: Metrics
): UnevaluatedRule[] {
  const provenance = metrics.sonarqubeProvenance;
  if (provenance === undefined || provenance.kind === 'confirmed') return [];

  const graded = [...new Set(ruledMetricPaths(rules).filter(gradesSonarqube))].sort();

  if (graded.length === 0) return [];

  return [
    {
      type: 'unbound-provenance',
      rule: 'sonarqube.provenance',
      metricPath: 'sonarqube',
      reason: 'provenance-unconfirmed',
      message:
        `${graded.length} sonarqube rule(s) (${graded.join(', ')}) were applied to numbers ` +
        `that could not be tied to a known analysis: ${provenance.why} The thresholds were ` +
        'compared, so this is not an unmeasured dimension -- what is unproven is that the ' +
        "numbers describe this commit's scan.",
    },
  ];
}

/**
 * The dimension names a metric path could belong to, longest first.
 *
 * `coverage.unit.lines` is measured by `coverage.unit`, not by `coverage`, and
 * `sonarqube.blocker` by `sonarqube` -- so a prefix walk rather than a single split,
 * because a measurement failure names whichever level actually failed.
 */
function dimensionOf(metricPath: string): string[] {
  const parts = metricPath.split('.');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('.'));
}

// =============================================================================
// Monotonic Evaluation
// =============================================================================

/**
 * Ratchets, and what happens to one that cannot be applied.
 *
 * The unevaluated list is the load-bearing part. This function used to `continue`
 * past a metric whose baseline or current value was absent, which meant an
 * individual ratcheted metric could go unenforced with nothing recording it -- even
 * when a baseline entry existed and was accepted, so the caller counted the run as
 * fully evaluated and cached the pass as fully earned. Ordinary triggers, no
 * adversarial input: add a ratchet to rules.json after the baseline was written and
 * that ratchet is unenforced against the very first commit it is supposed to guard.
 *
 * Floors already fail loudly on a missing metric (`Metric '...' not available`) and
 * ceilings already skip silently by design (a ceiling on a dimension you do not
 * measure is not a promise). Monotonic rules were skipping silently while ADVERTISING
 * enforcement, which is the combination that produces a vacuous pass.
 *
 * The two absences are reported separately because they mean different things. A
 * missing BASELINE value is a gap in history and converges on its own -- this run's
 * entry carries the metric, so the next commit has something to compare. A missing
 * CURRENT value means the reading itself is incomplete, and usually arrives alongside
 * a measurement failure that fails the gate independently.
 */
function evaluateMonotonic(
  rules: QualityRules,
  currentMetrics: Metrics,
  baselineMetrics?: Metrics
): { failures: FailedRule[]; unevaluated: UnevaluatedRule[] } {
  const failures: FailedRule[] = [];
  const unevaluated: UnevaluatedRule[] = [];
  const monotonicRules = rules.rules.monotonic;

  if (!monotonicRules) {
    return { failures, unevaluated };
  }

  // No baseline at all is reported HERE as well, not only by the caller.
  //
  // It used to return early with an empty list, on the reasoning that the CLI knows
  // WHY there is no baseline (root commit, no cached parent, a parent whose reading
  // was incomplete) and says so in one line instead of once per metric. That is still
  // true of the CLI -- and it was the whole defect, because the CLI is not the only
  // consumer. Adversarial review confirmed the MCP handler serialising
  // `{status:"pass", failedRules:[], unevaluated:[]}` on a project where every ratchet
  // was skipped, which is a clean bill of health for a run that checked nothing. The
  // rule lives in this function so that no consumer has to re-derive it, exactly as
  // `coverageAbsenceIsFailure` does.
  //
  // The CLI drops these from its own list to keep its output the single clear
  // sentence it already prints. See `unevaluatedWorthListing` in cli.ts.
  const baselineAbsent = !baselineMetrics;

  for (const rule of monotonicRules) {
    // A rule naming no metrics performs no comparison and would otherwise leave no
    // trace: the loop below simply does not run, `unevaluated` stays empty, and the
    // run is recorded as fully evaluated. Reachable from any hand-written
    // `{"direction":"down","metrics":[]}` -- rules.json is `JSON.parse`d and cast,
    // with no runtime validation of this shape -- and a rule that cannot fail is the
    // thing this file exists to refuse.
    if (rule.metrics.length === 0) {
      unevaluated.push({
        type: 'monotonic',
        rule: `${rule.direction}:<no metrics>`,
        metricPath: '',
        reason: 'no-metrics',
        message:
          `a '${rule.direction}' monotonic rule lists no metrics, so it compares ` +
          'nothing -- remove it, or give it the metric paths it should ratchet',
      });
      continue;
    }

    for (const metricPath of rule.metrics) {
      if (baselineAbsent) {
        unevaluated.push({
          type: 'monotonic',
          rule: `${rule.direction}:${metricPath}`,
          metricPath,
          reason: 'no-baseline',
          message:
            `there is no baseline reading to compare against, so the ` +
            `'${rule.direction}' ratchet on ${metricPath} did not run`,
        });
        continue;
      }
      const baselineValue = getMetricValue(baselineMetrics as Metrics, metricPath);
      const currentValue = getMetricValue(currentMetrics, metricPath);

      if (baselineValue === undefined || currentValue === undefined) {
        const reason =
          baselineValue === undefined ? 'baseline-missing' : 'current-missing';

        unevaluated.push({
          type: 'monotonic',
          rule: `${rule.direction}:${metricPath}`,
          metricPath,
          reason,
          message:
            reason === 'baseline-missing'
              ? `${metricPath} is absent from the baseline reading, so the ` +
                `'${rule.direction}' ratchet on it did not run`
              : `${metricPath} is absent from this run's reading, so the ` +
                `'${rule.direction}' ratchet on it did not run`,
        });
        continue;
      }

      // The BASELINE half of the analysis-provenance check, and the quieter half.
      //
      // An unconfirmed run is only marked baseline-only: `isCacheValid` will not serve
      // it as a verdict, but `usableBaseline` accepts it and this function then reads
      // its numbers as the floor. CONSTRUCTED path, no adversarial input: commit C1
      // reads `sonarqube.major = 120` from a foreign analysis and lands on an
      // unconfirmed branch (project key names a module -> 404 advisory; the id-space
      // probe 404s; the edition omits analysisId), so the entry is written with the
      // ungraded 120 in it. Commit C2 measures a real 118 -- a regression from C1's true
      // 90 -- confirms its own provenance, differences 118 against 120, reports no
      // violation, is stamped `monotonicEvaluated: true` and IS cached as a verdict. The
      // ratchet was laundered through the baseline channel by the entry the provenance
      // check itself wrote. Same arithmetic as the package-manager case in
      // `usableBaseline` (10 -> 5 passing where 4 -> 5 should fail).
      //
      // Reported here rather than refused in `usableBaseline`, because refusing the
      // whole entry would re-create the deadlock for any server that is permanently
      // unconfirmable: every commit would have no baseline, forever. This is the
      // per-metric precedent schema version 5 established for a metric absent from the
      // baseline.
      //
      // `!== 'confirmed'` rather than `=== 'unconfirmed'`: an entry written before the
      // field existed carries a sonarqube reading and no provenance, and for those the
      // absence means "never checked", not "fine".
      if (
        gradesSonarqube(metricPath) &&
        baselineMetrics?.sonarqubeProvenance?.kind !== 'confirmed'
      ) {
        unevaluated.push({
          type: 'monotonic',
          rule: `${rule.direction}:${metricPath}`,
          metricPath,
          reason: 'baseline-unbound',
          message:
            `the baseline's ${metricPath} (${baselineValue}) could not be tied to a known ` +
            `SonarQube analysis, so the '${rule.direction}' ratchet on it did not run -- ` +
            `differencing this run's ${currentValue} against a number of unproven origin ` +
            'would report a pass the comparison did not earn',
        });
        continue;
      }

      const isViolation =
        rule.direction === 'up'
          ? currentValue < baselineValue
          : currentValue > baselineValue;

      if (isViolation) {
        const directionWord =
          rule.direction === 'up' ? 'decreased' : 'increased';
        const expectation =
          rule.direction === 'up' ? 'must not decrease' : 'must not increase';

        failures.push({
          type: 'monotonic',
          rule: `${rule.direction}:${metricPath}`,
          message: `${metricPath} ${directionWord} from ${baselineValue} to ${currentValue} (${expectation})`,
          baseline: baselineValue,
          current: currentValue,
        });
      }
    }
  }

  return { failures, unevaluated };
}

// =============================================================================
// Script Evaluation
// =============================================================================

function evaluateScripts(rules: QualityRules, metrics: Metrics): FailedRule[] {
  const failures: FailedRule[] = [];
  const requiredScripts = rules.rules.requiredScripts;

  if (!requiredScripts) {
    return failures;
  }

  for (const script of requiredScripts) {
    const result = metrics.scripts[script];

    if (result === undefined) {
      failures.push({
        type: 'script',
        rule: script,
        message: `Required script '${script}' was not run`,
      });
    } else if (result === 'fail') {
      failures.push({
        type: 'script',
        rule: script,
        message: `Required script '${script}' failed`,
      });
    }
  }

  return failures;
}

// =============================================================================
// Full Evaluation
// =============================================================================

export function evaluateRules(
  rules: QualityRules,
  currentMetrics: Metrics,
  baselineEntry?: CacheEntry
): EvaluationResult {
  const baselineMetrics = baselineEntry?.metrics;
  const monotonic = evaluateMonotonic(rules, currentMetrics, baselineMetrics);
  const ceilings = evaluateCeilings(rules, currentMetrics);

  const allFailures: FailedRule[] = [
    // First, so the reason a dimension is absent is stated before the rules
    // that read it start reporting it as absent.
    ...evaluateMeasurements(rules, currentMetrics),
    ...evaluateFloors(rules, currentMetrics),
    ...ceilings.failures,
    ...monotonic.failures,
    ...evaluateScripts(rules, currentMetrics),
  ];

  return {
    // `unevaluated` deliberately does NOT feed this. A rule that did not run, or that
    // ran against numbers whose origin is unproven, has produced no evidence of a
    // violation, and inventing one would fail the gate on every fresh clone, every
    // commit that adds a ratchet, and every adopter whose server will not name the
    // current analysis. The consequence is carried on the CACHE instead -- see
    // `unevaluated`'s doc comment and the `monotonicEvaluated` write in cli.ts -- so a
    // pass with an unevaluated rule cannot be inherited by a later run as
    // `PASSED (cached)`.
    status: allFailures.length === 0 ? 'pass' : 'fail',
    failedRules: allFailures,
    // The provenance advisory is appended LAST, which keeps the orderings existing
    // tests assert on untouched.
    unevaluated: [
      ...monotonic.unevaluated,
      ...ceilings.unevaluated,
      ...evaluateAnalysisProvenance(rules, currentMetrics),
    ],
  };
}

/**
 * Check if cached evaluation is still valid
 * Returns false if:
 * - Rules have changed since cache entry was created
 * - The entry records a reading that was incomplete
 * - Required floor metrics were missing but may now be available
 */
export function isCacheValid(entry: CacheEntry, rules: QualityRules): boolean {
  const currentHash = computeRulesHash(rules);

  // Rules changed - cache invalid
  if (entry.rulesHash !== currentHash || entry.rulesVersion !== rules.version) {
    return false;
  }

  // An entry that RECORDS a measurement failure is an incomplete reading, and
  // this version never writes one: `cli.ts` declines to cache any run with a
  // measurement failure, gated or not. So this is the invariant made explicit
  // rather than a condition that fires in normal operation.
  //
  // It is reachable, which is why it is a check and not a comment. Schema version
  // 3 also covers an intermediate revision that scoped cache suppression to GATED
  // failures, so a .qg-cache.json on disk can hold a version-3 PASS carrying an
  // ungated failure. Serving it would exit 0 while printing only
  // "Quality gate PASSED (cached)" -- the entry's failures are reported nowhere,
  // because the cached path never reads them. Refusing the entry costs one
  // re-measurement and reports the failure again, which is the outcome that
  // converges.
  if ((entry.metrics.measurementFailures ?? []).length > 0) {
    return false;
  }

  // An entry whose monotonic rules never ran is a NARROWER reading than a complete
  // one -- some configured rules were not applied -- so it cannot be served as a
  // verdict. Serving it would let a later run short-circuit to a PASS that no run
  // ever fully earned.
  //
  // This is the read half of a deliberate two-tier arrangement, and the write half
  // is what makes it necessary: such a run now DOES write its entry, where before it
  // wrote nothing. That refusal deadlocked the cache permanently for any project
  // with a ratchet -- a clean run needs a baseline at HEAD's parent, which needs one
  // at its parent, inductively back to the root commit, which has none -- so no
  // entry was ever written on any commit and every monotonic rule was silently
  // unevaluated on every run while the gate printed PASS. See CacheEntry.
  //
  // The entry is still a usable BASELINE: `findBaselineEntry` and `usableBaseline`
  // ask a different question (are these numbers a reading of that commit?) and the
  // answer is yes. That is what breaks the deadlock without reintroducing the
  // unearned cached pass.
  //
  // `!== false` rather than `=== true`: entries written before the field existed
  // carry no value, and for them "evaluated" is what the absence meant.
  if (entry.monotonicEvaluated === false) {
    return false;
  }

  // An entry whose sonarqube numbers were never tied to a known analysis is not a
  // verdict about them, and this version's own runs are already marked
  // `monotonicEvaluated: false` when that happens -- so this check exists for the entry
  // the counter above cannot catch: one written by an INTERMEDIATE revision of this
  // schema version, before the binding existed. Such an entry carries a sonarqube
  // reading, no provenance and no unevaluated rule, so it looks fully earned. Version 3
  // records the same allowance for cache suppression; see QualityGateCache.
  //
  // Scoped to rulesets that actually grade sonarqube, for the reason
  // `evaluateAnalysisProvenance` is scoped the same way: refusing it unconditionally
  // would make every project that measures sonarqube and grades none of it re-measure on
  // every run over a provenance nothing reads.
  //
  // `!== 'confirmed'` and not `=== 'unconfirmed'`: absence is the pre-binding state,
  // which is exactly the state this refuses.
  if (
    entry.metrics.sonarqube !== undefined &&
    entry.metrics.sonarqubeProvenance?.kind !== 'confirmed' &&
    isMeasurementUnderRule(rules, 'sonarqube')
  ) {
    return false;
  }

  // An entry measured by a different package manager is a reading of a different
  // toolchain. The key cannot catch this: it hashes tracked code under
  // `codePathspecs`, and lockfiles are not in it, so adding a `bun.lock` swaps the
  // runner without moving the key. Coverage is the concrete path -- a different test
  // runner writes a different report, or none at all -- so serving the entry would
  // report npm's numbers for a bun run.
  //
  // `readEntryManager` treats an ABSENT field as npm, which is sound rather than
  // lenient -- every entry written before the field existed came from a version with
  // npm hardcoded at each spawn site. It refuses any other unrecognised value.
  if (readEntryManager(entry.packageManager) !== getConfig().packageManager.manager) {
    return false;
  }

  // An entry measured under different config is a reading of a different question.
  // The KEY cannot catch this on the path that matters: a clean tree keys on the bare
  // commit hash, so a GITIGNORED `tsconfig.json` or `quality-gate.config.js` can be
  // rewritten with git still reporting a clean tree and the key still landing on the
  // same commit. The WIP content hash covers the dirty case; this covers the clean
  // one. Same shape as the `packageManager` check above, and adopted for the same
  // reason -- stamping the reading beats widening the key when the key has another job.
  //
  // A missing value is a MISMATCH, not an inference. Unlike `packageManager`, absence
  // implies no particular config state, so there is nothing sound to assume; schema 5
  // guarantees every entry this version reads was written with one.
  if (entry.measurementInputsHash !== measurementInputsHash()) {
    return false;
  }

  // If evaluation passed, cache is valid - no need to re-check metrics
  if (entry.evaluation.status === 'pass') {
    return true;
  }

  // For failed evaluations, check if any floor metrics were missing
  // If they were, we should re-extract metrics in case they're now available
  const floors = rules.rules.floors;
  if (floors) {
    for (const metricPath of Object.keys(floors)) {
      const value = getMetricValue(entry.metrics, metricPath);
      if (value === undefined) {
        // A required metric was missing - cache invalid, try fresh extraction
        return false;
      }
    }
  }

  return true;
}
