/**
 * Located Issue Extraction
 * ========================
 * Extracts issues with location information from all quality sources.
 *
 * Unlike the metrics extraction (which aggregates to counts), this preserves
 * the file:line:column information so we can compute target-space gradients.
 */
import { spawnSync } from 'child_process';
import { getConfig, getSonarAuthToken, redactUrlCredentials } from '../config.js';
import { mapLocationToSymbol } from '../symbols/mapper.js';
import { eslintLintProvider } from '../providers/eslint.js';
import { typescriptTypecheckProvider } from '../providers/typescript.js';
import { createIstanbulCoverageProvider } from '../providers/coverage.js';
import { DEFAULT_MEASUREMENT_LIMITS, measurementFailure } from '../providers/result.js';
/**
 * See the identical constant in ../metrics.ts. spawnSync's 1 MiB default
 * truncates large linter output and kills the child; the catch blocks below
 * then report zero issues instead of failing, so a noisy codebase looks clean.
 */
const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;
// =============================================================================
// Coverage Issue Extraction
// =============================================================================
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
export function extractCoverageIssues(coverageDir) {
    return readCoverageIssues(coverageDir).issues;
}
function readCoverageIssues(coverageDir) {
    const config = getConfig();
    const reading = createIstanbulCoverageProvider({
        unitDir: coverageDir ?? config.coverage.unitDir,
        lambdaDir: config.coverage.lambdaDir,
        summaryFile: config.coverage.summaryFile,
    }).measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
        packageManager: config.packageManager,
        typecheckScript: config.typecheckScript,
    });
    if (!reading.ok) {
        console.error(`Warning: Could not parse coverage reports: ${reading.error.message}`);
        return { issues: [], failures: [reading.error] };
    }
    // The warning belongs HERE, not in the provider: this is the layer that
    // discards the failure, and the rule is to handle an error or log it, never
    // both.
    //
    // `absent` is not warned about on THIS path, and that is now a narrower claim
    // than it used to be. The provider does report an absent unit summary, as
    // `report-missing`, because the gate grades coverage rules against it -- see
    // readFailure. What this loop is for is fix ADVICE, where a report that does not
    // exist yields no findings and there is nothing to say beyond what the gate
    // already said. The failure itself is discarded here along with every other one,
    // which is #25.
    //
    // `shape: 'unexpected'` is reported alongside a failed read because from this
    // function's point of view they cost the same thing: a report that parsed but
    // is not the shape findings come from yields none, exactly as an unparseable
    // one does.
    // The provider's own `failures` are the SUMMARY-level ones, which the gate already
    // grades on. What this loop adds is the detail reports: `coverage-final.json` is
    // where the line-level findings come from, and the provider deliberately does not
    // promote a broken one to a gate failure because the verdict's numbers come from
    // the summary and stay sound. For fix ADVICE the cost is the whole point -- those
    // findings are exactly what is missing -- so they become failures here, on the
    // channel that carries advice.
    const failures = [...reading.value.failures];
    for (const read of reading.value.reads) {
        const unreadable = read.attempt.outcome !== 'read' && read.attempt.outcome !== 'absent';
        if (!unreadable && read.shape === 'expected')
            continue;
        const reason = unreadable ? read.attempt.outcome : 'not a coverage report';
        console.error(`Warning: Could not parse ${read.attempt.path}: ${reason}`);
        // Only the detail reports. A summary in the same state is already in
        // `reading.value.failures` above, and listing it twice would have the CLI
        // report one broken file as two broken dimensions.
        if (read.kind !== 'final')
            continue;
        failures.push(measurementFailure('unparseable-output', read.suite, `${read.attempt.path} could not be read for findings (${reason}), so the ` +
            `located issues for ${read.suite} are incomplete. The gate's coverage ` +
            'numbers are unaffected -- they come from the summary report.', {
            via: 'report',
            command: `read ${read.attempt.path}`,
            elapsedMs: 0,
            attempts: [read.attempt],
        }));
    }
    return { issues: [...reading.value.issues], failures };
}
// =============================================================================
// TypeScript Issue Extraction
// =============================================================================
/**
 * Extract TypeScript errors with location information.
 *
 * Delegates to the typecheck provider; the parsing that used to live here now
 * lives in src/providers/typescript.ts, unchanged.
 */
export function extractTypescriptIssues() {
    return readTypescriptIssues().issues;
}
function readTypescriptIssues() {
    const config = getConfig();
    const reading = typescriptTypecheckProvider.measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
        packageManager: config.packageManager,
        typecheckScript: config.typecheckScript,
    });
    // The empty list is still returned -- there are no findings to report -- but it no
    // longer travels alone. A type-check that never ran and a project with no type
    // errors are the same `[]` here, and the failure beside it is the only thing that
    // tells them apart.
    if (!reading.ok)
        return { issues: [], failures: [reading.error] };
    const issues = [...reading.value.issues];
    // A SUCCESSFUL reading can still be short on findings, and the provider says so on
    // purpose: the error TOTAL is `max(strictly parsed, loose 'error TSnnnn' matches)`
    // because tsc emits global diagnostics with no file:line prefix (TS18003 "No inputs
    // were found" is one), and `--pretty` puts the location on its own line in a shape
    // the located regex cannot read. Those are real errors the issue list cannot
    // represent -- `metrics.errors === 1` with `issues.length === 0` is a tested,
    // intended combination -- and fix advice that reports only the list would say zero
    // TypeScript errors while the gate counts one. The count is not wrong and the list
    // is not wrong; what was wrong was letting the advice channel see only the list.
    const unlocated = reading.value.metrics.errors - issues.length;
    if (unlocated > 0) {
        return {
            issues,
            failures: [
                measurementFailure('unparseable-output', 'typescript', `${unlocated} of ${reading.value.metrics.errors} type error(s) carry no ` +
                    'file and line, so they cannot be ranked as targets. Global diagnostics ' +
                    '(TS18003 and friends) and --pretty output both do this. Run the ' +
                    'typecheck script directly to see them.', {
                    via: 'report',
                    command: 'typecheck output had diagnostics with no location',
                    elapsedMs: 0,
                    attempts: [],
                }),
            ],
        };
    }
    return { issues, failures: [] };
}
// =============================================================================
// ESLint Issue Extraction
// =============================================================================
/**
 * Extract ESLint issues with location information.
 *
 * Delegates to the eslint provider; the parsing that used to live here now
 * lives in src/providers/eslint.ts, unchanged.
 */
export function extractEslintIssues() {
    return readEslintIssues().issues;
}
function readEslintIssues() {
    const config = getConfig();
    const reading = eslintLintProvider.measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.lintTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
        packageManager: config.packageManager,
        typecheckScript: config.typecheckScript,
    });
    // See readTypescriptIssues.
    return reading.ok
        ? { issues: [...reading.value.issues], failures: [] }
        : { issues: [], failures: [reading.error] };
}
function mapSonarSeverity(severity) {
    switch (severity.toUpperCase()) {
        case 'BLOCKER': return 'blocker';
        case 'CRITICAL': return 'critical';
        case 'MAJOR': return 'major';
        case 'MINOR': return 'minor';
        default: return 'info';
    }
}
function mapSonarTypeToDimension(type) {
    switch (type.toUpperCase()) {
        case 'BUG': return 'sonarqube.bugs';
        case 'VULNERABILITY': return 'sonarqube.vulnerabilities';
        case 'CODE_SMELL': return 'sonarqube.codeSmells';
        default: return 'sonarqube.codeSmells';
    }
}
/**
 * Extract SonarQube issues with location information.
 *
 * The lossy wrapper, kept because it is exported from the package root. Callers that
 * need to know whether an empty list means "no findings" or "could not ask" want
 * {@link readSonarqubeIssues}.
 */
export function extractSonarqubeIssues() {
    return readSonarqubeIssues().issues;
}
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
export function readSonarqubeIssues() {
    const config = getConfig();
    const token = getSonarAuthToken();
    const url = `${redactUrlCredentials(config.sonarqube.url)}/api/issues/search`;
    const failed = (kind, message, partial = []) => ({
        issues: partial,
        failures: [
            measurementFailure(kind, 'sonarqube', message, {
                via: 'process',
                command: `curl -u <redacted> "${url}?componentKeys=${config.sonarqube.projectKey}"`,
                exitCode: null,
                signal: null,
                elapsedMs: 0,
                stdoutBytes: 0,
                stderrBytes: 0,
            }),
        ],
    });
    if (!token) {
        return failed('access-denied', 'No SonarQube token is configured, so its issues could not be listed. Set ' +
            'SONARQUBE_TOKEN, or the token file named by the config.');
    }
    const issues = [];
    try {
        // Fetch all unresolved issues (paginated)
        let page = 1;
        const pageSize = 500;
        let hasMore = true;
        while (hasMore) {
            const params = new URLSearchParams({
                componentKeys: config.sonarqube.projectKey,
                ps: String(pageSize),
                p: String(page),
                resolved: 'false',
            });
            const result = spawnSync('curl', [
                '-s',
                '-u', `${token}:`,
                `${config.sonarqube.url}/api/issues/search?${params}`,
            ], {
                encoding: 'utf-8',
                timeout: 30000,
                // A page of issues can exceed 1 MiB. Truncation kills curl, `status`
                // comes back null, and the break below then returns whatever pages had
                // already been fetched as if that were the whole result set -- a
                // silently partial finding list, which is worse than none.
                maxBuffer: SUBPROCESS_MAX_BUFFER,
            });
            if (result.status !== 0 || !result.stdout) {
                return failed(result.error ? 'tool-missing' : 'crashed', `Listing SonarQube issues stopped at page ${page}: ` +
                    (result.error
                        ? `curl could not run (${result.error.message}).`
                        : `curl exited ${String(result.status)} with ${result.stdout ? 'a body' : 'no body'}.`) +
                    ` ${issues.length} issue(s) had been read; they are reported, and this ` +
                    'is reported with them rather than presented as the whole list.', issues);
            }
            const response = JSON.parse(result.stdout);
            for (const issue of response.issues) {
                // Extract file path from component (format: projectKey:path/to/file.ts)
                const filePath = issue.component.replace(`${config.sonarqube.projectKey}:`, '');
                const dimension = mapSonarTypeToDimension(issue.type);
                const severity = mapSonarSeverity(issue.severity);
                issues.push({
                    file: filePath,
                    line: issue.line,
                    source: 'sonarqube',
                    dimension,
                    code: issue.rule,
                    severity,
                    impact: {
                        dimension,
                        delta: -1, // Fixing one issue reduces count by 1
                        direction: 'lower-better',
                    },
                    message: issue.message,
                    context: `Rule: ${issue.rule}, Type: ${issue.type}`,
                });
            }
            // Check if there are more pages
            const totalFetched = page * pageSize;
            hasMore = totalFetched < response.total && response.issues.length === pageSize;
            page++;
            // Safety limit to prevent infinite loops
            if (page > 10)
                break;
        }
    }
    catch (error) {
        return failed('unparseable-output', `SonarQube's issue list could not be read: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            `${issues.length} issue(s) had been read before that.`, issues);
    }
    return { issues, failures: [] };
}
// =============================================================================
// Symbol Enrichment
// =============================================================================
/**
 * Enrich issues with symbol information from a symbol table.
 *
 * For each issue:
 * - If it has a line number, maps to the containing symbol (precise)
 * - If no line number (file-level issues like coverage-summary), maps to
 *   the file's most significant symbol (largest by SLOC)
 *
 * This enables cross-axis analysis by mapping all issues to a unified symbol graph.
 */
function enrichIssuesWithSymbols(issues, symbolTable) {
    // Cache file-level symbol lookups (for file-level issues without line numbers)
    const filePrimarySymbol = new Map();
    const findPrimarySymbolForFile = (file) => {
        if (filePrimarySymbol.has(file)) {
            return filePrimarySymbol.get(file) ?? null;
        }
        // Get all symbols in file
        const fileSymbols = symbolTable.byFile.get(file);
        if (!fileSymbols || fileSymbols.length === 0) {
            // Try matching with different path formats
            for (const [tablePath, symbols] of symbolTable.byFile) {
                if (tablePath.endsWith(file) || file.endsWith(tablePath) ||
                    tablePath.includes(file) || file.includes(tablePath)) {
                    if (symbols.length > 0) {
                        // Find largest top-level symbol by SLOC
                        const topLevel = symbols.filter(s => !s.parent);
                        const primary = topLevel.length > 0
                            ? topLevel.reduce((a, b) => a.sloc > b.sloc ? a : b)
                            : symbols.reduce((a, b) => a.sloc > b.sloc ? a : b);
                        filePrimarySymbol.set(file, primary);
                        return primary;
                    }
                }
            }
            filePrimarySymbol.set(file, null);
            return null;
        }
        // Find largest top-level symbol by SLOC
        const topLevel = fileSymbols.filter(s => !s.parent);
        const primary = topLevel.length > 0
            ? topLevel.reduce((a, b) => a.sloc > b.sloc ? a : b)
            : fileSymbols.reduce((a, b) => a.sloc > b.sloc ? a : b);
        filePrimarySymbol.set(file, primary);
        return primary;
    };
    for (const issue of issues) {
        if (issue.line !== undefined) {
            // Line-level: map to containing symbol (precise)
            const symbol = mapLocationToSymbol(symbolTable, issue.file, issue.line, issue.column);
            if (symbol) {
                issue.symbol = issue.symbol ?? symbol.qualifiedName;
                issue.symbolId = symbol.id;
            }
        }
        else {
            // File-level: map to primary symbol in file
            const primary = findPrimarySymbolForFile(issue.file);
            if (primary) {
                issue.symbol = issue.symbol ?? primary.qualifiedName;
                issue.symbolId = primary.id;
            }
        }
    }
}
// =============================================================================
// Combined Extraction
// =============================================================================
/**
 * Extract located issues from all sources.
 *
 * This is the main entry point for Phase 2 of the location-aware targets system.
 *
 * When a symbolTable is provided in options, issues will be enriched with
 * symbol information for unified cross-axis analysis.
 */
export function extractLocatedIssues(options = {}) {
    const empty = { issues: [], failures: [] };
    const coverageReading = readCoverageIssues(options.coverageDir);
    const typescriptReading = options.skipTypescript ? empty : readTypescriptIssues();
    const eslintReading = options.skipEslint ? empty : readEslintIssues();
    // A skipped dimension is deliberately not a failure -- `--coverage-only` asked for
    // it -- but a dimension that was ASKED FOR and could not be read now says so, which
    // is what the comment that stood here recorded as still missing.
    const sonarqubeReading = options.skipSonarQube ? empty : readSonarqubeIssues();
    const sonarqube = sonarqubeReading.issues;
    const coverage = coverageReading.issues;
    const typescript = typescriptReading.issues;
    const eslint = eslintReading.issues;
    // Enrich issues with symbol information if symbol table provided
    if (options.symbolTable) {
        enrichIssuesWithSymbols(coverage, options.symbolTable);
        enrichIssuesWithSymbols(typescript, options.symbolTable);
        enrichIssuesWithSymbols(eslint, options.symbolTable);
        enrichIssuesWithSymbols(sonarqube, options.symbolTable);
    }
    return {
        coverage,
        typescript,
        eslint,
        sonarqube,
        totalCount: coverage.length + typescript.length + eslint.length + sonarqube.length,
        summary: {
            coverage: coverage.length,
            typescript: typescript.length,
            eslint: eslint.length,
            sonarqube: sonarqube.length,
        },
        measurementFailures: [
            ...coverageReading.failures,
            ...typescriptReading.failures,
            ...eslintReading.failures,
            // Last, so the orderings the existing tests assert on are untouched.
            ...sonarqubeReading.failures,
        ],
    };
}
//# sourceMappingURL=extract.js.map