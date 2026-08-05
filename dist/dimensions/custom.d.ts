/**
 * Custom Dimensions
 * =================
 * Support for user-defined metrics via script extractors.
 *
 * Users configure custom dimensions in quality-gate.config.ts:
 *
 * ```typescript
 * export const customDimensions: CustomDimensionConfig[] = [
 *   {
 *     path: 'custom.anyCount',
 *     displayName: 'TypeScript "any" Usage',
 *     description: 'Count of "any" type annotations',
 *     direction: 'lower-better',
 *     continuity: 'discrete',
 *     defaultWeight: 0.03,
 *     extractor: {
 *       type: 'script',
 *       command: 'grep -r "any" src/ --include="*.ts" | wc -l',
 *       // grep exits 1 when it matches nothing, and extractors run with
 *       // `pipefail`, so a genuine count of zero has to be declared as success.
 *       // See EXTRACTOR_SHELL for why pipefail is not optional.
 *       successExitCodes: [0, 1],
 *     }
 *   }
 * ];
 * ```
 *
 * WHERE THEY RUN. In the project root -- `config.projectRoot`, the same directory
 * every other dimension is measured against -- and not in whatever directory the CLI
 * was invoked from. So a relative path in a command (`src/`, `./marker.txt`) resolves
 * against the project, and the reading does not change with the caller's shell.
 *
 * If an extractor was written against the old behaviour, the failure to look for is
 * not a crash. A command whose paths are missing in the project root fails loudly, and
 * a failed extractor is a reported measurement failure. The quiet one is a command
 * whose paths exist in BOTH trees: `find . -name "*.ts" | wc -l` counts more files
 * from a repository root than from a package root, so a ceiling calibrated against one
 * number is now graded against another with nothing to say why. Prefer paths anchored
 * inside the project to `..` or to absolute paths outside it.
 */
import type { MeasurementFailure, Result } from '../providers/types.js';
import { type DimensionDirection, type DimensionContinuity } from './registry.js';
export interface ScriptExtractor {
    type: 'script';
    /** Command to run (can use shell syntax) */
    command: string;
    /** How to parse the output (default: 'number' - extract first number from output) */
    parseOutput?: 'number' | 'json' | 'regex';
    /** JSONPath expression if parseOutput is 'json' (e.g., '$.summary.total') */
    jsonPath?: string;
    /** Regex pattern with capture group if parseOutput is 'regex' */
    regex?: string;
    /** Timeout in ms (default: 30000) */
    timeout?: number;
    /**
     * Exit codes that mean the command ran and its output can be trusted
     * (default: `[0]`).
     *
     * Needed because a non-zero exit is now a gate failure rather than a silent
     * zero, and some perfectly good extractors exit non-zero by design:
     * `grep -c pattern file` exits 1 when the count is 0, and `diff` exits 1 when
     * files differ. Those used to throw and score 0, which happened to be the
     * right answer for grep and the wrong one for everything else.
     *
     * Declaring `[0, 1]` is strictly better than the obvious workaround of
     * appending `|| true` to the command: it keeps grep's exit 2 ("an actual
     * error") a failure, whereas `|| true` makes every failure invisible again.
     */
    successExitCodes?: readonly number[];
}
export interface CustomDimensionConfig {
    /** Must start with "custom." */
    path: string;
    /** Human-readable name */
    displayName: string;
    /** Description for MCP/LLM context */
    description?: string;
    /** Optimization direction */
    direction: DimensionDirection;
    /** SGD suitability */
    continuity?: DimensionContinuity;
    /** Weight for fitness function (default: 0.01) */
    defaultWeight?: number;
    /** How to extract the metric value */
    extractor: ScriptExtractor;
}
/**
 * Load custom dimensions from the project's config file.
 * Returns an empty array if no config file exists.
 *
 * THROWS when a config file exists, declares custom dimensions, and they cannot
 * be read -- rather than returning the empty array it used to.
 *
 * Returning `[]` there was the quietest failure in this tool. `custom.*`
 * dimensions are gated by ceilings alone, and `evaluateCeilings` skips a metric
 * it cannot find without a word, so an unloadable config did not merely lose the
 * dimensions: it deleted every rule that referred to them and the gate went
 * green having enforced strictly less than it was configured to. A syntax error
 * in a config file became a weaker quality gate.
 *
 * Throwing rather than reporting a MeasurementFailure because this is not a
 * measurement that failed -- it is a tool that cannot be configured, and no
 * per-dimension reading exists to attach the failure to. `main()` in cli.ts
 * turns it into a message and exit 1.
 *
 * @param basePath - Directory to search for config file (default: cwd)
 */
export declare function loadCustomDimensions(basePath?: string): Promise<CustomDimensionConfig[]>;
/**
 * Extract a custom metric by running its extractor.
 *
 * Returns a failure rather than `0` when the command cannot run or its output
 * cannot be read. Zero was the wrong answer in the most dangerous possible
 * direction: `custom.*` dimensions are gated by ceilings and never by floors,
 * every `lower-better` dimension is at its BEST at zero, and a missing ceiling
 * metric is skipped in silence. So a broken extractor did not merely lose a
 * reading -- it reported a perfect score, and the more thoroughly the command
 * failed the better the project looked.
 *
 * @param config - Custom dimension config
 */
export declare function extractCustomMetric(config: CustomDimensionConfig, projectRoot: string): Result<number, MeasurementFailure>;
/**
 * Register all custom dimensions from config.
 * Should be called early in the CLI lifecycle.
 *
 * @param basePath - Directory to search for config file
 */
export declare function registerCustomDimensions(basePath?: string): Promise<CustomDimensionConfig[]>;
/**
 * The readings that succeeded, and the failures for those that did not.
 *
 * Both halves are load-bearing and neither is sufficient. A failed dimension is
 * ABSENT from `metrics` rather than zero, which stops it satisfying a ceiling;
 * but absence alone is quiet, since `evaluateCeilings` skips a metric it cannot
 * find. The `failures` are what make it loud.
 */
export interface CustomMetricsReading {
    readonly metrics: Record<string, number>;
    readonly failures: readonly MeasurementFailure[];
}
/**
 * Extract all custom metrics.
 *
 * One broken extractor does not stop the others: a run that reports every
 * dimension it could measure alongside every dimension it could not is more
 * useful than one that stops at the first failure.
 *
 * @param configs - Custom dimension configs (from loadCustomDimensions)
 * @param projectRoot - The directory the extractors run in. See extractCustomMetric.
 */
export declare function extractAllCustomMetrics(configs: readonly CustomDimensionConfig[], projectRoot: string): CustomMetricsReading;
//# sourceMappingURL=custom.d.ts.map