/**
 * Located Issue Extraction
 * ========================
 * Extracts issues with location information from all quality sources.
 *
 * Unlike the metrics extraction (which aggregates to counts), this preserves
 * the file:line:column information so we can compute target-space gradients.
 */
import type { LocatedIssue, ExtractedIssues, ExtractLocatedIssuesOptions } from './types.js';
import type { MeasurementFailure } from '../providers/types.js';
/**
 * Findings, plus the reason there might be none.
 *
 * Each `read*Issues` below returns this and each `extract*Issues` unwraps it to the
 * bare array. Two functions rather than one changed signature because the bare array
 * is the shape every existing caller and test already asks for, and widening the
 * contract everywhere to reach one new consumer is churn that hides the change.
 */
interface IssueReading {
    issues: LocatedIssue[];
    failures: MeasurementFailure[];
}
/**
 * Extract uncovered branches and functions with location information.
 *
 * Delegates to the coverage provider; the parsing that used to live here now
 * lives in src/providers/coverage.ts, unchanged -- including the summary
 * fallback, which fires on `issues.length === 0` rather than on the detail
 * report's absence, so a detail report that parsed fine and found nothing
 * uncovered still falls through to the coarser file-level findings.
 *
 * `coverageDir` keeps its exact previous meaning: it replaces ONLY the unit
 * directory, for both the detail report and the summary, and the lambda
 * directory still comes from config.
 */
export declare function extractCoverageIssues(coverageDir?: string): LocatedIssue[];
/**
 * Extract TypeScript errors with location information.
 *
 * Delegates to the typecheck provider; the parsing that used to live here now
 * lives in src/providers/typescript.ts, unchanged.
 */
export declare function extractTypescriptIssues(): LocatedIssue[];
/**
 * Extract ESLint issues with location information.
 *
 * Delegates to the eslint provider; the parsing that used to live here now
 * lives in src/providers/eslint.ts, unchanged.
 */
export declare function extractEslintIssues(): LocatedIssue[];
/**
 * Extract SonarQube issues with location information.
 *
 * The lossy wrapper, kept because it is exported from the package root. Callers that
 * need to know whether an empty list means "no findings" or "could not ask" want
 * {@link readSonarqubeIssues}.
 */
export declare function extractSonarqubeIssues(): LocatedIssue[];
/**
 * SonarQube issues, and the reason if they could not be read.
 *
 * The last source with no failure channel. Every exit from the loop below used to
 * return `issues` -- a token that will not load, a curl that exits nonzero, a page
 * of JSON that will not parse -- so a refused query and a genuinely clean project
 * were the same empty array. The advice channel reported "nothing to fix" for a
 * server it never reached, which is the same defect `readCoverageIssues` and
 * `readTypescriptIssues` were given channels for.
 *
 * A partial result is a failure too, and deliberately still carries the issues it
 * did fetch: page 3 failing after two good pages is not five hundred findings, and
 * saying so is more useful than either discarding them or presenting them as the
 * whole set.
 */
export declare function readSonarqubeIssues(): IssueReading;
/**
 * Extract located issues from all sources.
 *
 * This is the main entry point for Phase 2 of the location-aware targets system.
 *
 * When a symbolTable is provided in options, issues will be enriched with
 * symbol information for unified cross-axis analysis.
 */
export declare function extractLocatedIssues(options?: ExtractLocatedIssuesOptions): ExtractedIssues;
export {};
//# sourceMappingURL=extract.d.ts.map