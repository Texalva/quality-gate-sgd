/**
 * Istanbul Coverage Provider
 * ==========================
 * The coverage extraction, moved behind CoverageProvider.
 *
 * Coverage was the last dimension read in two unrelated places. The METRICS came
 * from `coverage-summary.json` (metrics.ts), the ISSUES from Istanbul's
 * `coverage-final.json` with a summary fallback (targets/extract.ts), and
 * nothing checked that the two agreed -- a full extraction read the reports
 * twice, so the reported 23.86% and the reported findings could legitimately
 * come from two different generations of the report. types.ts pairs metrics and
 * issues in ONE reading precisely because they are one observation of one tool;
 * this file is where coverage finally becomes that.
 *
 * The arithmetic, the iteration order and every message string below are
 * deliberately IDENTICAL to what lived in metrics.ts and targets/extract.ts,
 * including the parts that look like tidy-up candidates, because the frozen
 * apollo-client baseline compares captures with raw `JSON.stringify` equality.
 * Four things that are load-bearing and look like bugs or redundancy:
 *
 *   - `unit` comes from `total.<dim>.pct`, which istanbul rounds to 2 dp, while
 *     `union` is recomputed from the per-file entries at full precision. They
 *     are genuinely different numbers (23.86 vs 23.869346733668344) and
 *     collapsing one into the other moves the baseline.
 *   - the coverage-final walk labels every issue `coverage.unit.*` even when the
 *     file it is reading is the LAMBDA report. That is pre-existing and
 *     preserved; changing it is a separate, reviewable step.
 *   - `mergeCoverageReports` does not apply `shouldSkipCoverageFile`, so it
 *     counts node_modules and test files that the issue extractor drops. Also
 *     pre-existing.
 *   - the emission ORDER of issues (finals before summaries, unit before lambda,
 *     per file in `Object.entries` order, branches before functions) is compared
 *     as a raw array. Sorting "for determinism" is a rejection.
 */
import type { CoverageProvider, CoverageSuite } from './types.js';
/**
 * The setting an adopter changes to point a suite somewhere else.
 *
 * Named in every coverage failure message: "the report is broken" is only half a
 * diagnosis if the reader cannot tell which knob produced the path.
 */
export declare const SUITE_SETTING: Record<CoverageSuite, string>;
/**
 * Where one project keeps its coverage reports.
 *
 * A factory taking these rather than a singleton reading global config, because
 * the paths are per-project and neither existing provider reaches for config of
 * its own. `lambdaDir` is optional because most projects have exactly one suite.
 */
export interface CoverageReportPaths {
    readonly unitDir: string;
    readonly lambdaDir?: string;
    readonly summaryFile: string;
}
/**
 * What the caller wants out of the reading.
 *
 * `issues: 'skip'` exists because the METRICS path does not use them and paying
 * for them there is not free. `coverage-final.json` is the largest artifact this
 * tool touches -- one entry per source file, with a statementMap, an fnMap and a
 * branchMap each -- and before this extraction the metrics path never opened it
 * at all. Collecting issues for a caller that discards them means reading,
 * parsing, validating and walking BOTH detail reports and holding the complete
 * LocatedIssue array, so a full extraction (metrics, then findings) does it twice
 * and peaks at two copies. On a monorepo with a 150 MB detail report that is an
 * out-of-memory kill rather than a slow run.
 *
 * A provider-construction option rather than a field on MeasurementContext: the
 * context is shared by every provider and none of the others has a second
 * artifact to decline, so an ignored flag there would be a budget nothing
 * enforces. Each call site already builds its own provider.
 */
export interface CoverageProviderOptions {
    /** 'collect' (default) walks the detail reports; 'skip' does not open them. */
    readonly issues?: 'collect' | 'skip';
}
export declare function createIstanbulCoverageProvider(paths: CoverageReportPaths, options?: CoverageProviderOptions): CoverageProvider;
//# sourceMappingURL=coverage.d.ts.map