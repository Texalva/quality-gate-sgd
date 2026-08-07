/**
 * Metrics Extraction Module
 * Extracts quality metrics from various sources
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Metrics,
  CoverageMetrics,
  AllCoverageMetrics,
  SonarqubeMetrics,
  EslintMetrics,
  TypescriptMetrics,
} from './types.js';
import { getConfig, getSonarCurlAuth } from './config.js';
import {
  extractAllCustomMetrics,
  registerCustomDimensions,
  type CustomDimensionConfig,
} from './dimensions/index.js';
import { manifestDefinesScript, scriptCommand } from './runner.js';
import { eslintLintProvider } from './providers/eslint.js';
import { typescriptTypecheckProvider } from './providers/typescript.js';
import { DEFAULT_MEASUREMENT_LIMITS } from './providers/result.js';
import { createIstanbulCoverageProvider } from './providers/coverage.js';
import type {
  CoverageReading,
  LintReading,
  MeasurementFailure,
  Result,
  TypecheckReading,
} from './providers/types.js';

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

// =============================================================================
// Coverage Metrics
// =============================================================================

/**
 * Measures coverage once, so the metrics and the located findings cannot end up
 * describing two different reads of the same report.
 *
 * The parsing that used to live here now lives in src/providers/coverage.ts,
 * unchanged. Before the extraction the two halves came from DIFFERENT files read
 * at DIFFERENT times -- metrics from coverage-summary.json here, findings from
 * coverage-final.json in targets/extract.ts -- with nothing checking that they
 * agreed about anything.
 *
 * `issues: 'skip'` because this path discards them, and the cost of building them
 * is not notional: `measureCoverage` returns metrics and failures and has no
 * issues field to put them in, while the detail report they come from is the
 * biggest artifact the tool reads. Before the extraction this path never opened
 * coverage-final.json at all; collecting here would parse and walk it on the
 * metrics pass and again on the findings pass. See CoverageProviderOptions.
 */
function measureCoverageReading(
  absentReport: 'fail' | 'ignore'
): Result<CoverageReading, MeasurementFailure> {
  const config = getConfig();
  return createIstanbulCoverageProvider(
    {
      unitDir: config.coverage.unitDir,
      lambdaDir: config.coverage.lambdaDir,
      summaryFile: config.coverage.summaryFile,
      unitDirConfigured: config.coverage.unitDirConfigured,
      lambdaDirConfigured: config.coverage.lambdaDirConfigured,
    },
    { issues: 'skip', absentReport }
  ).measure({
    projectRoot: config.projectRoot,
    // A file read has neither a timeout nor a buffer budget. The context carries
    // them because every spawn-based provider needs them, and inventing coverage
    // -specific numbers here would put a limit in the contract that nothing
    // enforces.
    timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
    maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    packageManager: config.packageManager,
    typecheckScript: config.typecheckScript,
  });
}

/**
 * The coverage numbers and the reasons any of them are missing, together.
 *
 * `reads` is deliberately NOT surfaced here. The provider records what it looked
 * at (CoverageReading.reads) and targets/extract.ts uses that to warn about a
 * detail report it could not use, but nothing on the METRICS path judges the
 * reports themselves -- see the note on ReportAttempt.modifiedMs, and #39 for the
 * open question of how a report's provenance should be established. Returning a
 * field no caller reads would suggest something here checks it.
 */
export function measureCoverage(
  options: { readonly absentReportIsFailure?: boolean } = {}
): {
  readonly metrics: AllCoverageMetrics;
  readonly failures: readonly MeasurementFailure[];
} {
  // Defaults to REQUIRING the report, so a caller that says nothing gets the loud
  // reading. `QUALITY_COVERAGE_REQUIRED=false` is not consulted here on purpose:
  // it is a statement about a project with no coverage, and honouring it for a
  // project that DOES grade coverage would restore the exact silence this exists
  // to remove -- an absent report, a ratchet that skips it, and a cached pass.
  // Only the gate path knows the rules, so only the gate path resolves it. See
  // `coverageAbsenceIsFailure` in cli.ts.
  const reading = measureCoverageReading(
    (options.absentReportIsFailure ?? true) ? 'fail' : 'ignore'
  );

  if (!reading.ok) {
    return { metrics: {}, failures: [reading.error] };
  }

  return {
    metrics: reading.value.metrics,
    failures: reading.value.failures,
  };
}

/**
 * Extract all three coverage metrics: lambda-only, unit-only, and union.
 *
 * Returns `{}` rather than `undefined` when nothing could be read, because
 * `extractAllMetrics` assigns this straight to `metrics.coverage` and callers
 * distinguish "no coverage numbers" from "no coverage key" already.
 *
 * As with extractTypescriptMetrics, absence is only half the fix: this wrapper
 * discards the REASON, so a caller using it directly gets an honest blank and no
 * diagnosis. The gate path uses `measureCoverage` for exactly that reason.
 */
export function extractAllCoverageMetrics(): AllCoverageMetrics {
  return measureCoverage().metrics;
}

/**
 * Extract coverage metrics for quality gate.
 * Returns the union coverage for backward compatibility.
 * @deprecated Use extractAllCoverageMetrics() for full coverage data.
 */
export function extractCoverageMetrics(): CoverageMetrics | undefined {
  return measureCoverage().metrics.union;
}

// =============================================================================
// SonarQube Metrics
// =============================================================================

interface SonarMeasure {
  metric: string;
  value: string;
}

interface SonarResponse {
  component?: {
    measures?: SonarMeasure[];
  };
}

// SonarQube issue structure for inline display
export interface SonarIssue {
  severity: string;
  type: string;
  message: string;
  component: string;
  line?: number;
  rule: string;
}

interface SonarIssuesResponse {
  issues?: Array<{
    severity: string;
    type: string;
    message: string;
    component: string;
    line?: number;
    rule: string;
  }>;
  total?: number;
}

export function getTopSonarIssues(limit = 10): SonarIssue[] {
  const config = getConfig();
  const sonarUrl = config.sonarqube.url;
  const projectKey = config.sonarqube.projectKey;
  const authArg = getSonarCurlAuth();

  try {
    const result = execSync(
      `curl -s ${authArg} "${sonarUrl}/api/issues/search?componentKeys=${projectKey}&severities=BLOCKER,CRITICAL,MAJOR,MINOR&statuses=OPEN,CONFIRMED&ps=${limit}&s=SEVERITY"`,
      { encoding: 'utf-8', timeout: 10000 }
    );

    const response = JSON.parse(result) as SonarIssuesResponse;
    if (!response.issues) return [];

    return response.issues.map((i) => ({
      severity: i.severity,
      type: i.type,
      message: i.message,
      component: i.component.replace(`${projectKey}:`, ''),
      line: i.line,
      rule: i.rule,
    }));
  } catch {
    return [];
  }
}

export function extractSonarqubeMetrics(): SonarqubeMetrics | undefined {
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
    const result = execSync(
      `curl -s ${authArg} "${sonarUrl}/api/measures/component?component=${projectKey}&metricKeys=${metrics}"`,
      { encoding: 'utf-8', timeout: 10000 }
    );

    const response = JSON.parse(result) as SonarResponse;
    const measures = response.component?.measures;

    if (!measures || measures.length === 0) {
      return undefined;
    }

    const getValue = (metric: string): number => {
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
  } catch {
    return undefined;
  }
}

export function isSonarqubeAvailable(): boolean {
  const config = getConfig();
  try {
    execSync(`curl -s -o /dev/null -w "%{http_code}" ${config.sonarqube.url}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

interface SonarTaskResponse {
  task?: {
    id: string;
    status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'CANCELED';
    errorMessage?: string;
  };
}

/**
 * Wait for a SonarQube analysis task to complete.
 * Polls the task API until status is SUCCESS, FAILED, or CANCELED.
 */
function waitForSonarTask(
  taskId: string,
  timeoutMs = 120000
): { success: boolean; error?: string } {
  const config = getConfig();
  const sonarUrl = config.sonarqube.url;
  const authArg = getSonarCurlAuth();

  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = execSync(
        `curl -s ${authArg} "${sonarUrl}/api/ce/task?id=${taskId}"`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      const response = JSON.parse(result) as SonarTaskResponse;
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
    } catch {
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
function getSonarTaskId(): string | undefined {
  const config = getConfig();
  const reportTaskPath = path.join(
    config.projectRoot,
    '.scannerwork/report-task.txt'
  );

  if (!fs.existsSync(reportTaskPath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(reportTaskPath, 'utf-8');
    // File contains lines like: ceTaskId=AZQxyz123...
    const match = content.match(/ceTaskId=([^\s\n]+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function runSonarqubeScan(): { success: boolean; error?: string } {
  const config = getConfig();
  const maxRetries = 2;
  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.error(`  Retry attempt ${attempt}/${maxRetries}...`);
      // Brief pause before retry
      spawnSync('sleep', ['5'], { shell: true });
    }

    // Runs the project's `sonar` script, which handles the full scan (with
    // locking). Routed through the runner only so no npm literal is left behind;
    // this function's own reporting is still unfixed -- see task #23/#42.
    const sonar = scriptCommand('sonar', config.packageManager);
    const result = spawnSync(sonar.executable, [...sonar.args], {
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
    const isTransient =
      errorOutput.includes('WebSocket connection error') ||
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
function measureTypescript(): Result<TypecheckReading, MeasurementFailure> {
  const config = getConfig();
  return typescriptTypecheckProvider.measure({
    projectRoot: config.projectRoot,
    timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
    maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    packageManager: config.packageManager,
    typecheckScript: config.typecheckScript,
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
export function extractTypescriptMetrics(): TypescriptMetrics | undefined {
  const reading = measureTypescript();
  return reading.ok ? reading.value.metrics : undefined;
}

// =============================================================================
// ESLint Metrics
// =============================================================================

function measureEslint(): Result<LintReading, MeasurementFailure> {
  const config = getConfig();
  return eslintLintProvider.measure({
    projectRoot: config.projectRoot,
    timeoutMs: DEFAULT_MEASUREMENT_LIMITS.lintTimeoutMs,
    maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    packageManager: config.packageManager,
    typecheckScript: config.typecheckScript,
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
export function extractEslintMetrics(): EslintMetrics | undefined {
  const reading = measureEslint();
  return reading.ok ? reading.value.metrics : undefined;
}

// =============================================================================
// Script Execution
// =============================================================================

export function runScript(script: string): 'pass' | 'fail' {
  const config = getConfig();
  const timeout = config.scriptTimeouts[script] ?? config.defaultScriptTimeout;

  // The same bun fall-through that the typecheck provider refuses, on the path that
  // decides `requiredScripts`. `bun run <name>` for an undefined script executes a
  // same-named `node_modules/.bin` binary and can exit 0, so a required script the
  // project does not have would report `pass` -- while npm exits 1 and reports `fail`.
  // Two managers disagreeing about whether a script ran is not a difference this
  // function may pass on to the gate. Reproduced against bun 1.3.14.
  if (!manifestDefinesScript(config.projectRoot, script)) return 'fail';

  const command = scriptCommand(script, config.packageManager);
  const result = spawnSync(command.executable, [...command.args], {
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

export function runScripts(scripts: string[]): Record<string, 'pass' | 'fail'> {
  const results: Record<string, 'pass' | 'fail'> = {};

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
export function extractSloc(srcDir?: string): number {
  const config = getConfig();
  const targetDir = srcDir ?? path.join(config.projectRoot, 'src');

  if (!fs.existsSync(targetDir)) {
    return 0;
  }

  let totalSloc = 0;

  function countLinesInFile(filePath: string): number {
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
    } catch {
      return 0;
    }
  }

  function walkDirectory(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip node_modules, dist, coverage, .git, etc.
        if (
          entry.isDirectory() &&
          !['node_modules', 'dist', 'coverage', '.git', '.next', 'build'].includes(
            entry.name
          )
        ) {
          walkDirectory(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            // Skip test files and type declaration files
            if (
              !entry.name.includes('.test.') &&
              !entry.name.includes('.spec.') &&
              !entry.name.endsWith('.d.ts')
            ) {
              totalSloc += countLinesInFile(fullPath);
            }
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  walkDirectory(targetDir);
  return totalSloc;
}

// =============================================================================
// Full Metrics Extraction
// =============================================================================

interface MetricsExtractionOptions {
  scriptsToRun?: string[];
  skipSonarQube?: boolean;
  /** Pre-loaded custom dimension configs (if already loaded) */
  customDimensions?: CustomDimensionConfig[];
  /** Whether to skip custom dimension extraction (default: false) */
  skipCustomDimensions?: boolean;

  /**
   * Whether an absent coverage summary is a measurement failure. Defaults to
   * TRUE, which is the safe direction: a caller that forgets this gets the loud
   * reading.
   *
   * The caller resolves it because the answer depends on the RULES, which this
   * module does not see. `QUALITY_COVERAGE_REQUIRED=false` is a project saying it
   * has no coverage; a project that also grades coverage has contradicted that,
   * and honouring the flag there would silently disable a rule it wrote. See
   * `coverageAbsenceIsFailure` in cli.ts.
   */
  coverageAbsenceIsFailure?: boolean;
}

export function extractAllMetrics(
  scriptsToRunOrOptions: string[] | MetricsExtractionOptions = ['quality']
): Metrics {
  // Support both legacy array signature and new options object
  const options: MetricsExtractionOptions = Array.isArray(scriptsToRunOrOptions)
    ? { scriptsToRun: scriptsToRunOrOptions }
    : scriptsToRunOrOptions;

  const scriptsToRun = options.scriptsToRun ?? ['quality'];
  const skipSonarQube = options.skipSonarQube ?? false;
  const skipCustomDimensions = options.skipCustomDimensions ?? false;

  // ---------------------------------------------------------------------------
  // Every measurement is hoisted OUT of the return literal below, in the order
  // it must actually happen.
  //
  // Object-literal properties are evaluated top-to-bottom, so writing
  // `{coverage: read(), ..., scripts: runScripts()}` read the coverage report
  // BEFORE running the scripts that rewrite it. Confirmed end to end: with a
  // 10%-statements report planted and `scriptsToRun: ['test:coverage']`, the
  // gate reported `coverage.unit.statements = 10` while the same file on disk
  // afterwards said 25. Four reads were on the wrong side of `runScripts` --
  // both coverage summaries, the SonarQube measures, and the custom-dimension
  // shell extractors, which commonly read build artifacts.
  //
  // What this does NOT establish is that the report describes the code being
  // graded when no script the gate ran wrote it: a project that generates
  // coverage outside the gate is graded on whatever is on disk. That hole is
  // deliberate and open -- backlog #39 -- after an mtime-comparison rule was
  // built for it and removed for being inert on any project without a literal
  // top-level `src/` while false-failing mtime-preserving archive restores,
  // branch switches and clock skew.
  //
  // The return literal's property ORDER is deliberately left exactly as it was,
  // because the refactor harness compares capture sections with raw
  // `JSON.stringify` equality and does not sort keys: moving `scripts:` up
  // inside the literal would reject the frozen baseline for a pure
  // serialization change, with no number different anywhere.
  // ---------------------------------------------------------------------------

  // First: this is the step that MUTATES the project.
  const scripts = runScripts(scriptsToRun);

  // Extract custom metrics if configs are provided and not skipped
  let custom: Record<string, number> | undefined;
  const customFailures: MeasurementFailure[] = [];
  if (!skipCustomDimensions && options.customDimensions && options.customDimensions.length > 0) {
    // `getConfig().projectRoot`, the same root every other dimension is measured
    // against. Custom extractors used to inherit the CLI's cwd, so one reading could
    // describe two different trees -- see extractCustomMetric.
    const reading = extractAllCustomMetrics(
      options.customDimensions,
      getConfig().projectRoot
    );
    custom = reading.metrics;
    customFailures.push(...reading.failures);
  }

  // Measured once each, and both halves of every reading kept together: the
  // metrics if it worked, the reason if it did not. Calling the public
  // `extract*Metrics` wrappers here instead would discard the reason, which is
  // the only thing that makes a missing ceiling metric fail rather than pass.
  const typescript = measureTypescript();
  const eslint = measureEslint();
  const coverage = measureCoverage({
    absentReportIsFailure: options.coverageAbsenceIsFailure ?? true,
  });

  const sonarqube = skipSonarQube ? undefined : extractSonarqubeMetrics();
  const sloc = extractSloc();

  const measurementFailures = [
    ...[typescript, eslint]
      .filter((reading): reading is Extract<typeof reading, { ok: false }> => !reading.ok)
      .map((reading) => reading.error),
    // Appended rather than prepended so the existing typescript-then-eslint
    // ordering that tests assert on is untouched.
    ...coverage.failures,
    ...customFailures,
  ];

  return {
    coverage: coverage.metrics,
    typescript: typescript.ok ? typescript.value.metrics : undefined,
    eslint: eslint.ok ? eslint.value.metrics : undefined,
    sonarqube,
    scripts,
    sloc,
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
export function describeUnmeasured(
  metrics: Metrics
): readonly { readonly dimension: string; readonly kind: string; readonly why: string }[] | undefined {
  const failures = metrics.measurementFailures ?? [];
  if (failures.length === 0) return undefined;

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
export async function extractAllMetricsAsync(
  options: MetricsExtractionOptions = {}
): Promise<Metrics> {
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
