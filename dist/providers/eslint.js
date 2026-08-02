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
import { spawnSync } from 'child_process';
import { buildEvidence, classifyProcessOutput, err, measurementFailure, ok } from './result.js';
const ESLINT_ARGS = ['eslint', '--format', 'json', 'src/'];
const COMMAND = `npx ${ESLINT_ARGS.join(' ')}`;
/** eslint's own severity encoding: 2 is an error, 1 a warning, 0 disabled. */
const SEVERITY_ERROR = 2;
/**
 * 0 is clean and 1 means findings -- both are successful measurements. 2 means
 * the eslint command itself failed, and its report must not be read as one.
 *
 * The common shape is a broken config: eslint exits 2 having linted nothing and
 * printing NO stdout, which the old code turned into `[]` and reported as a
 * clean project satisfying an `eslint.errors: 0` ceiling. Verified against a
 * deliberately malformed config.
 *
 * Exit 2 does not always mean empty output, though -- eslint prints results
 * before some post-run checks, so a stale-suppressions failure can emit a
 * complete report and still exit 2. Refusing it is still right (eslint is
 * saying the run was not valid), which is why the diagnosis below talks about
 * a failed run rather than claiming nothing was produced.
 */
const ESLINT_SUCCESS_EXIT_CODES = [0, 1];
/**
 * eslint's JSON is an array of per-file objects, each carrying numeric counts
 * and a `messages` array of objects with numeric severities.
 *
 * Validated rather than asserted because parse and iteration used to share one
 * try/catch, so a well-formed-JSON-but-wrong-shape payload landed on the
 * failure path; guarding only the parse let a TypeError escape `measure()`.
 *
 * EVERY field the code below reads is checked, not just the outer shape. A
 * shallower version of this function still admitted three defects:
 *
 *   - `messages: [null]` passed, then threw on `msg.severity`.
 *   - Absent `errorCount` silently became 0 via `|| 0`, so a malformed report
 *     read as a clean one.
 *   - `errorCount: "7"` made `errors` the STRING "07" by concatenation, which
 *     rules.ts then rejected as non-numeric and skipped -- and a skipped
 *     ceiling passes. A wrong type became a green build.
 */
function asEslintResults(parsed) {
    if (!Array.isArray(parsed))
        return null;
    for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null)
            return null;
        const file = entry;
        if (!Number.isFinite(file.errorCount) || !Number.isFinite(file.warningCount))
            return null;
        if (!Array.isArray(file.messages))
            return null;
        for (const msg of file.messages) {
            if (typeof msg !== 'object' || msg === null)
                return null;
            // Severity decides error-vs-warning for both the counts and the issue
            // list; a non-number silently classifies everything as a warning.
            if (!Number.isFinite(msg.severity))
                return null;
        }
    }
    return parsed;
}
/**
 * Distinct (file, rule) pairs among errors only.
 *
 * Warnings are excluded and this is not a message count: twelve instances of
 * one rule in one file are one thing to fix, and the gate uses this to reward
 * fixing causes rather than symptoms.
 */
function countRootCauses(results) {
    const rootCauses = new Set();
    for (const fileResult of results) {
        for (const msg of fileResult.messages) {
            if (msg.severity === SEVERITY_ERROR && msg.ruleId) {
                rootCauses.add(`${fileResult.filePath}:${msg.ruleId}`);
            }
        }
    }
    return rootCauses.size;
}
function toMetrics(results) {
    let errors = 0;
    let warnings = 0;
    for (const r of results) {
        errors += r.errorCount || 0;
        warnings += r.warningCount || 0;
    }
    return { errors, warnings, rootCauses: countRootCauses(results) };
}
function toIssues(results) {
    const issues = [];
    for (const fileResult of results) {
        for (const msg of fileResult.messages) {
            const isError = msg.severity === SEVERITY_ERROR;
            const dimension = isError ? 'eslint.errors' : 'eslint.warnings';
            issues.push({
                file: fileResult.filePath,
                line: msg.line,
                column: msg.column,
                endLine: msg.endLine,
                endColumn: msg.endColumn,
                source: 'eslint',
                dimension,
                code: msg.ruleId || 'unknown',
                severity: isError ? 'major' : 'minor',
                impact: {
                    dimension,
                    delta: -1,
                    direction: 'lower-better',
                },
                message: msg.message,
                context: msg.ruleId ? `Rule: ${msg.ruleId}` : undefined,
            });
        }
    }
    return issues;
}
export const eslintLintProvider = {
    name: 'eslint',
    dimension: 'eslint',
    measure(context) {
        const startedAt = Date.now();
        const spawn = spawnSync('npx', [...ESLINT_ARGS], {
            cwd: context.projectRoot,
            encoding: 'utf-8',
            shell: true,
            timeout: context.timeoutMs,
            maxBuffer: context.maxBufferBytes,
        });
        const elapsedMs = Date.now() - startedAt;
        const output = classifyProcessOutput(spawn, {
            command: COMMAND,
            dimension: 'eslint',
            elapsedMs,
            timeoutMs: context.timeoutMs,
            maxBufferBytes: context.maxBufferBytes,
            successExitCodes: ESLINT_SUCCESS_EXIT_CODES,
        });
        if (!output.ok)
            return output;
        const unparseable = (detail) => err(measurementFailure('unparseable-output', 'eslint', `\`${COMMAND}\` ${detail}, so no finding count can be derived from it.`, buildEvidence(spawn, COMMAND, elapsedMs)));
        // No `|| '[]'` fallback. eslint's JSON formatter is literally
        // `JSON.stringify(results)`, and even a wholly clean project emits a full
        // per-file report -- so empty stdout is never a legitimate zero-finding
        // result, only a run that produced nothing. The old fallback turned exactly
        // that case into a clean bill of health.
        if (output.value.trim() === '') {
            return unparseable('produced no output at all, though eslint always emits a JSON report');
        }
        let parsed;
        try {
            parsed = JSON.parse(output.value);
        }
        catch {
            return unparseable('produced output that is not valid JSON');
        }
        const results = asEslintResults(parsed);
        if (results === null) {
            return unparseable('produced valid JSON that is not an eslint report');
        }
        return ok({ metrics: toMetrics(results), issues: toIssues(results) });
    },
};
//# sourceMappingURL=eslint.js.map