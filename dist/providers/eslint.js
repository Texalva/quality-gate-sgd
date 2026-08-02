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
        });
        if (!output.ok)
            return output;
        let results;
        try {
            results = JSON.parse(output.value || '[]');
        }
        catch {
            return err(measurementFailure('unparseable-output', 'eslint', `\`${COMMAND}\` produced output that is not valid JSON, so no finding count can be derived from it.`, buildEvidence(spawn, COMMAND, elapsedMs)));
        }
        return ok({ metrics: toMetrics(results), issues: toIssues(results) });
    },
};
//# sourceMappingURL=eslint.js.map