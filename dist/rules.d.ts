/**
 * Rules Evaluation Engine
 * Evaluates quality metrics against defined rules
 */
import type { QualityRules, Metrics, EvaluationResult, CacheEntry } from './types.js';
/**
 * Check if the currently loaded rules are embedded defaults.
 */
export declare function isUsingEmbeddedDefaults(): boolean;
export interface LoadRulesOptions {
    /** Use coverage-only defaults if no rules file exists */
    coverageOnly?: boolean;
    /** Suppress warning about using defaults */
    silent?: boolean;
}
export declare function loadRules(options?: LoadRulesOptions): QualityRules;
export declare function computeRulesHash(rules: QualityRules): string;
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
export declare function isMeasurementUnderRule(rules: QualityRules, dimension: string): boolean;
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
export declare function coverageAbsenceIsFailure(rules: QualityRules): boolean;
export declare function evaluateRules(rules: QualityRules, currentMetrics: Metrics, baselineEntry?: CacheEntry): EvaluationResult;
/**
 * Check if cached evaluation is still valid
 * Returns false if:
 * - Rules have changed since cache entry was created
 * - The entry records a reading that was incomplete
 * - Required floor metrics were missing but may now be available
 */
export declare function isCacheValid(entry: CacheEntry, rules: QualityRules): boolean;
//# sourceMappingURL=rules.d.ts.map