/**
 * ESLint Lint Provider
 * ====================
 * The existing eslint extraction, moved behind LintProvider unchanged.
 *
 * This is a structural change only. The parsing below is deliberately
 * identical to what previously lived in metrics.ts and targets/extract.ts,
 * including the parts that look redundant, because the whole point of this
 * step is that the frozen apollo-client baseline still reports ACCEPTED
 * afterwards. Improvements belong in later steps where their diffs can be
 * reviewed on their own.
 *
 * The PARSING is still that untouched move. The INVOCATION is not: the pre-flight
 * refusal and the launcher-refusal relabelling below were added later, for backlog #47,
 * and are the one part of this file that is not like-for-like.
 *
 * Two fidelity details worth naming, since both look like things to tidy up:
 *
 *   - Totals come from eslint's own `errorCount`/`warningCount` per file, NOT
 *     from counting `messages`. Those can differ -- fatal parse errors bump the
 *     count without producing an ordinary message -- so deriving one from the
 *     other would quietly change the numbers.
 *
 *   - `|| '[]'` on empty stdout is preserved. It is half of the original
 *     silent-failure bug and step 6 removes it; it survives here only because
 *     classifyProcessOutput now catches the dangerous cases (a dead, killed,
 *     or truncated process) before parsing is ever reached.
 */
import type { LintProvider } from './types.js';
/** One finding, as emitted by `eslint --format json`. */
export interface EslintMessage {
    ruleId: string | null;
    severity: number;
    message: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
}
/** One file's worth of findings, as emitted by `eslint --format json`. */
export interface EslintFileResult {
    filePath: string;
    errorCount: number;
    warningCount: number;
    messages: EslintMessage[];
}
export declare const eslintLintProvider: LintProvider;
//# sourceMappingURL=eslint.d.ts.map