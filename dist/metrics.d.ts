/**
 * Metrics Extraction Module
 * Extracts quality metrics from various sources
 */
import type { Metrics, CoverageMetrics, AllCoverageMetrics, SonarqubeMetrics, EslintMetrics, TypescriptMetrics } from './types.js';
import { type CustomDimensionConfig } from './dimensions/index.js';
/**
 * Extract all three coverage metrics: lambda-only, unit-only, and union.
 */
export declare function extractAllCoverageMetrics(): AllCoverageMetrics;
/**
 * Extract coverage metrics for quality gate.
 * Returns the union coverage for backward compatibility.
 * @deprecated Use extractAllCoverageMetrics() for full coverage data.
 */
export declare function extractCoverageMetrics(): CoverageMetrics | undefined;
export interface SonarIssue {
    severity: string;
    type: string;
    message: string;
    component: string;
    line?: number;
    rule: string;
}
export declare function getTopSonarIssues(limit?: number): SonarIssue[];
export declare function extractSonarqubeMetrics(): SonarqubeMetrics | undefined;
export declare function isSonarqubeAvailable(): boolean;
export declare function runSonarqubeScan(): {
    success: boolean;
    error?: string;
};
/**
 * Type-check totals, or `undefined` when the type-check could not be run.
 *
 * `undefined` rather than `{errors: 0}`. Returning zero was the vacuous pass:
 * the old inline implementation scanned whatever output arrived with no
 * exit-code check at all, so a crashed, killed, or missing type-check produced
 * an empty string, matched no diagnostics, and satisfied a
 * `typescript.errors: 0` ceiling.
 *
 * Absence alone would not fix that -- `evaluateCeilings` skips a missing metric
 * just as quietly. What makes it loud is `extractAllMetrics` recording the
 * MeasurementFailure alongside, which `evaluateRules` fails on. Callers using
 * this function directly get the honest `undefined` and no diagnosis; that is
 * why the gate path does not use it.
 */
export declare function extractTypescriptMetrics(): TypescriptMetrics | undefined;
/**
 * Lint totals, or `undefined` when eslint could not be run.
 *
 * Replaces `errors: exitCode === 0 ? 0 : 1`, which was wrong twice over: a
 * linter that could not run was reported as one ordinary lint error, and a
 * failure that happened to exit 0 -- a broken config, an empty report -- as a
 * clean project. See extractTypescriptMetrics for why absence is only half the
 * fix.
 */
export declare function extractEslintMetrics(): EslintMetrics | undefined;
export declare function runScript(script: string): 'pass' | 'fail';
export declare function runScripts(scripts: string[]): Record<string, 'pass' | 'fail'>;
/**
 * Count source lines of code in a directory.
 * Uses a simple heuristic: non-empty, non-comment lines in .ts/.tsx/.js/.jsx files.
 * For determinism, always scans the same directories with the same rules.
 */
export declare function extractSloc(srcDir?: string): number;
interface MetricsExtractionOptions {
    scriptsToRun?: string[];
    skipSonarQube?: boolean;
    /** Pre-loaded custom dimension configs (if already loaded) */
    customDimensions?: CustomDimensionConfig[];
    /** Whether to skip custom dimension extraction (default: false) */
    skipCustomDimensions?: boolean;
}
export declare function extractAllMetrics(scriptsToRunOrOptions?: string[] | MetricsExtractionOptions): Metrics;
/**
 * Async version of extractAllMetrics that loads custom dimensions from config.
 * Use this when you want automatic custom dimension discovery.
 */
export declare function extractAllMetricsAsync(options?: MetricsExtractionOptions): Promise<Metrics>;
export {};
//# sourceMappingURL=metrics.d.ts.map