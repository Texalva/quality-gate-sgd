/**
 * Located Issue Extraction
 * ========================
 * Extracts issues with location information from all quality sources.
 *
 * Unlike the metrics extraction (which aggregates to counts), this preserves
 * the file:line:column information so we can compute target-space gradients.
 */
import { spawnSync } from 'child_process';
import { getConfig, getSonarAuthToken } from '../config.js';
import { mapLocationToSymbol } from '../symbols/mapper.js';
import { eslintLintProvider } from '../providers/eslint.js';
import { typescriptTypecheckProvider } from '../providers/typescript.js';
import { createIstanbulCoverageProvider } from '../providers/coverage.js';
import { DEFAULT_MEASUREMENT_LIMITS } from '../providers/result.js';
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
    const config = getConfig();
    const reading = createIstanbulCoverageProvider({
        unitDir: coverageDir ?? config.coverage.unitDir,
        lambdaDir: config.coverage.lambdaDir,
        summaryFile: config.coverage.summaryFile,
    }).measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    });
    if (!reading.ok) {
        console.error(`Warning: Could not parse coverage reports: ${reading.error.message}`);
        return [];
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
    for (const read of reading.value.reads) {
        const unreadable = read.attempt.outcome !== 'read' && read.attempt.outcome !== 'absent';
        if (!unreadable && read.shape === 'expected')
            continue;
        const reason = unreadable ? read.attempt.outcome : 'not a coverage report';
        console.error(`Warning: Could not parse ${read.attempt.path}: ${reason}`);
    }
    // Still [] when a report was unreadable, and still wrong for the same reason
    // extractTypescriptIssues is: fix advice that says "nothing to fix" when it
    // should say "could not look". The GATE VERDICT is safe -- extractAllMetrics
    // carries the coverage MeasurementFailure through to evaluateRules -- so what
    // survives here is degraded advice, not a vacuous pass. Closing it means
    // giving ExtractedIssues a failure channel of its own.
    return [...reading.value.issues];
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
    const config = getConfig();
    const reading = typescriptTypecheckProvider.measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    });
    // Still [] on failure, and still wrong for the same reason: a type-check that
    // never ran is indistinguishable here from a project with no type errors.
    //
    // Not fixed in this pass, deliberately. The GATE VERDICT reads metrics, not
    // issues, and extractAllMetrics now carries the MeasurementFailure through to
    // evaluateRules -- so the vacuous PASS is closed. What survives is that the
    // fix ADVICE says "nothing to fix" when it should say "could not look".
    // Closing that means giving ExtractedIssues a failure channel of its own.
    return reading.ok ? [...reading.value.issues] : [];
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
    const config = getConfig();
    const reading = eslintLintProvider.measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.lintTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    });
    // See extractTypescriptIssues: advisory-only, so still [] on failure while
    // the gate verdict is protected through extractAllMetrics.
    return reading.ok ? [...reading.value.issues] : [];
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
 */
export function extractSonarqubeIssues() {
    const config = getConfig();
    const token = getSonarAuthToken();
    if (!token) {
        return [];
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
                break;
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
    catch {
        // If fetching fails, return empty
    }
    return issues;
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
    const coverage = extractCoverageIssues(options.coverageDir);
    const typescript = options.skipTypescript ? [] : extractTypescriptIssues();
    const eslint = options.skipEslint ? [] : extractEslintIssues();
    const sonarqube = options.skipSonarQube ? [] : extractSonarqubeIssues();
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
    };
}
//# sourceMappingURL=extract.js.map