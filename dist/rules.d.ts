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