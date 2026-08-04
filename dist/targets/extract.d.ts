/**
 * Located Issue Extraction
 * ========================
 * Extracts issues with location information from all quality sources.
 *
 * Unlike the metrics extraction (which aggregates to counts), this preserves
 * the file:line:column information so we can compute target-space gradients.
 */
import type { LocatedIssue, ExtractedIssues, ExtractLocatedIssuesOptions } from './types.js';
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
 */
export declare function extractSonarqubeIssues(): LocatedIssue[];
/**
 * Extract located issues from all sources.
 *
 * This is the main entry point for Phase 2 of the location-aware targets system.
 *
 * When a symbolTable is provided in options, issues will be enriched with
 * symbol information for unified cross-axis analysis.
 */
export declare function extractLocatedIssues(options?: ExtractLocatedIssuesOptions): ExtractedIssues;
//# sourceMappingURL=extract.d.ts.map