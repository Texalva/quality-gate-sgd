/**
 * Metrics Extraction Module
 * Extracts quality metrics from various sources
 */
import type { Metrics, CoverageMetrics, AllCoverageMetrics, SonarqubeAnalysisProvenance, SonarqubeMetrics, EslintMetrics, TypescriptMetrics } from './types.js';
import { type CustomDimensionConfig } from './dimensions/index.js';
import type { MeasurementFailure } from './providers/types.js';
/**
 * The coverage numbers and the reasons any of them are missing, together.
 *
 * `reads` is deliberately NOT surfaced here. The provider records what it looked
 * at (CoverageReading.reads) and targets/extract.ts uses that to warn about a
 * detail report it could not use, but nothing on the METRICS path judges the
 * reports themselves -- see the note on ReportAttempt.modifiedMs, and #39 for the
 * open question of how a report's provenance should be established. Returning a
 * field no caller reads would suggest something here checks it.
 */
export declare function measureCoverage(options?: {
    readonly absentReportIsFailure?: boolean;
}): {
    readonly metrics: AllCoverageMetrics;
    readonly failures: readonly MeasurementFailure[];
};
/**
 * Extract all three coverage metrics: lambda-only, unit-only, and union.
 *
 * Returns `{}` rather than `undefined` when nothing could be read, because
 * `extractAllMetrics` assigns this straight to `metrics.coverage` and callers
 * distinguish "no coverage numbers" from "no coverage key" already.
 *
 * As with extractTypescriptMetrics, absence is only half the fix: this wrapper
 * discards the REASON, so a caller using it directly gets an honest blank and no
 * diagnosis. The gate path uses `measureCoverage` for exactly that reason.
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
/**
 * A reading of the sonarqube dimension, or the reason there is none.
 *
 * The reason is the whole point of this shape. `extractSonarqubeMetrics` returned a
 * bare `undefined` from a catch, from a parse failure and from an empty `measures`
 * array, and `extractAllMetrics` never looked at sonarqube when building
 * `measurementFailures` -- so the dimension could vanish entirely while the run was
 * graded as a complete reading. REPRODUCED: a server answering 200 on `/` and 401 on
 * `/api/measures/component` produced `✓ Quality gate PASSED`, exit 0, with three
 * configured sonarqube ceilings never evaluated and nothing said about any of them;
 * the second run printed `PASSED (cached)`.
 *
 * A kind per outcome, because each sends the adopter somewhere different: the URL is
 * wrong (`tool-missing`), the token is wrong (`access-denied`), the project key was
 * never provisioned (`report-missing`), the analysis genuinely published no measures or
 * only some of them (`measured-nothing`), the body is not a reading at all
 * (`unparseable-output`), the status is not 200 (`crashed`), or the numbers belong to
 * an analysis nobody here submitted (`wrong-subject`). The list is enumerated in
 * providers/types.ts and it grows; what must not happen is this comment naming a fixed
 * count, which it did -- "four outcomes, four kinds" survived two kinds arriving.
 *
 * `provenance` is a third FIELD rather than an eighth kind because it answers a
 * question neither of the other two can: the reading is COMPLETE and its origin is
 * unproven. Present exactly when `metrics` is -- a failure has no provenance to state
 * -- and `evaluateRules` turns an unconfirmed one into an `unevaluated` entry, never
 * into a failed rule.
 */
export interface SonarqubeReading {
    readonly metrics?: SonarqubeMetrics;
    readonly failure?: MeasurementFailure;
    readonly provenance?: SonarqubeAnalysisProvenance;
}
export declare function extractSonarqubeMetrics(): SonarqubeMetrics | undefined;
/**
 * What a scan actually submitted, as the CE task described it.
 *
 * `not-scanned` is deliberately OUTSIDE this union and inside `SubmittedAnalysis`
 * below, so a caller that ran a scan cannot express "no scan ran": the gate path
 * receives one of these two and physically cannot lose the binding by forgetting a
 * field.
 *
 * `branch` and `pullRequest` are carried for the failure MESSAGE and are never read by
 * any branch of the logic. `TaskFormatter.setBranchOrPullRequest` fills them from the CE
 * task's characteristics, so an explicit `-Dsonar.branch.name=main` sets `branch` for
 * what IS the default branch; branching on their presence would false-fail those
 * projects catastrophically while looking like a refinement.
 */
export type SubmittedAnalysisFromScan = {
    readonly kind: 'named';
    readonly taskId: string;
    readonly analysisId: string;
    readonly branch?: string;
    readonly pullRequest?: string;
} | {
    readonly kind: 'unnamed';
    readonly taskId: string;
};
/**
 * What a reading knows about where its numbers came from.
 *
 * `not-scanned` is the honest description of `score`, `suggest` and the MCP handlers:
 * they read the project's current numbers without publishing anything, so there is no
 * analysis of theirs to check against.
 */
export type SubmittedAnalysis = SubmittedAnalysisFromScan | {
    readonly kind: 'not-scanned';
};
/**
 * The result of running a scan: the analysis it submitted, or why it did not.
 *
 * `error?: undefined` on the success branch exists so the union can be read for its
 * error without narrowing, which is how every existing caller and test reads it.
 * `submitted` gets no such escape hatch on the failure branch, because reading it
 * without narrowing is exactly the confusion this type prevents.
 */
export type SonarqubeScanOutcome = {
    readonly success: true;
    readonly submitted: SubmittedAnalysisFromScan;
    readonly error?: undefined;
} | {
    readonly success: false;
    readonly error: string;
};
export declare function readSonarqubeMetrics(submitted?: SubmittedAnalysis): SonarqubeReading;
/**
 * Whether there is a SonarQube server here at all.
 *
 * It used to return `true` whenever curl did not throw, which is to say whenever
 * something accepted a TCP connection. `-o /dev/null -w "%{http_code}"` fetched the
 * status and then discarded it, so a 401, a 503 or an nginx error page all read as
 * "available", the gate ran the scan, and the failure surfaced -- if at all -- as an
 * absent dimension much further downstream.
 *
 * Deliberately still tolerant of 4xx. A root URL behind auth answers 401 while the
 * API is perfectly usable with a token, so refusing here would be wrong; what this
 * has to exclude is "nothing answered" and "the server is broken". Authorization is
 * judged where it is actually exercised, by `readSonarqubeMetrics`, which can say
 * which endpoint refused and why.
 */
export declare function isSonarqubeAvailable(): boolean;
export declare function runSonarqubeScan(): SonarqubeScanOutcome;
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
    /**
     * Whether an absent coverage summary is a measurement failure. Defaults to
     * TRUE, which is the safe direction: a caller that forgets this gets the loud
     * reading.
     *
     * The caller resolves it because the answer depends on the RULES, which this
     * module does not see. `QUALITY_COVERAGE_REQUIRED=false` is a project saying it
     * has no coverage; a project that also grades coverage has contradicted that,
     * and honouring the flag there would silently disable a rule it wrote. See
     * `coverageAbsenceIsFailure` in cli.ts.
     */
    coverageAbsenceIsFailure?: boolean;
    /**
     * Which analysis this run submitted, so the sonarqube measures can be tied to it.
     *
     * The CALLER resolves it, following the `coverageAbsenceIsFailure` precedent, because
     * `runSonarqubeScan` is called from cli.ts and not from here -- the identity can only
     * reach the measures read by being threaded through.
     *
     * Optional on THIS signature and REQUIRED on `extractAllMetricsAsync`, which is the
     * verdict path. Absence means `not-scanned`, which is the honest description of
     * `score`, `suggest` and the refactor harness: they read the project's current numbers
     * without publishing anything. It is not an honest description of a gate run, and this
     * repository has already lost enforcement once at exactly this boundary --
     * `extractAllMetricsAsync` was exported and never called, so no custom extractor ever
     * ran and every `custom.*` ceiling was silently skipped. A required parameter is the
     * only thing that makes a future call site say `not-scanned` out loud.
     */
    submittedAnalysis?: SubmittedAnalysis;
}
export declare function extractAllMetrics(scriptsToRunOrOptions?: string[] | MetricsExtractionOptions): Metrics;
/**
 * The dimensions a reading is missing, for the surfaces that report a NUMBER
 * rather than a verdict.
 *
 * `score` and `suggest` cannot reasonably refuse to answer the way the gate
 * does -- a fitness score over the dimensions that could be read is still the
 * most useful thing available. What they must not do is present it as complete.
 * A score silently computed over a smaller quality space than the project
 * configured reads as "you are at 82" when the honest statement is "you are at
 * 82 across the dimensions I could measure, and one of them I could not".
 *
 * Returns `undefined` rather than an empty array so it disappears from JSON
 * output entirely when everything was measured.
 */
export declare function describeUnmeasured(metrics: Metrics): readonly {
    readonly dimension: string;
    readonly kind: string;
    readonly why: string;
}[] | undefined;
/**
 * Async version of extractAllMetrics that loads custom dimensions from config.
 *
 * Every path that produces a GATE VERDICT has to use this rather than
 * `extractAllMetrics`, and until now none did. `extractAllMetricsAsync` was
 * exported and never called: the CLI and the MCP server both went through the
 * synchronous version with no `customDimensions`, so no custom extractor ever
 * ran, `metrics.custom` was always absent, and `evaluateCeilings` skipped every
 * configured `custom.*` ceiling in silence. The dimensions were not merely
 * unmeasured -- the rules written against them were never enforced at all.
 *
 * `submittedAnalysis` is REQUIRED here and optional on `extractAllMetrics` for that
 * same history: this is the verdict path, and the divergence above is what an optional
 * field at a module boundary produced last time. A caller that publishes nothing has to
 * write `{ kind: 'not-scanned' }` and be visible doing it.
 */
export declare function extractAllMetricsAsync(options: MetricsExtractionOptions & {
    submittedAnalysis: SubmittedAnalysis;
}): Promise<Metrics>;
export {};
//# sourceMappingURL=metrics.d.ts.map