/**
 * Metrics Extraction Module
 * Extracts quality metrics from various sources
 */
import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, getSonarCurlAuth } from './config.js';
import { extractAllCustomMetrics, registerCustomDimensions, } from './dimensions/index.js';
import { eslintLintProvider } from './providers/eslint.js';
import { typescriptTypecheckProvider } from './providers/typescript.js';
import { DEFAULT_MEASUREMENT_LIMITS } from './providers/result.js';
/**
 * spawnSync defaults to a 1 MiB stdout buffer. Past that, Node truncates the
 * output and kills the child, leaving status === null -- and every parse path
 * below turns unparseable output into *zero findings* rather than an error.
 * eslint's JSON crosses 1 MiB at roughly a thousand findings, so any real
 * codebase with a lint backlog silently reports clean and passes an
 * `eslint.errors: 0` ceiling. Observed directly: a 1038-finding subject
 * returned exactly 1048576 bytes and 0 errors.
 *
 * 64 MiB is far beyond any plausible linter or compiler output.
 */
const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Merge two coverage reports by file.
 * For files appearing in both reports, take the max coverage per file.
 * Then recalculate totals from merged file data.
 */
function mergeCoverageReports(unitData, lambdaData) {
    // Collect all file entries (excluding 'total')
    const mergedFiles = new Map();
    // Process unit test coverage
    if (unitData) {
        for (const [file, entry] of Object.entries(unitData)) {
            if (file === 'total' || !entry)
                continue;
            mergedFiles.set(file, entry);
        }
    }
    // Process lambda test coverage - take max covered for overlapping files
    if (lambdaData) {
        for (const [file, entry] of Object.entries(lambdaData)) {
            if (file === 'total' || !entry)
                continue;
            const existing = mergedFiles.get(file);
            if (!existing) {
                mergedFiles.set(file, entry);
            }
            else {
                // File exists in both - take max covered for each metric
                mergedFiles.set(file, {
                    statements: {
                        total: existing.statements.total,
                        covered: Math.max(existing.statements.covered, entry.statements.covered),
                        pct: 0, // Will recalculate
                    },
                    branches: {
                        total: existing.branches.total,
                        covered: Math.max(existing.branches.covered, entry.branches.covered),
                        pct: 0,
                    },
                    functions: {
                        total: existing.functions.total,
                        covered: Math.max(existing.functions.covered, entry.functions.covered),
                        pct: 0,
                    },
                    lines: {
                        total: existing.lines.total,
                        covered: Math.max(existing.lines.covered, entry.lines.covered),
                        pct: 0,
                    },
                });
            }
        }
    }
    if (mergedFiles.size === 0) {
        return undefined;
    }
    // Calculate totals from merged files
    let totalStatements = 0, coveredStatements = 0;
    let totalBranches = 0, coveredBranches = 0;
    let totalFunctions = 0, coveredFunctions = 0;
    let totalLines = 0, coveredLines = 0;
    for (const entry of Array.from(mergedFiles.values())) {
        totalStatements += entry.statements.total;
        coveredStatements += entry.statements.covered;
        totalBranches += entry.branches.total;
        coveredBranches += entry.branches.covered;
        totalFunctions += entry.functions.total;
        coveredFunctions += entry.functions.covered;
        totalLines += entry.lines.total;
        coveredLines += entry.lines.covered;
    }
    return {
        statements: totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0,
        branches: totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 0,
        functions: totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0,
        lines: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
    };
}
/**
 * Extract coverage from a single report's total.
 */
function extractFromTotal(data) {
    if (!data?.total)
        return undefined;
    return {
        statements: data.total.statements.pct,
        branches: data.total.branches.pct,
        functions: data.total.functions.pct,
        lines: data.total.lines.pct,
    };
}
/**
 * Load coverage data from both test suites.
 */
function loadCoverageData() {
    const config = getConfig();
    const unitPath = path.join(config.projectRoot, config.coverage.unitDir, config.coverage.summaryFile);
    const lambdaPath = path.join(config.projectRoot, config.coverage.lambdaDir, config.coverage.summaryFile);
    let unitData;
    let lambdaData;
    if (fs.existsSync(unitPath)) {
        try {
            unitData = JSON.parse(fs.readFileSync(unitPath, 'utf-8'));
        }
        catch {
            // Skip if invalid
        }
    }
    if (fs.existsSync(lambdaPath)) {
        try {
            lambdaData = JSON.parse(fs.readFileSync(lambdaPath, 'utf-8'));
        }
        catch {
            // Skip if invalid
        }
    }
    return { unitData, lambdaData };
}
/**
 * Extract all three coverage metrics: lambda-only, unit-only, and union.
 */
export function extractAllCoverageMetrics() {
    const { unitData, lambdaData } = loadCoverageData();
    return {
        lambda: extractFromTotal(lambdaData),
        unit: extractFromTotal(unitData),
        union: mergeCoverageReports(unitData, lambdaData),
    };
}
/**
 * Extract coverage metrics for quality gate.
 * Returns the union coverage for backward compatibility.
 * @deprecated Use extractAllCoverageMetrics() for full coverage data.
 */
export function extractCoverageMetrics() {
    const { unitData, lambdaData } = loadCoverageData();
    return mergeCoverageReports(unitData, lambdaData);
}
export function getTopSonarIssues(limit = 10) {
    const config = getConfig();
    const sonarUrl = config.sonarqube.url;
    const projectKey = config.sonarqube.projectKey;
    const authArg = getSonarCurlAuth();
    try {
        const result = execSync(`curl -s ${authArg} "${sonarUrl}/api/issues/search?componentKeys=${projectKey}&severities=BLOCKER,CRITICAL,MAJOR,MINOR&statuses=OPEN,CONFIRMED&ps=${limit}&s=SEVERITY"`, { encoding: 'utf-8', timeout: 10000 });
        const response = JSON.parse(result);
        if (!response.issues)
            return [];
        return response.issues.map((i) => ({
            severity: i.severity,
            type: i.type,
            message: i.message,
            component: i.component.replace(`${projectKey}:`, ''),
            line: i.line,
            rule: i.rule,
        }));
    }
    catch {
        return [];
    }
}
export function extractSonarqubeMetrics() {
    const config = getConfig();
    const sonarUrl = config.sonarqube.url;
    const projectKey = config.sonarqube.projectKey;
    const authArg = getSonarCurlAuth();
    const metrics = [
        'bugs',
        'vulnerabilities',
        'code_smells',
        'coverage',
        'duplicated_lines_density',
        // Severity breakdown
        'blocker_violations',
        'critical_violations',
        'major_violations',
        'minor_violations',
        'info_violations',
    ].join(',');
    try {
        const result = execSync(`curl -s ${authArg} "${sonarUrl}/api/measures/component?component=${projectKey}&metricKeys=${metrics}"`, { encoding: 'utf-8', timeout: 10000 });
        const response = JSON.parse(result);
        const measures = response.component?.measures;
        if (!measures || measures.length === 0) {
            return undefined;
        }
        const getValue = (metric) => {
            const m = measures.find((m) => m.metric === metric);
            return m ? parseFloat(m.value) : 0;
        };
        return {
            bugs: getValue('bugs'),
            vulnerabilities: getValue('vulnerabilities'),
            codeSmells: getValue('code_smells'),
            coverage: getValue('coverage'),
            duplications: getValue('duplicated_lines_density'),
            blocker: getValue('blocker_violations'),
            critical: getValue('critical_violations'),
            major: getValue('major_violations'),
            minor: getValue('minor_violations'),
            info: getValue('info_violations'),
        };
    }
    catch {
        return undefined;
    }
}
export function isSonarqubeAvailable() {
    const config = getConfig();
    try {
        execSync(`curl -s -o /dev/null -w "%{http_code}" ${config.sonarqube.url}`, {
            encoding: 'utf-8',
            timeout: 5000,
        });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Wait for a SonarQube analysis task to complete.
 * Polls the task API until status is SUCCESS, FAILED, or CANCELED.
 */
function waitForSonarTask(taskId, timeoutMs = 120000) {
    const config = getConfig();
    const sonarUrl = config.sonarqube.url;
    const authArg = getSonarCurlAuth();
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds
    while (Date.now() - startTime < timeoutMs) {
        try {
            const result = execSync(`curl -s ${authArg} "${sonarUrl}/api/ce/task?id=${taskId}"`, { encoding: 'utf-8', timeout: 10000 });
            const response = JSON.parse(result);
            const status = response.task?.status;
            if (status === 'SUCCESS') {
                return { success: true };
            }
            if (status === 'FAILED') {
                return {
                    success: false,
                    error: response.task?.errorMessage || 'Analysis task failed',
                };
            }
            if (status === 'CANCELED') {
                return { success: false, error: 'Analysis task was canceled' };
            }
            // Still in progress - wait and retry
        }
        catch {
            // Ignore transient errors during polling
        }
        // Sleep for poll interval
        execSync(`sleep ${pollInterval / 1000}`, { encoding: 'utf-8' });
    }
    return {
        success: false,
        error: 'Timed out waiting for analysis to complete',
    };
}
/**
 * Extract the task ID from SonarQube scanner's report-task.txt file.
 */
function getSonarTaskId() {
    const config = getConfig();
    const reportTaskPath = path.join(config.projectRoot, '.scannerwork/report-task.txt');
    if (!fs.existsSync(reportTaskPath)) {
        return undefined;
    }
    try {
        const content = fs.readFileSync(reportTaskPath, 'utf-8');
        // File contains lines like: ceTaskId=AZQxyz123...
        const match = content.match(/ceTaskId=([^\s\n]+)/);
        return match?.[1];
    }
    catch {
        return undefined;
    }
}
export function runSonarqubeScan() {
    const config = getConfig();
    const maxRetries = 2;
    let lastError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (attempt > 1) {
            console.error(`  Retry attempt ${attempt}/${maxRetries}...`);
            // Brief pause before retry
            spawnSync('sleep', ['5'], { shell: true });
        }
        // Run npm run sonar which handles the full scan (with locking)
        const result = spawnSync('npm', ['run', 'sonar'], {
            cwd: config.projectRoot,
            encoding: 'utf-8',
            shell: true,
            timeout: 300000, // 5 minutes for scan
            stdio: ['pipe', 'pipe', 'pipe'],
            // A scanner run is chatty enough to cross 1 MiB routinely, and being cut
            // off there kills the child mid-scan and reads back as a failed scan.
            maxBuffer: SUBPROCESS_MAX_BUFFER,
        });
        const errorOutput = (result.stderr || '') + (result.stdout || '');
        if (result.status === 0) {
            // Scanner completed - now wait for the analysis task to finish
            const taskId = getSonarTaskId();
            if (!taskId) {
                // No task ID found - scan may have failed to submit
                // Check if SonarQube has metrics anyway (might be from previous scan)
                return { success: true };
            }
            // Wait for the analysis task to complete
            return waitForSonarTask(taskId);
        }
        // Check if this is a transient error worth retrying
        const isTransient = errorOutput.includes('WebSocket connection error') ||
            errorOutput.includes('Connection reset') ||
            errorOutput.includes('Broken pipe') ||
            errorOutput.includes('Another SonarQube analysis is already in progress');
        lastError = errorOutput.slice(-500);
        if (!isTransient || attempt === maxRetries) {
            return {
                success: false,
                error: lastError,
            };
        }
        // Transient error - will retry
        console.error(`  Transient error detected, will retry...`);
    }
    return {
        success: false,
        error: lastError,
    };
}
// =============================================================================
// TypeScript Metrics
// =============================================================================
/**
 * Measures the type-check once, so callers that want the totals and callers
 * that want the located errors cannot end up disagreeing about the same run.
 */
function measureTypescript() {
    const config = getConfig();
    return typescriptTypecheckProvider.measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    });
}
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
export function extractTypescriptMetrics() {
    const reading = measureTypescript();
    return reading.ok ? reading.value.metrics : undefined;
}
// =============================================================================
// ESLint Metrics
// =============================================================================
function measureEslint() {
    const config = getConfig();
    return eslintLintProvider.measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.lintTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    });
}
/**
 * Lint totals, or `undefined` when eslint could not be run.
 *
 * Replaces `errors: exitCode === 0 ? 0 : 1`, which was wrong twice over: a
 * linter that could not run was reported as one ordinary lint error, and a
 * failure that happened to exit 0 -- a broken config, an empty report -- as a
 * clean project. See extractTypescriptMetrics for why absence is only half the
 * fix.
 */
export function extractEslintMetrics() {
    const reading = measureEslint();
    return reading.ok ? reading.value.metrics : undefined;
}
// =============================================================================
// Script Execution
// =============================================================================
export function runScript(script) {
    const config = getConfig();
    const timeout = config.scriptTimeouts[script] ?? config.defaultScriptTimeout;
    const result = spawnSync('npm', ['run', script], {
        cwd: config.projectRoot,
        encoding: 'utf-8',
        shell: true,
        timeout,
        // Without this a *passing* script that prints more than 1 MiB -- a test
        // suite, typically -- is killed at the buffer, comes back with a null
        // status, and is recorded as a failure. It errs in the safe direction, but
        // it is still the wrong answer about the script.
        maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    return result.status === 0 ? 'pass' : 'fail';
}
export function runScripts(scripts) {
    const results = {};
    for (const script of scripts) {
        results[script] = runScript(script);
    }
    return results;
}
// =============================================================================
// SLOC Extraction (Source Lines of Code)
// =============================================================================
/**
 * Count source lines of code in a directory.
 * Uses a simple heuristic: non-empty, non-comment lines in .ts/.tsx/.js/.jsx files.
 * For determinism, always scans the same directories with the same rules.
 */
export function extractSloc(srcDir) {
    const config = getConfig();
    const targetDir = srcDir ?? path.join(config.projectRoot, 'src');
    if (!fs.existsSync(targetDir)) {
        return 0;
    }
    let totalSloc = 0;
    function countLinesInFile(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            let sloc = 0;
            let inBlockComment = false;
            for (const line of lines) {
                const trimmed = line.trim();
                // Handle block comments
                if (inBlockComment) {
                    if (trimmed.includes('*/')) {
                        inBlockComment = false;
                    }
                    continue;
                }
                if (trimmed.startsWith('/*')) {
                    if (!trimmed.includes('*/')) {
                        inBlockComment = true;
                    }
                    continue;
                }
                // Skip empty lines and single-line comments
                if (trimmed === '' || trimmed.startsWith('//')) {
                    continue;
                }
                sloc++;
            }
            return sloc;
        }
        catch {
            return 0;
        }
    }
    function walkDirectory(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                // Skip node_modules, dist, coverage, .git, etc.
                if (entry.isDirectory() &&
                    !['node_modules', 'dist', 'coverage', '.git', '.next', 'build'].includes(entry.name)) {
                    walkDirectory(fullPath);
                }
                else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
                        // Skip test files and type declaration files
                        if (!entry.name.includes('.test.') &&
                            !entry.name.includes('.spec.') &&
                            !entry.name.endsWith('.d.ts')) {
                            totalSloc += countLinesInFile(fullPath);
                        }
                    }
                }
            }
        }
        catch {
            // Skip directories we can't read
        }
    }
    walkDirectory(targetDir);
    return totalSloc;
}
export function extractAllMetrics(scriptsToRunOrOptions = ['quality']) {
    // Support both legacy array signature and new options object
    const options = Array.isArray(scriptsToRunOrOptions)
        ? { scriptsToRun: scriptsToRunOrOptions }
        : scriptsToRunOrOptions;
    const scriptsToRun = options.scriptsToRun ?? ['quality'];
    const skipSonarQube = options.skipSonarQube ?? false;
    const skipCustomDimensions = options.skipCustomDimensions ?? false;
    // Extract custom metrics if configs are provided and not skipped
    let custom;
    const customFailures = [];
    if (!skipCustomDimensions && options.customDimensions && options.customDimensions.length > 0) {
        const reading = extractAllCustomMetrics(options.customDimensions);
        custom = reading.metrics;
        customFailures.push(...reading.failures);
    }
    // Measured once each, and both halves of every reading kept together: the
    // metrics if it worked, the reason if it did not. Calling the public
    // `extract*Metrics` wrappers here instead would discard the reason, which is
    // the only thing that makes a missing ceiling metric fail rather than pass.
    const typescript = measureTypescript();
    const eslint = measureEslint();
    const measurementFailures = [
        ...[typescript, eslint]
            .filter((reading) => !reading.ok)
            .map((reading) => reading.error),
        ...customFailures,
    ];
    return {
        coverage: extractAllCoverageMetrics(),
        typescript: typescript.ok ? typescript.value.metrics : undefined,
        eslint: eslint.ok ? eslint.value.metrics : undefined,
        sonarqube: skipSonarQube ? undefined : extractSonarqubeMetrics(),
        scripts: runScripts(scriptsToRun),
        sloc: extractSloc(),
        custom,
        measurementFailures: measurementFailures.length > 0 ? measurementFailures : undefined,
    };
}
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
export function describeUnmeasured(metrics) {
    const failures = metrics.measurementFailures ?? [];
    if (failures.length === 0)
        return undefined;
    return failures.map((failure) => ({
        dimension: failure.dimension,
        kind: failure.kind,
        why: failure.message,
    }));
}
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
 */
export async function extractAllMetricsAsync(options = {}) {
    const config = getConfig();
    // Load and register custom dimensions if not already provided
    let customDimensions = options.customDimensions;
    if (!customDimensions && !options.skipCustomDimensions) {
        // projectRoot, not the default of process.cwd(): the config belongs to the
        // project being measured, and the CLI can be invoked from anywhere above or
        // below it. Searching cwd finds a different project's config, or none.
        customDimensions = await registerCustomDimensions(config.projectRoot);
    }
    return extractAllMetrics({
        ...options,
        customDimensions,
    });
}
//# sourceMappingURL=metrics.js.map