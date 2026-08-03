/**
 * Type definitions for the Quality Gate system
 * Schema Version: 2
 */
import type { MeasurementFailure } from './providers/types.js';
/**
 * Bumped to 2 when measurement failures started failing the gate.
 *
 * Version 1 entries were computed under the old semantics, where a crashed
 * linter or type-checker became `{errors: 0}` -- so a stored PASS from then may
 * be a vacuous one, and reusing it would carry the defect forward past its fix.
 * `loadCache` discards a mismatched schema, which is exactly the wanted effect.
 */
export interface QualityGateCache {
    schemaVersion: 2;
    entries: Record<string, CacheEntry>;
}
export interface CacheEntry {
    timestamp: number;
    rulesVersion: string;
    rulesHash: string;
    evaluation: {
        status: 'pass' | 'fail';
        failedRules: string[];
    };
    metrics: Metrics;
}
export interface Metrics {
    coverage?: AllCoverageMetrics;
    typescript?: TypescriptMetrics;
    eslint?: EslintMetrics;
    sonarqube?: SonarqubeMetrics;
    bundle?: BundleMetrics;
    scripts: Record<string, 'pass' | 'fail'>;
    sloc?: number;
    /** Custom user-defined metrics (path without "custom." prefix → value) */
    custom?: Record<string, number>;
    /**
     * Measurements that could not be taken, and why.
     *
     * Carried inside Metrics rather than passed beside it deliberately. Every
     * dimension above is optional, so "absent" already means two different
     * things -- nobody asked for it, or asking failed -- and only this list tells
     * them apart. A ceiling on an absent metric is silently skipped by
     * `evaluateRules`, which is how a dead linter used to pass; the failures
     * recorded here are what make that same absence loud.
     *
     * It travels with the data so that no call site can forget to forward it. A
     * fourth parameter to `evaluateRules` would have to be threaded through six
     * call sites, and the one that got missed would be a silent hole of exactly
     * the kind this field exists to close.
     */
    measurementFailures?: readonly MeasurementFailure[];
}
/**
 * Normalized metrics for smoother gradient descent behavior.
 * Discrete counts are transformed to per-kSLOC densities.
 */
export interface NormalizedMetrics {
    coverageBranches: number;
    coverageStatements: number;
    coverageLines: number;
    coverageFunctions: number;
    duplications: number;
    bugsPerKsloc: number;
    vulnerabilitiesPerKsloc: number;
    smellsPerKsloc: number;
    blockerPerKsloc: number;
    criticalPerKsloc: number;
    majorPerKsloc: number;
    minorPerKsloc: number;
    typescriptErrors: number;
    eslintErrors: number;
}
export interface TrajectoryPoint {
    key: string;
    timestamp: number;
    metrics: NormalizedMetrics;
    qualityScore: number;
    passed: boolean;
}
export interface Trajectory {
    points: TrajectoryPoint[];
    totalDescent: number;
    averageStepSize: number;
    monotonicSteps: number;
    regressionSteps: number;
    convergenceState: ConvergenceState;
}
export type ConvergenceState = 'improving' | 'converged' | 'stagnating' | 'oscillating';
export interface AllCoverageMetrics {
    lambda?: CoverageMetrics;
    unit?: CoverageMetrics;
    union?: CoverageMetrics;
}
export interface CoverageMetrics {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
}
export interface TypescriptMetrics {
    errors: number;
    warnings: number;
    rootCauses?: number;
}
export interface EslintMetrics {
    errors: number;
    warnings: number;
    rootCauses?: number;
}
/**
 * A root cause identifies the source of potentially cascading errors.
 * Multiple errors with the same root cause count as ONE issue.
 */
export interface RootCause {
    file: string;
    code: string;
    symbolPath?: string;
    line?: number;
}
/**
 * Groups errors by root cause to restore local continuity.
 * Cascading errors from one root cause = one unit of improvement when fixed.
 */
export interface RootCauseGroup {
    rootCause: RootCause;
    errorCount: number;
    messages: string[];
}
export interface SonarqubeMetrics {
    bugs: number;
    vulnerabilities: number;
    codeSmells: number;
    coverage: number;
    duplications: number;
    blocker: number;
    critical: number;
    major: number;
    minor: number;
    info: number;
}
export interface BundleMetrics {
    totalSize: number;
    chunks: Record<string, number>;
}
export interface QualityRules {
    version: string;
    description: string;
    rules: {
        floors?: Record<string, number>;
        ceilings?: Record<string, number>;
        monotonic?: MonotonicRule[];
        requiredScripts?: string[];
    };
}
export interface MonotonicRule {
    direction: 'up' | 'down';
    metrics: string[];
}
export interface EvaluationResult {
    status: 'pass' | 'fail';
    failedRules: FailedRule[];
}
export interface FailedRule {
    type: 'floor' | 'ceiling' | 'monotonic' | 'script' | 'measurement';
    rule: string;
    message: string;
    baseline?: number;
    current?: number;
}
export interface FileInfo {
    path: string;
    degree: number;
    localDependencies: string[];
    dependencyCount: number;
    directDependents: number;
    indirectDependents: number;
    impact: number;
    coverage?: CoverageMetrics;
}
export interface OptimizationConfig {
    strategy: 'greedy' | 'sampled';
    candidates?: number;
    severityWeights?: Record<string, number>;
    priorityWeights?: PriorityWeights;
}
export interface PriorityWeights {
    coverage: number;
    ease: number;
    impact: number;
    severity: number;
}
export interface PrioritizedFile {
    file: FileInfo;
    priority: number;
    components: {
        coverageGap: number;
        easeOfTesting: number;
        importance: number;
        severityScore: number;
    };
}
//# sourceMappingURL=types.d.ts.map