/**
 * Rules Evaluation Engine
 * Evaluates quality metrics against defined rules
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getConfig } from './config.js';
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
export function isUsingEmbeddedDefaults() {
    return _usingEmbeddedDefaults;
}
export function loadRules(options = {}) {
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
            console.error(`[zero-config] No rules.json found, using embedded defaults (${coverageOnly ? 'coverage-only' : 'full'})`);
            console.error('             Run "npx quality-gate-sgd init" to create a custom configuration\n');
        }
        return defaults;
    }
    _usingEmbeddedDefaults = false;
    const content = fs.readFileSync(rulesPath, 'utf-8');
    const rules = JSON.parse(content);
    // Check if loaded rules are actually embedded defaults (for testing)
    if (isEmbeddedDefaults(rules)) {
        _usingEmbeddedDefaults = true;
    }
    return rules;
}
export function computeRulesHash(rules) {
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
function ruledMetricPaths(rules) {
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
function sameSubtree(a, b) {
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
const DERIVED_FROM = {
    'coverage.union': ['coverage.unit', 'coverage.lambda'],
};
/**
 * The dimensions a rule on `metricPath` transitively depends on the measurement of.
 *
 * Itself, plus the upstreams of every derived dimension the path falls under. A
 * floor on `coverage.union.statements` therefore depends on `coverage.unit` and
 * `coverage.lambda` as well as on `coverage.union`.
 */
function measurementsBehind(metricPath) {
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
export function isMeasurementUnderRule(rules, dimension) {
    return ruledMetricPaths(rules)
        .flatMap((metricPath) => measurementsBehind(metricPath))
        .some((required) => sameSubtree(required, dimension));
}
/** Every coverage suite, so a caller can ask a question about each of them. */
const COVERAGE_SUITE_DIMENSIONS = ['coverage.unit', 'coverage.lambda'];
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
export function coverageAbsenceIsFailure(rules) {
    if (getConfig().coverage.required)
        return true;
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
 * With ONE exception, which is a hole rather than a design: `sonarqube` has no
 * failure channel at all. `extractSonarqubeMetrics` returns `undefined` from a
 * bare catch and from an empty-`measures` check, and `extractAllMetrics` builds
 * `measurementFailures` from typescript, eslint, coverage and custom only. So an
 * expired token or an unprovisioned projectKey loses the whole dimension with an
 * empty failure list, and every `sonarqube.*` ceiling hits the silent `continue`
 * in `evaluateCeilings` while the run is graded as a complete reading. Filed as
 * #23/#42. Read every "carries every failure" claim in this codebase as "every
 * failure from a dimension that has a channel" until that is closed.
 *
 * This reverses the stance that stood here, and the reason is worth stating,
 * because the old stance was right when it was written. Every failure the tool
 * could then produce came from a dimension the default rules gate: a dead
 * type-checker or linter is guarded by `typescript.errors` and `eslint.errors`
 * ceilings that both embedded defaults ship, and the floor/ceiling asymmetry
 * below is what made it necessary -- a missing FLOOR metric fails loudly
 * (`Metric '...' not available`) while a missing CEILING metric is skipped
 * without a word. So "evaluate regardless of the rules" cost nothing and closed
 * a real hole.
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
function evaluateMeasurements(rules, metrics) {
    return (metrics.measurementFailures ?? [])
        .filter((failure) => isMeasurementUnderRule(rules, failure.dimension))
        .map((failure) => ({
        type: 'measurement',
        rule: `${failure.dimension}.measurement`,
        message: `${failure.dimension} could not be measured (${failure.kind}): ${failure.message} ` +
            describeEvidence(failure.evidence),
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
function describeEvidence(evidence) {
    if (evidence.via === 'report') {
        const attempts = evidence.attempts
            .map((attempt) => `${attempt.path} ${attempt.outcome}` +
            `${attempt.bytesRead === null ? '' : ` ${attempt.bytesRead}B`}` +
            `${attempt.modifiedMs === null ? '' : ` mtime=${new Date(attempt.modifiedMs).toISOString()}`}`)
            .join('; ');
        return `[${evidence.attempts.length} path(s) tried: ${attempts}, after ${evidence.elapsedMs}ms]`;
    }
    return (`[exit=${evidence.exitCode ?? 'killed'}` +
        `${evidence.signal ? ` signal=${evidence.signal}` : ''}` +
        ` after ${evidence.elapsedMs}ms, ` +
        `${evidence.stdoutBytes}B stdout, ${evidence.stderrBytes}B stderr]`);
}
// =============================================================================
// Floor Evaluation
// =============================================================================
function evaluateFloors(rules, metrics) {
    const failures = [];
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
function evaluateCeilings(rules, metrics) {
    const failures = [];
    const ceilings = rules.rules.ceilings;
    if (!ceilings) {
        return failures;
    }
    for (const [metricPath, threshold] of Object.entries(ceilings)) {
        const value = getMetricValue(metrics, metricPath);
        if (value === undefined) {
            // Ceilings are optional - missing metric is not a failure
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
    return failures;
}
// =============================================================================
// Monotonic Evaluation
// =============================================================================
function evaluateMonotonic(rules, currentMetrics, baselineMetrics) {
    const failures = [];
    const monotonicRules = rules.rules.monotonic;
    if (!monotonicRules || !baselineMetrics) {
        return failures;
    }
    for (const rule of monotonicRules) {
        for (const metricPath of rule.metrics) {
            const baselineValue = getMetricValue(baselineMetrics, metricPath);
            const currentValue = getMetricValue(currentMetrics, metricPath);
            // Skip if either value is unavailable
            if (baselineValue === undefined || currentValue === undefined) {
                continue;
            }
            const isViolation = rule.direction === 'up'
                ? currentValue < baselineValue
                : currentValue > baselineValue;
            if (isViolation) {
                const directionWord = rule.direction === 'up' ? 'decreased' : 'increased';
                const expectation = rule.direction === 'up' ? 'must not decrease' : 'must not increase';
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
    return failures;
}
// =============================================================================
// Script Evaluation
// =============================================================================
function evaluateScripts(rules, metrics) {
    const failures = [];
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
        }
        else if (result === 'fail') {
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
export function evaluateRules(rules, currentMetrics, baselineEntry) {
    const baselineMetrics = baselineEntry?.metrics;
    const allFailures = [
        // First, so the reason a dimension is absent is stated before the rules
        // that read it start reporting it as absent.
        ...evaluateMeasurements(rules, currentMetrics),
        ...evaluateFloors(rules, currentMetrics),
        ...evaluateCeilings(rules, currentMetrics),
        ...evaluateMonotonic(rules, currentMetrics, baselineMetrics),
        ...evaluateScripts(rules, currentMetrics),
    ];
    return {
        status: allFailures.length === 0 ? 'pass' : 'fail',
        failedRules: allFailures,
    };
}
/**
 * Check if cached evaluation is still valid
 * Returns false if:
 * - Rules have changed since cache entry was created
 * - The entry records a reading that was incomplete
 * - Required floor metrics were missing but may now be available
 */
export function isCacheValid(entry, rules) {
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
//# sourceMappingURL=rules.js.map