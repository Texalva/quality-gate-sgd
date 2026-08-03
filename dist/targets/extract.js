/**
 * Located Issue Extraction
 * ========================
 * Extracts issues with location information from all quality sources.
 *
 * Unlike the metrics extraction (which aggregates to counts), this preserves
 * the file:line:column information so we can compute target-space gradients.
 */
import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { getConfig, getSonarAuthToken } from '../config.js';
import { mapLocationToSymbol } from '../symbols/mapper.js';
import { eslintLintProvider } from '../providers/eslint.js';
import { typescriptTypecheckProvider } from '../providers/typescript.js';
import { DEFAULT_MEASUREMENT_LIMITS } from '../providers/result.js';
/**
 * See the identical constant in ../metrics.ts. spawnSync's 1 MiB default
 * truncates large linter output and kills the child; the catch blocks below
 * then report zero issues instead of failing, so a noisy codebase looks clean.
 */
const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;
function shouldSkipCoverageFile(filePath) {
    return (filePath.includes('node_modules') ||
        filePath.includes('.test.') ||
        filePath.includes('.spec.'));
}
function extractCoverageIssuesFromSummary(summaryPath, dimensionPrefix) {
    if (!existsSync(summaryPath))
        return [];
    try {
        const data = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        const issues = [];
        for (const [filePath, entry] of Object.entries(data)) {
            if (filePath === 'total' || !entry)
                continue;
            if (shouldSkipCoverageFile(filePath))
                continue;
            const branchTotal = entry.branches.total ?? 0;
            const branchCovered = entry.branches.covered ?? 0;
            const branchMissing = Math.max(branchTotal - branchCovered, 0);
            if (branchTotal > 0 && branchMissing > 0) {
                const delta = branchMissing / branchTotal;
                issues.push({
                    file: filePath,
                    source: 'coverage',
                    dimension: `${dimensionPrefix}.branches`,
                    code: 'uncovered-branches',
                    impact: {
                        dimension: `${dimensionPrefix}.branches`,
                        delta,
                        direction: 'higher-better',
                    },
                    message: `Low branch coverage (${entry.branches.pct.toFixed(1)}%)`,
                    context: `${branchMissing}/${branchTotal} branches uncovered`,
                });
            }
            const fnTotal = entry.functions.total ?? 0;
            const fnCovered = entry.functions.covered ?? 0;
            const fnMissing = Math.max(fnTotal - fnCovered, 0);
            if (fnTotal > 0 && fnMissing > 0) {
                const delta = fnMissing / fnTotal;
                issues.push({
                    file: filePath,
                    source: 'coverage',
                    dimension: `${dimensionPrefix}.functions`,
                    code: 'uncovered-functions',
                    impact: {
                        dimension: `${dimensionPrefix}.functions`,
                        delta,
                        direction: 'higher-better',
                    },
                    message: `Low function coverage (${entry.functions.pct.toFixed(1)}%)`,
                    context: `${fnMissing}/${fnTotal} functions uncovered`,
                });
            }
        }
        return issues;
    }
    catch (error) {
        console.error(`Warning: Could not parse ${summaryPath}: ${error}`);
        return [];
    }
}
/**
 * Extract uncovered branches and lines from coverage-final.json.
 *
 * Each uncovered branch becomes a LocatedIssue with estimated coverage impact.
 */
export function extractCoverageIssues(coverageDir) {
    const config = getConfig();
    const issues = [];
    let foundCoverageFinal = false;
    // Try unit coverage first, then lambda
    const coveragePaths = [
        path.join(config.projectRoot, coverageDir ?? config.coverage.unitDir, 'coverage-final.json'),
        path.join(config.projectRoot, config.coverage.lambdaDir, 'coverage-final.json'),
    ];
    for (const coveragePath of coveragePaths) {
        if (!existsSync(coveragePath))
            continue;
        foundCoverageFinal = true;
        try {
            const data = JSON.parse(readFileSync(coveragePath, 'utf-8'));
            for (const [filePath, fileCoverage] of Object.entries(data)) {
                // Skip node_modules and test files
                if (shouldSkipCoverageFile(filePath)) {
                    continue;
                }
                // Count total branches for this file to estimate per-branch impact
                const totalBranches = Object.values(fileCoverage.branchMap).reduce((sum, branch) => sum + branch.locations.length, 0);
                // Extract uncovered branches
                for (const [branchId, branch] of Object.entries(fileCoverage.branchMap)) {
                    const hitCounts = fileCoverage.b[branchId] || [];
                    for (let i = 0; i < branch.locations.length; i++) {
                        const loc = branch.locations[i];
                        const hits = hitCounts[i] ?? 0;
                        if (hits === 0) {
                            // Estimate impact: each branch is roughly equal fraction of file's branch coverage
                            // If file has 10 branches and 5 uncovered, covering 1 branch adds ~10% to file's coverage
                            const estimatedImpact = totalBranches > 0 ? 100 / totalBranches : 1;
                            issues.push({
                                file: filePath,
                                line: loc.start.line,
                                column: loc.start.column,
                                endLine: loc.end.line,
                                endColumn: loc.end.column,
                                source: 'coverage',
                                dimension: 'coverage.unit.branches',
                                code: `branch-${branch.type}`,
                                impact: {
                                    dimension: 'coverage.unit.branches',
                                    delta: estimatedImpact / 100, // Fractional coverage gain
                                    direction: 'higher-better',
                                },
                                message: `Uncovered ${branch.type} branch`,
                                context: `Branch ${branchId}[${i}] at line ${loc.start.line}`,
                            });
                        }
                    }
                }
                // Extract uncovered functions
                for (const [fnId, fn] of Object.entries(fileCoverage.fnMap)) {
                    const hits = fileCoverage.f[fnId] ?? 0;
                    if (hits === 0) {
                        issues.push({
                            file: filePath,
                            line: fn.loc.start.line,
                            column: fn.loc.start.column,
                            endLine: fn.loc.end.line,
                            endColumn: fn.loc.end.column,
                            symbol: fn.name || `anonymous_${fnId}`,
                            source: 'coverage',
                            dimension: 'coverage.unit.functions',
                            code: 'uncovered-function',
                            impact: {
                                dimension: 'coverage.unit.functions',
                                delta: 0.5, // Rough estimate: covering a function helps
                                direction: 'higher-better',
                            },
                            message: `Uncovered function: ${fn.name || 'anonymous'}`,
                            context: `Function at line ${fn.loc.start.line}`,
                        });
                    }
                }
            }
        }
        catch (error) {
            // Silently skip if coverage file is malformed
            console.error(`Warning: Could not parse ${coveragePath}: ${error}`);
        }
    }
    // Fallback: use coverage-summary.json when coverage-final.json is missing
    if (issues.length === 0) {
        const summaryPaths = [
            {
                path: path.join(config.projectRoot, coverageDir ?? config.coverage.unitDir, config.coverage.summaryFile),
                prefix: 'coverage.unit',
            },
            {
                path: path.join(config.projectRoot, config.coverage.lambdaDir, config.coverage.summaryFile),
                prefix: 'coverage.lambda',
            },
        ];
        for (const summary of summaryPaths) {
            const summaryIssues = extractCoverageIssuesFromSummary(summary.path, summary.prefix);
            if (summaryIssues.length > 0 && foundCoverageFinal) {
                console.error(`Warning: Using ${config.coverage.summaryFile} fallback for ${summary.prefix} coverage`);
            }
            issues.push(...summaryIssues);
        }
    }
    return issues;
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