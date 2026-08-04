#!/usr/bin/env node
/**
 * Quality Gate CLI
 * ================
 * Main entry point for the quality-gate-sgd CLI.
 *
 * Commands:
 *   quality-gate run          Run the quality gate (default)
 *   quality-gate trajectory   Analyze quality descent trajectory
 *   quality-gate list-issues  List SonarQube issues
 *
 * Usage:
 *   npx quality-gate-sgd [command] [options]
 */

import { writeFileSync } from 'fs';
import {
  // Deliberately not importing `extractAllMetrics`: it cannot load custom
  // dimensions, so any surface in here that used it silently omitted them.
  extractAllMetricsAsync,
  describeUnmeasured,
  isSonarqubeAvailable,
  runSonarqubeScan,
  getTopSonarIssues,
  type SonarIssue,
} from './metrics.js';
import {
  loadRules,
  evaluateRules,
  isCacheValid,
  isMeasurementUnderRule,
  coverageAbsenceIsFailure,
} from './rules.js';
import {
  loadCache,
  saveCache,
  getCacheKey,
  getCacheEntry,
  setCacheEntry,
  createCacheEntry,
  findBaselineEntry,
  resolveBaselineCommit,
  pruneOldEntries,
} from './cache.js';
import { getConfig } from './config.js';
import { listIssues } from './list-issues.js';
import {
  buildTrajectory,
  formatTrajectorySummary,
  trajectorySparkline,
} from './trajectory.js';
import { runInit } from './init.js';
import {
  getAllDimensions,
  getDimensionsByCategory,
  formatDimensionsTable,
  type DimensionCategory,
} from './dimensions/index.js';
import {
  computeFitness,
  computeGradient,
  suggestNextFixes,
  formatFitnessScore,
  formatGradientTable,
} from './fitness.js';
import {
  extractLocatedIssues,
  aggregateToTargets,
  aggregateToSymbolsWithOptions,
  formatTargetList,
  formatTargetsForJson,
  formatSymbolIssuesList,
  formatSymbolIssuesForJson,
  type TargetGranularity,
} from './targets/index.js';
import {
  extractSymbols,
  getSymbolTableStats,
  computeAddressFitness,
  formatAddressFitness,
} from './symbols/index.js';
import {
  buildDimension,
  appendToConfigFile,
} from './dimensions/index.js';
import { runMcpServer } from './mcp/index.js';
import { estimateFixability as runFixabilityEstimation } from './fixability/index.js';
import {
  createExperimentScaffold,
  initializeRun,
  executeDockerRun,
  listExperiments,
  listRuns as listDockerRuns,
  type ScaffoldOptions,
} from './experiments/docker/index.js';
import {
  analyzeBatch,
  generateAnalysisReport,
  loadBatch,
  visualizeBatch,
  visualizeResults,
  downloadSWEBenchSplit,
  checkSWEBenchLocalSplits,
  getSWEBenchDatasetInfo,
  formatBytes,
  progressBar,
  type DatasetSplit,
} from './experiments/index.js';
import * as readline from 'readline';

function log(message: string): void {
  console.error(message);
}

function formatFailures(
  failures: Array<{ type: string; rule: string; message: string }>
): string {
  return failures.map((f) => `  - [${f.type}] ${f.message}`).join('\n');
}

function formatSonarIssues(issues: SonarIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = ['\n## Top SonarQube Issues\n'];

  for (const issue of issues) {
    const location = issue.line ? `:${issue.line}` : '';
    lines.push(`  - [${issue.severity}] ${issue.component}${location}`);
    lines.push(`    ${issue.message}`);
    lines.push(`    Rule: ${issue.rule}`);
  }

  return lines.join('\n');
}

function getRemediationGuidance(
  failures: Array<{ type: string; rule: string; message: string }>
): string {
  const lines: string[] = ['\n## How to Fix\n'];

  const hasMonotonicFailure = failures.some((f) => f.type === 'monotonic');
  const hasScriptFailure = failures.some((f) => f.type === 'script');
  const hasCoverageIssue = failures.some(
    (f) => f.rule.includes('coverage') || f.message.includes('coverage')
  );

  if (hasCoverageIssue) {
    lines.push('### Coverage Issues');
    lines.push('');
    lines.push('1. Find files with low coverage:');
    lines.push('   ```');
    lines.push('   npx quality-gate-sgd prioritize');
    lines.push('   ```');
    lines.push('');
    lines.push('2. Run tests with coverage to see current state:');
    lines.push('   ```');
    lines.push('   npm run test -- --coverage');
    lines.push('   ```');
    lines.push('');
  }

  if (hasScriptFailure) {
    lines.push('### Script Failures');
    lines.push('');
    lines.push('Run the failing script directly to see errors:');
    lines.push('```');
    lines.push('npm run <script-name>');
    lines.push('```');
    lines.push('');
  }

  if (hasMonotonicFailure && !hasCoverageIssue) {
    lines.push('### Regression Detected');
    lines.push('');
    lines.push(
      'A metric regressed from the baseline. Check the cache for details:'
    );
    lines.push('```');
    lines.push('cat .quality-gate-cache.json | jq');
    lines.push('```');
    lines.push('');
  }

  lines.push('### Re-run Quality Gate');
  lines.push('');
  lines.push('After fixing issues, re-run:');
  lines.push('```');
  lines.push('npx quality-gate-sgd');
  lines.push('```');

  return lines.join('\n');
}

interface RunOptions {
  skipSonarQube: boolean;
}

function parseRunArgs(args: string[]): RunOptions {
  return {
    skipSonarQube:
      args.includes('--docker=no') ||
      args.includes('--no-docker') ||
      args.includes('--no-sonar') ||
      args.includes('--coverage-only'),
  };
}

/**
 * Why there is no baseline entry for a committed run.
 *
 * Only reached when `findBaselineEntry` returned nothing, and it throws rather
 * than returning on an indeterminate baseline, so the two remaining cases are a
 * genuine root commit and a parent that simply has no cached reading.
 */
function describeMissingBaseline(): string {
  const baseline = resolveBaselineCommit();
  return baseline.kind === 'root-commit'
    ? 'this is the first commit, so there is no parent to compare against'
    : `no cached reading for parent ${
        baseline.kind === 'parent' ? baseline.hash.slice(0, 7) : 'commit'
      } -- run the gate on that commit, or commit the cache file, to enable monotonic rules`;
}

async function runQualityGate(options: RunOptions = { skipSonarQube: false }): Promise<void> {
  log('Quality Gate SGD v0.1.0');
  log('=======================');

  if (options.skipSonarQube) {
    log('(coverage-only mode - SonarQube skipped)');
  }

  // Load rules (zero-config mode will use embedded defaults if no rules.json)
  const rules = loadRules({ coverageOnly: options.skipSonarQube });
  log(`Rules: ${rules.version} - ${rules.description}`);

  // Commit hash for a clean tree, `wip:<HEAD>:<contentHash>` for a dirty one.
  const { key: cacheKey, isWIP } = getCacheKey();
  if (isWIP) {
    // Split on ':' rather than slicing at a fixed offset. The old form was
    // `wip:<contentHash>` and this read `cacheKey.slice(4, 11)`, so adding HEAD to
    // the key would have printed seven characters of the COMMIT while labelling
    // them `content:` -- and `requireBothRunsOnOneCacheKey` in the harness parses
    // this exact line to prove two runs asked the same question, so a
    // silently-wrong field there would have made that probe agree with itself.
    const [, headHash = '', contentHash = ''] = cacheKey.split(':');
    log(`\nWIP changes on ${headHash.slice(0, 7)} (content: ${contentHash.slice(0, 7)})`);
  } else {
    log(`\nCommit: ${cacheKey.slice(0, 7)}`);
  }

  // Load cache and check for valid cached result BEFORE running expensive operations
  const cache = loadCache();
  const existingEntry = getCacheEntry(cache, cacheKey);

  if (existingEntry && isCacheValid(existingEntry, rules)) {
    log(
      `\nUsing cached result from ${new Date(existingEntry.timestamp).toISOString()}`
    );

    if (existingEntry.evaluation.status === 'pass') {
      // This exit prints a verdict and exits 0 without looking at the metrics at
      // all, so it depends entirely on the stored entry being a complete reading.
      // `isCacheValid` refuses any entry carrying a measurement failure and the
      // cache write below never produces one, which holds up the RECORDED half of
      // that -- but be honest about the two ways the reading can still be stale
      // for the tree in front of us, because both are reachable and neither is
      // closed:
      //
      //   - `sonarqube` has no failure channel (see `evaluateMeasurements`), so a
      //     reading that lost that dimension wholesale records an empty failure
      //     list and is cached as complete. #23/#42.
      //   - The cache key covers tracked content only. Coverage reports are
      //     untracked by design, so a report that is corrupted AFTER a clean
      //     entry is written is never re-read: the same tree is a hard FAIL when
      //     measured and a silent PASS when the cache answers. #41. And for a
      //     project whose code is not under `codePathspecs` the WIP hash is
      //     sha256("") for every working-tree state, so the key never moves at
      //     all. #40.
      //
      // Those are pre-existing and out of scope here. What must not happen is
      // this comment claiming they are handled.
      log('\n✓ Quality gate PASSED (cached)');
      process.exit(0);
    } else {
      // Re-evaluate to get full failure details for guidance
      const baselineEntry = findBaselineEntry(cache, rules, isWIP);
      const reEvalResult = evaluateRules(
        rules,
        existingEntry.metrics,
        baselineEntry
      );

      log('\n✗ Quality gate FAILED (cached)');
      log('\nFailed rules:');
      log(formatFailures(reEvalResult.failedRules));

      // Show top SonarQube issues inline if any sonar-related failure
      const cachedMetrics = existingEntry.metrics;
      const hasSonarFailure = reEvalResult.failedRules.some(
        (f) =>
          f.rule.includes('sonar') ||
          f.rule.includes('blocker') ||
          f.rule.includes('critical') ||
          f.rule.includes('major') ||
          f.rule.includes('minor')
      );
      if (
        hasSonarFailure ||
        (cachedMetrics.sonarqube &&
          cachedMetrics.sonarqube.blocker +
            cachedMetrics.sonarqube.critical +
            cachedMetrics.sonarqube.major +
            cachedMetrics.sonarqube.minor >
            0)
      ) {
        const topIssues = getTopSonarIssues(10);
        if (topIssues.length > 0) {
          log(formatSonarIssues(topIssues));
        }
      }

      log(getRemediationGuidance(reEvalResult.failedRules));
      process.exit(1);
    }
  }

  // No cache hit - run full quality gate
  const config = getConfig();

  // Check SonarQube availability (skip in coverage-only mode)
  if (!options.skipSonarQube) {
    log('\nChecking SonarQube...');
    if (!isSonarqubeAvailable()) {
      log(`ERROR: SonarQube is not running at ${config.sonarqube.url}`);
      log('Start it with: npm run sonar:start');
      log('Or use --coverage-only to skip SonarQube');
      process.exit(1);
    }
    log('  SonarQube is available');

    // Run SonarQube scan to get fresh metrics
    log('\nRunning SonarQube scan...');
    const scanResult = runSonarqubeScan();
    if (!scanResult.success) {
      log('ERROR: SonarQube scan failed');
      if (scanResult.error) {
        log(`  ${scanResult.error}`);
      }
      process.exit(1);
    }
    log('  SonarQube scan completed');
  } else {
    log('\nSkipping SonarQube (coverage-only mode)');
  }

  // Find baseline for monotonic comparison
  const baselineEntry = findBaselineEntry(cache, rules, isWIP);
  if (baselineEntry) {
    log(`\nBaseline: ${new Date(baselineEntry.timestamp).toISOString()}`);
  } else {
    // Says which of the two it is, and what follows from it. The old message
    // guessed ("first run or no parent commit") and omitted the consequence:
    // `evaluateMonotonic` returns nothing when it has no baseline, so every
    // monotonic rule is unenforced for this run. That is not a failure -- a
    // first run genuinely has nothing to compare against, and failing here
    // would make the tool unusable on any fresh clone -- but it is a gap in
    // what the verdict below covers, and it should not have to be inferred.
    const monotonicCount = rules.rules.monotonic?.length ?? 0;
    const why = isWIP
      ? 'no cached reading for the HEAD commit'
      : describeMissingBaseline();

    log(`\nNo baseline found (${why})`);
    if (monotonicCount > 0) {
      log(
        `  ${monotonicCount} monotonic rule(s) not evaluated this run -- nothing to compare against.`
      );
    }
  }

  // Extract metrics
  //
  // The async variant, because it is the only one that loads custom dimensions.
  // Using the sync one here meant every configured `custom.*` ceiling was
  // skipped for want of a metric, so those rules were never enforced.
  log('\nExtracting metrics...');
  const requiredScripts = rules.rules.requiredScripts || ['quality'];
  const metrics = await extractAllMetricsAsync({
    scriptsToRun: requiredScripts,
    skipSonarQube: options.skipSonarQube,
    coverageAbsenceIsFailure: coverageAbsenceIsFailure(rules),
  });

  // Log extracted metrics.
  //
  // 'unavailable' for a dimension the reading does not carry. A fresh reading
  // carries all four -- a zero denominator is reported as 100, see
  // TotalCoverageMetrics -- so this now renders a baseline deserialized from an
  // older cache entry rather than a live gap. Printing a number for an absent
  // dimension would contradict whatever the rules say about it below.
  const pct = (value: number | undefined): string =>
    value === undefined ? 'unavailable' : `${value.toFixed(1)}%`;

  if (metrics.coverage) {
    const { lambda, unit, union } = metrics.coverage;
    if (lambda) {
      log(
        `  Lambda:  branches=${pct(lambda.branches)}, statements=${pct(lambda.statements)}`
      );
    }
    if (unit) {
      log(
        `  Unit:    branches=${pct(unit.branches)}, statements=${pct(unit.statements)}`
      );
    }
    if (union) {
      log(
        `  Union:   branches=${pct(union.branches)}, statements=${pct(union.statements)}`
      );
    }
  }
  if (metrics.sonarqube) {
    log(
      `  SonarQube: bugs=${metrics.sonarqube.bugs}, vulnerabilities=${metrics.sonarqube.vulnerabilities}, smells=${metrics.sonarqube.codeSmells}`
    );
    log(
      `  Severity:  blocker=${metrics.sonarqube.blocker}, critical=${metrics.sonarqube.critical}, major=${metrics.sonarqube.major}, minor=${metrics.sonarqube.minor}, info=${metrics.sonarqube.info}`
    );
  }
  if (metrics.typescript) {
    log(`  TypeScript: errors=${metrics.typescript.errors}`);
  }
  if (metrics.eslint) {
    log(
      `  ESLint: errors=${metrics.eslint.errors}, warnings=${metrics.eslint.warnings}`
    );
  }
  log(
    `  Scripts: ${Object.entries(metrics.scripts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`
  );

  // Evaluate rules
  log('\nEvaluating rules...');
  const result = evaluateRules(rules, metrics, baselineEntry);

  // Create and save cache entry -- unless a measurement failed.
  //
  // A run that could not measure something has nothing worth remembering: its
  // numbers are incomplete by definition, and caching them would keep serving
  // that incomplete reading for the same cache key long after the tool was
  // fixed. Storing the FAILURE is no better, since the next run would report a
  // stale breakage. Not writing means the next run re-measures, which is the
  // only outcome that converges.
  //
  // EVERY failure, gated or not. Scoping this to gated failures (which the rule
  // scoping made tempting, since an ungated failure cannot change this run's
  // verdict) breaks the advisory below in a way that is worse than the cost it
  // saves: a run with an ungated failure writes a cache entry, and the cached-pass
  // path prints `✓ Quality gate PASSED (cached)` and exits 0 without ever looking
  // at `metrics.measurementFailures` -- which the entry demonstrably carries.
  // MEASURED on the synthetic subject with a stray corrupt `coverage-lambda/` and
  // a coverage-only ruleset: run 1 printed the advisory, run 2 printed
  // `✓ Quality gate PASSED (cached)` and nothing else. The advisory became a
  // ONE-SHOT on the surface an adopter actually watches, and the same mechanism
  // let a coverage-only project cache a pass while type-check was missing and
  // eslint had crashed, after which the next run exits 0 having measured nothing
  // at all -- and CI reads the exit code.
  //
  // The cost is that a project with a stray `coverage-lambda` directory
  // re-measures every run. That is the honest trade, and the advisory below tells
  // them how to make it stop.
  const measurementFailures = metrics.measurementFailures ?? [];

  const ungated = measurementFailures.filter(
    (f) => !isMeasurementUnderRule(rules, f.dimension)
  );

  // Printed on EVERY run, which is the point: nothing else reports these, and the
  // run they appear in is never cached, so there is no run that skips them.
  if (ungated.length > 0) {
    log(
      `\n${ungated.length} dimension(s) could not be measured, and no rule grades them:`
    );
    for (const failure of ungated) {
      log(`  ${failure.dimension} (${failure.kind}): ${failure.message}`);
    }
    // The lambda remedy has to name a NONEXISTENT directory, not an empty value.
    // `config.ts` resolves the variable as `process.env.X || 'coverage-lambda'`,
    // so emptying it -- the natural reading of "turn it off" -- falls straight
    // back to the default and the advisory repeats forever with no sign that the
    // fix did nothing.
    log(
      '  Not failing the gate on these -- no rule reads them, directly or through a dimension ' +
        'derived from them. This run is not cached either way, so this repeats every run until ' +
        'the reading is fixed: add a floor, ceiling or monotonic rule on the dimension to make ' +
        'it gating, or stop measuring it (for a stray coverage-lambda directory, point ' +
        'QUALITY_COVERAGE_LAMBDA_DIR at a directory that does not exist -- setting it empty ' +
        'falls back to the default; for a project with no coverage at all, set ' +
        'QUALITY_COVERAGE_REQUIRED=false).'
    );
  }

  // A pass whose monotonic rules never ran is a NARROWER reading than a complete
  // one, and it is recorded as such rather than withheld.
  //
  // Withholding it was the previous answer and it was wrong in a way that took a
  // reproduction to see. The suppression was there for a good reason -- `isCacheValid`
  // accepts any cached pass whose metrics carry no measurement failure, and an
  // unevaluated ratchet leaves no trace in the metrics for it to catch, so a later
  // run could short-circuit to a PASS nobody earned. But refusing the WRITE
  // deadlocked the chain: a clean run needs a baseline at HEAD's parent, which needed
  // one at ITS parent, inductively back to the root commit, which has none. So no
  // entry was ever written on any commit, `PASSED (cached)` was unreachable, and --
  // the part that matters -- every monotonic rule stayed silently unevaluated on
  // every run while the gate printed PASS. MEASURED on a committed tree with one
  // ratchet: two consecutive clean runs, `{"schemaVersion":4,"entries":{}}` both
  // times. `init` generates ratchets by default, so that was the default experience
  // of adopting this tool.
  //
  // `monotonicEvaluated: false` on the entry gets both: `isCacheValid` refuses to
  // serve it as a VERDICT, and `findBaselineEntry` still accepts it as a BASELINE,
  // which is a different question with an honest yes -- these numbers really are a
  // reading of that commit. So the next commit's run has something to ratchet
  // against, and no run ever exits 0 on a rule that did not execute.
  //
  // Still NOT the same as failing the gate on a missing baseline, which is a live
  // question -- see the note above `describeMissingBaseline`.
  const monotonicSkipped =
    (rules.rules.monotonic?.length ?? 0) > 0 && baselineEntry === undefined;

  // A measurement failure is different in kind and still blocks the write: those
  // numbers are not a reading of anything, so they are no use as a baseline either.
  const cachedThisRun = measurementFailures.length === 0;

  if (!cachedThisRun) {
    log(`\nNot caching this run -- it is not a complete reading:`);
    for (const failure of measurementFailures) {
      log(`  ${failure.dimension}: ${failure.kind}`);
    }
  } else {
    const failedRuleNames = result.failedRules.map((f) => f.rule);
    const entry = createCacheEntry(
      metrics,
      rules,
      result.status,
      failedRuleNames,
      !monotonicSkipped
    );
    setCacheEntry(cache, cacheKey, entry);

    if (monotonicSkipped) {
      log(
        '\nCaching this run as a BASELINE only -- its monotonic rules had nothing to ' +
          'compare against, so it is not servable as a verdict and the next run on this ' +
          'commit will re-measure. The commit after this one can ratchet against it.'
      );
    }
  }

  // Prune old entries (keep last 90 days)
  const pruned = pruneOldEntries(cache, 90);
  if (pruned > 0) {
    log(`\nPruned ${pruned} old cache entries`);
  }

  // Save cache. The file is rewritten either way -- pruning alone changes it --
  // but the message must not say "updated" after the run has just been told it is
  // not being cached. That contradiction used to be an edge case; now that ANY
  // measurement failure blocks the write, gated or not, it is the normal path for
  // a project with a stray dimension, and the advisory above depends on the
  // adopter believing the first message.
  saveCache(cache);
  log(cachedThisRun ? '\nCache updated' : '\nCache file rewritten (no entry added)');

  // Report result
  if (result.status === 'pass') {
    log('\n✓ Quality gate PASSED');
    process.exit(0);
  } else {
    log('\n✗ Quality gate FAILED');
    log('\nFailed rules:');
    log(formatFailures(result.failedRules));

    // Show top SonarQube issues inline if any sonar-related failure
    const hasSonarFailure = result.failedRules.some(
      (f) =>
        f.rule.includes('sonar') ||
        f.rule.includes('blocker') ||
        f.rule.includes('critical') ||
        f.rule.includes('major') ||
        f.rule.includes('minor')
    );
    if (
      hasSonarFailure ||
      (metrics.sonarqube &&
        metrics.sonarqube.blocker +
          metrics.sonarqube.critical +
          metrics.sonarqube.major +
          metrics.sonarqube.minor >
          0)
    ) {
      const topIssues = getTopSonarIssues(10);
      if (topIssues.length > 0) {
        log(formatSonarIssues(topIssues));
      }
    }

    log(getRemediationGuidance(result.failedRules));
    process.exit(1);
  }
}

/**
 * Display trajectory analysis from cache.
 */
function runTrajectoryAnalysis(): void {
  log('Quality Gate SGD - Trajectory Analysis');
  log('======================================\n');

  const cache = loadCache();
  const entryCount = Object.keys(cache.entries).length;

  if (entryCount === 0) {
    log('No cache entries found. Run quality gate at least once first.');
    log('  npx quality-gate-sgd run');
    return;
  }

  log(`Found ${entryCount} cache entries\n`);

  const trajectory = buildTrajectory(cache);
  log(formatTrajectorySummary(trajectory));

  // Show quick sparkline for easy visual
  if (trajectory.points.length > 1) {
    log('\nQuality descent visualization:');
    log(`  ${trajectorySparkline(trajectory)}`);
    log('  (left=oldest, right=newest, taller=better quality)\n');
  }

  // Exit with appropriate code based on convergence
  if (trajectory.convergenceState === 'converged') {
    log('\nStatus: Converged to quality target');
    process.exit(0);
  } else if (trajectory.convergenceState === 'improving') {
    log('\nStatus: Still improving, continue iterations');
    process.exit(0);
  } else if (trajectory.convergenceState === 'oscillating') {
    log('\nStatus: Oscillating - may need different approach');
    process.exit(1);
  } else {
    log('\nStatus: Stagnating - check constraints or increase effort');
    process.exit(1);
  }
}

/**
 * List available dimensions.
 */
function runDimensionsList(args: string[]): void {
  const categoryArg = args.find((a) => a.startsWith('--category='));
  const jsonFlag = args.includes('--json');
  const category = categoryArg?.split('=')[1] as DimensionCategory | undefined;

  if (jsonFlag) {
    const dims = category ? getDimensionsByCategory(category) : getAllDimensions();
    console.log(JSON.stringify(dims, null, 2));
    return;
  }

  log('Quality Gate SGD - Available Dimensions');
  log('=======================================\n');

  if (category) {
    const dims = getDimensionsByCategory(category);
    log(`Category: ${category} (${dims.length} dimensions)\n`);
    log(formatDimensionsTable(dims));
  } else {
    const dims = getAllDimensions();
    log(`Total: ${dims.length} dimensions\n`);

    const categories: DimensionCategory[] = ['coverage', 'errors', 'quality', 'custom'];
    for (const cat of categories) {
      const catDims = getDimensionsByCategory(cat);
      if (catDims.length === 0) continue;

      log(`\n## ${cat.charAt(0).toUpperCase() + cat.slice(1)} (${catDims.length})\n`);
      log(formatDimensionsTable(catDims));
    }
  }

  log('\nUse --category=<name> to filter (coverage, errors, quality, custom)');
  log('Use --json for machine-readable output');
}

/**
 * Compute and display fitness score.
 */
async function runScore(args: string[]): Promise<void> {
  const skipSonarQube = args.includes('--coverage-only') ||
    args.includes('--docker=no') ||
    args.includes('--no-sonar');
  const jsonFlag = args.includes('--json');

  if (!jsonFlag) {
    log('Quality Gate SGD - Fitness Score');
    log('================================\n');

    if (skipSonarQube) {
      log('(coverage-only mode - SonarQube skipped)\n');
    }
  }

  // Extract metrics
  const rules = loadRules({ coverageOnly: skipSonarQube });
  const requiredScripts = rules.rules.requiredScripts || ['quality'];
  // Async: a fitness score computed over the configured dimensions minus the
  // custom ones is a confident number about a smaller quality space than the
  // user defined. See extractAllMetricsAsync.
  const metrics = await extractAllMetricsAsync({
    scriptsToRun: requiredScripts,
    skipSonarQube,
  });

  // Compute fitness
  const score = computeFitness(metrics);

  // Reported next to the score rather than in place of it: the score over the
  // dimensions that could be read is still the most useful answer, but it is not
  // the complete one it looks like.
  const unmeasured = describeUnmeasured(metrics);

  if (jsonFlag) {
    console.log(JSON.stringify({
      score,
      unmeasured,
      metrics,
    }, null, 2));
    return;
  }

  if (unmeasured) {
    log(`\n${unmeasured.length} dimension(s) could NOT be measured, and are missing from this score:`);
    for (const u of unmeasured) log(`  ${u.dimension} (${u.kind})`);
    log('');
  }

  log(`Fitness Score: ${formatFitnessScore(score)}`);
  log('');

  // Show breakdown
  const gradient = computeGradient(metrics);
  log('## Dimension Breakdown\n');
  log(formatGradientTable(gradient));
}

/**
 * Suggest next fixes based on gradient.
 *
 * Supports four granularity levels:
 * - --quick: Dimension-level suggestions (which metric to improve)
 * - (default): File-level targets (which file to fix, with cross-dimension analysis)
 * - --deep: Symbol-level targets (which function/class, most precise)
 * - --symbols: Unified symbol-level with normalized metrics (issue density, coverage gap)
 *
 * Graph weighting (enabled by default):
 * - Targets are weighted by their position in the dependency graph
 * - Files with more dependents get higher priority (cascade effect)
 * - Use --no-graph to disable
 */
async function runSuggest(args: string[]): Promise<void> {
  const skipSonarQube = args.includes('--coverage-only') ||
    args.includes('--docker=no') ||
    args.includes('--no-sonar');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 5;
  const jsonFlag = args.includes('--json');
  const quickMode = args.includes('--quick');
  const deepMode = args.includes('--deep');
  const symbolsMode = args.includes('--symbols');
  const callGraphMode = args.includes('--call-graph');
  const noGraph = args.includes('--no-graph');
  const estimateFixability = args.includes('--estimate-fixability');

  // Determine granularity
  const granularity: TargetGranularity = deepMode ? 'symbol' : 'file';

  const includeCallGraphWeights = symbolsMode && callGraphMode;
  // Graph weighting is enabled by default (unless --no-graph or --quick)
  // Call graph weighting is opt-in for symbols mode
  const includeGraphWeights = !noGraph && !quickMode && !includeCallGraphWeights;

  if (!jsonFlag) {
    const modeLabel = quickMode ? 'Dimension-Level'
      : symbolsMode ? 'Unified Symbol-Level'
      : (deepMode ? 'Symbol-Level' : 'File-Level');
    const graphLabel = includeGraphWeights ? ' + Graph-Weighted' : '';
    log(`Quality Gate SGD - Suggested Fixes (${modeLabel}${graphLabel})`);
    log('='.repeat(50) + '\n');

    if (skipSonarQube) {
      log('(coverage-only mode - SonarQube skipped)\n');
    }
    if (includeGraphWeights) {
      log('(graph weighting enabled - files with more dependents prioritized)\n');
    }
    if (includeCallGraphWeights) {
      log('(symbol call-graph weighting enabled - symbols with more callers prioritized)\n');
    }
    if (callGraphMode && !symbolsMode) {
      log('(call-graph weighting only applies with --symbols; ignoring)\n');
    }
    if (symbolsMode) {
      log('(unified symbol mode - normalized issue density across all axes)\n');
    }
  }

  // Extract metrics for fitness score
  const rules = loadRules({ coverageOnly: skipSonarQube });
  const requiredScripts = rules.rules.requiredScripts || ['quality'];
  // Async, for the same reason as runScore: suggestions ranked over a partial
  // dimension set quietly recommend against the wrong things.
  const metrics = await extractAllMetricsAsync({
    scriptsToRun: requiredScripts,
    skipSonarQube,
  });

  // Compute current score
  const currentScore = computeFitness(metrics);

  // `suggest` is the documented SGD gradient surface -- the one an agent drives
  // off -- and it was the only surface that computed metrics and reported nothing
  // about what it could not read. `score` printed this and every MCP suggest
  // response carried it, so an agent asking for the ranked list got a quality
  // space one dimension smaller than the project configured and was told nothing.
  // The comment above the async call already stated the concern; this is the half
  // that acts on it. Printed once here rather than per mode, because all four
  // modes rank over the same metrics.
  const unmeasured = describeUnmeasured(metrics);

  if (unmeasured && !jsonFlag) {
    log(`${unmeasured.length} dimension(s) could NOT be measured, so nothing below ranks them:`);
    for (const u of unmeasured) log(`  ${u.dimension} (${u.kind})`);
    log('');
  }

  // Quick mode: dimension-level suggestions only (original behavior)
  if (quickMode) {
    const suggestions = suggestNextFixes(metrics, limit);

    if (jsonFlag) {
      console.log(JSON.stringify({
        mode: 'dimension',
        currentScore,
        unmeasured,
        suggestions,
      }, null, 2));
      return;
    }

    log(`Current Fitness: ${formatFitnessScore(currentScore)}\n`);

    if (suggestions.length === 0) {
      log('No suggestions - all dimensions are optimal!');
      return;
    }

    log(`## Top ${suggestions.length} Dimension Suggestions\n`);

    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      log(`### ${i + 1}. ${s.displayName}`);
      log('');
      log(`   ${s.rationale}`);
      log(`   Current: ${typeof s.currentValue === 'number' && s.currentValue < 1 ? s.currentValue : s.currentValue.toFixed?.(1) ?? s.currentValue}${s.dimension.includes('coverage') ? '%' : ''}`);
      log(`   Target:  ${typeof s.targetValue === 'number' && s.targetValue < 1 ? s.targetValue : s.targetValue.toFixed?.(1) ?? s.targetValue}${s.dimension.includes('coverage') ? '%' : ''}`);
      log(`   Expected gain: +${s.estimatedGain.toFixed(3)}`);
      log('');
    }
    return;
  }

  // Unified symbol mode: extract symbols first, then enrich issues
  if (symbolsMode) {
    if (!jsonFlag) {
      log('Extracting symbols from codebase...\n');
    }

    const symbolTable = extractSymbols({
      rootDir: process.cwd(),
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['**/node_modules/**', '**/*.d.ts', '**/dist/**', '**/*.test.ts', '**/*.spec.ts'],
    });

    const stats = getSymbolTableStats(symbolTable);

    if (!jsonFlag) {
      log(`Found ${stats.totalSymbols} symbols across ${stats.fileCount} files`);
      log(`  Classes: ${stats.byKind.class}, Methods: ${stats.byKind.method}`);
      log(`  Functions: ${stats.byKind.function}, Arrow functions: ${stats.byKind['arrow-function']}\n`);
      log('Extracting located issues with symbol enrichment...\n');
    }

    const extractedIssues = extractLocatedIssues({
      skipSonarQube,
      skipTypescript: false,
      skipEslint: false,
      symbolTable,
    });

    const addressFitness = computeAddressFitness(symbolTable, extractedIssues, {
      includeCallGraph: true,
    });

    if (!jsonFlag) {
      log(`Found ${extractedIssues.totalCount} issues:`);
      log(`  Coverage: ${extractedIssues.summary.coverage} uncovered branches/functions`);
      log(`  TypeScript: ${extractedIssues.summary.typescript} errors`);
      log(`  ESLint: ${extractedIssues.summary.eslint} issues`);
      log(`  SonarQube: ${extractedIssues.summary.sonarqube} issues\n`);
      log(`${formatAddressFitness(addressFitness)}\n`);
    }

    // Aggregate to unified symbol representation
    const symbolIssues = aggregateToSymbolsWithOptions(extractedIssues, symbolTable, {
      limit: estimateFixability ? limit * 2 : limit, // Get more for fixability estimation
      includeGraphWeights,
      includeCallGraphWeights,
    });

    // Run LLM fixability estimation if requested
    if (estimateFixability && symbolIssues.length > 0) {
      if (!jsonFlag) {
        log('Estimating fixability with LLM...\n');
      }
      await runFixabilityEstimation(symbolIssues, {
        maxSymbols: limit,
      });
      // Trim to limit after re-sort
      symbolIssues.splice(limit);
    }

    if (jsonFlag) {
      console.log(JSON.stringify({
        mode: 'unified-symbols',
        currentScore,
        unmeasured,
        fixabilityEstimated: estimateFixability,
        addressFitness,
        ...formatSymbolIssuesForJson(symbolIssues),
      }, null, 2));
      return;
    }

    log(`Current Fitness: ${formatFitnessScore(currentScore)}\n`);

    if (symbolIssues.length === 0) {
      log('No symbols with issues found. All code is optimal!');
      return;
    }

    log(formatSymbolIssuesList(symbolIssues, {
      title: `Top ${symbolIssues.length} Unified Symbol Optimization Targets`,
      showTotal: true,
    }));
    return;
  }

  // File-level or symbol-level: extract located issues and aggregate
  if (!jsonFlag) {
    log('Extracting located issues...\n');
  }

  const extractedIssues = extractLocatedIssues({
    skipSonarQube,
    skipTypescript: false,
    skipEslint: false,
  });

  if (!jsonFlag) {
    log(`Found ${extractedIssues.totalCount} issues:`);
    log(`  Coverage: ${extractedIssues.summary.coverage} uncovered branches/functions`);
    log(`  TypeScript: ${extractedIssues.summary.typescript} errors`);
    log(`  ESLint: ${extractedIssues.summary.eslint} issues`);
    log(`  SonarQube: ${extractedIssues.summary.sonarqube} issues\n`);
  }

  // Aggregate to optimization targets
  const targets = aggregateToTargets(extractedIssues, {
    granularity,
    limit,
    includeGraphWeights,
  });

  if (jsonFlag) {
    console.log(JSON.stringify({
      mode: granularity,
      currentScore,
      unmeasured,
      ...formatTargetsForJson(targets),
    }, null, 2));
    return;
  }

  log(`Current Fitness: ${formatFitnessScore(currentScore)}\n`);

  if (targets.length === 0) {
    log('No optimization targets found. All metrics are optimal!');
    return;
  }

  // Format and display targets
  const title = deepMode
    ? `Top ${targets.length} Symbol-Level Optimization Targets`
    : `Top ${targets.length} File-Level Optimization Targets`;

  log(formatTargetList(targets, { title, showTotal: true }));
}

// =============================================================================
// Interactive Input Helpers
// =============================================================================

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });
}

async function askQuestion(prompt: string, defaultValue?: string): Promise<string> {
  const rl = createReadlineInterface();
  const displayDefault = defaultValue ? ` [${defaultValue}]` : '';

  return new Promise((resolve) => {
    process.stderr.write(`${prompt}${displayDefault}: `);
    rl.once('line', (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function askYesNo(prompt: string, defaultYes = true): Promise<boolean> {
  const answer = await askQuestion(prompt, defaultYes ? 'Y/n' : 'y/N');
  if (defaultYes) {
    return answer.toLowerCase() !== 'n';
  }
  return answer.toLowerCase() === 'y';
}

// =============================================================================
// Add Dimension Command
// =============================================================================

/**
 * Interactive command to add a custom dimension.
 */
async function runAddDimension(args: string[]): Promise<void> {
  log('Quality Gate SGD - Add Custom Dimension');
  log('======================================\n');

  // Parse args for non-interactive mode
  const commandArg = args.find(a => !a.startsWith('-'));
  const skipRun = args.includes('--no-run');
  const skipConfirm = args.includes('-y') || args.includes('--yes');

  // Get command
  let command = commandArg;
  if (!command) {
    command = await askQuestion('Command or npm script that produces the metric');
    if (!command) {
      log('Error: Command is required');
      process.exit(1);
    }
  }

  // Get optional hint
  const hint = await askQuestion('What does this metric measure? (optional)');

  // Ask to run command
  let runNow = !skipRun;
  if (!skipRun && !skipConfirm) {
    runNow = await askYesNo('Run command now to capture sample output?', true);
  }

  log('\nAnalyzing...');

  // Build dimension
  const result = await buildDimension({
    command,
    hint: hint || undefined,
    runNow,
    fetchDocs: true,
    timeout: 60000,
  });

  if (result.error) {
    log(`\nError: ${result.error}`);
    if (result.rawResponse) {
      log('\nRaw LLM response:');
      log(result.rawResponse.slice(0, 1000));
    }
    process.exit(1);
  }

  if (!result.config) {
    log('\nError: No config generated');
    process.exit(1);
  }

  log('\nGenerated dimension config:\n');
  log(JSON.stringify(result.config, null, 2));

  // Confirm and save
  let shouldSave = skipConfirm;
  if (!skipConfirm) {
    shouldSave = await askYesNo('\nAdd to quality-gate.config.ts?', true);
  }

  if (shouldSave) {
    try {
      appendToConfigFile(result.config);
      log('\n✓ Dimension added to quality-gate.config.ts');
      log('\nNext steps:');
      log('  1. Review the generated config in quality-gate.config.ts');
      log('  2. Run: npx quality-gate-sgd score --coverage-only');
      log('     to see the new dimension in action');
    } catch (error) {
      log(`\nError saving config: ${error}`);
      process.exit(1);
    }
  } else {
    log('\nConfig not saved. You can manually add it to quality-gate.config.ts');
  }
}

// =============================================================================
// Experiment Commands
// =============================================================================

/**
 * Create a new experiment scaffold.
 */
async function runExperimentInit(args: string[]): Promise<void> {
  log('Quality Gate SGD - Create Experiment');
  log('====================================\n');

  // Parse args
  const nameArg = args.find(a => a.startsWith('--name='));
  const designArg = args.find(a => a.startsWith('--design='));
  const agentArg = args.find(a => a.startsWith('--agent='));
  const taskArg = args.find(a => a.startsWith('--task='));
  const baseDirArg = args.find(a => a.startsWith('--dir='));
  const skipConfirm = args.includes('-y') || args.includes('--yes');

  // Get name
  let name = nameArg?.split('=')[1];
  if (!name) {
    name = await askQuestion('Experiment name');
    if (!name) {
      log('Error: Name is required');
      process.exit(1);
    }
  }

  // Get design
  let design = designArg?.split('=')[1];
  if (!design) {
    log('\nExperiment designs:');
    log('  A - Gate vs No-Gate (H1, H2)');
    log('  B - Topology Sensitivity (H3)');
    log('  C - Addressing Fitness (H4-H6)');
    log('  D - Call Graph Weighting (H7, H8)');
    log('  E - Fixability Validity (H9, H10)');
    log('  F - Adjusted Prioritization (H11, H12)');
    design = await askQuestion('Design (A-F)', 'A');
  }
  if (!['A', 'B', 'C', 'D', 'E', 'F'].includes(design.toUpperCase())) {
    log('Error: Invalid design. Must be A-F');
    process.exit(1);
  }

  // Get agent type
  let agentType = agentArg?.split('=')[1];
  if (!agentType) {
    log('\nAgent types:');
    log('  swe-agent - SWE-agent (recommended for SWE-bench)');
    log('  aider - Aider (recommended for code fixes)');
    log('  custom - Custom Docker image');
    agentType = await askQuestion('Agent type', 'swe-agent');
  }

  let customImage: string | undefined;
  if (agentType === 'custom') {
    customImage = await askQuestion('Docker image for custom agent');
    if (!customImage) {
      log('Error: Docker image is required for custom agent');
      process.exit(1);
    }
  }

  // Get task source
  let taskSource = taskArg?.split('=')[1];
  if (!taskSource) {
    log('\nTask sources:');
    log('  swe-bench - SWE-bench benchmark tasks');
    log('  custom - Custom task definition');
    taskSource = await askQuestion('Task source', 'swe-bench');
  }

  // Get description
  const description = await askQuestion('Description (optional)');

  // Confirm
  log('\nExperiment configuration:');
  log(`  Name: ${name}`);
  log(`  Design: ${design.toUpperCase()}`);
  log(`  Agent: ${agentType}${customImage ? ` (${customImage})` : ''}`);
  log(`  Task source: ${taskSource}`);
  if (description) log(`  Description: ${description}`);

  let shouldCreate = skipConfirm;
  if (!skipConfirm) {
    shouldCreate = await askYesNo('\nCreate experiment scaffold?', true);
  }

  if (!shouldCreate) {
    log('Cancelled');
    return;
  }

  // Create scaffold
  const options: ScaffoldOptions = {
    name,
    design: design.toUpperCase() as 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
    agentType: agentType as 'swe-agent' | 'aider' | 'custom',
    customImage,
    taskSource: taskSource as 'swe-bench' | 'custom',
    description: description || undefined,
    baseDir: baseDirArg?.split('=')[1],
    includeExample: true,
  };

  const dirs = createExperimentScaffold(options);

  log('\n✓ Experiment scaffold created');
  log(`\nDirectory: ${dirs.root}`);
  log('\nNext steps:');
  log(`  1. Review experiment.json in ${dirs.root}`);
  log(`  2. Create a run:`);
  log(`     npx quality-gate-sgd experiment init-run --experiment ${dirs.root.split('/').pop()} --condition baseline --task <task-id>`);
  log(`  3. Start the run:`);
  log(`     cd ${dirs.runs}/<run-id>`);
  log(`     docker-compose up`);
}

/**
 * Initialize a new experiment run.
 */
async function runExperimentInitRun(args: string[]): Promise<void> {
  log('Quality Gate SGD - Initialize Run');
  log('=================================\n');

  // Parse args
  const expArg = args.find(a => a.startsWith('--experiment='));
  const condArg = args.find(a => a.startsWith('--condition='));
  const taskArg = args.find(a => a.startsWith('--task='));
  const runIdArg = args.find(a => a.startsWith('--run-id='));

  const experimentId = expArg?.split('=')[1];
  const conditionName = condArg?.split('=')[1];
  const taskId = taskArg?.split('=')[1];
  const runId = runIdArg?.split('=')[1];

  if (!experimentId) {
    log('Error: --experiment=<id> is required');
    log('\nAvailable experiments:');
    const experiments = listExperiments();
    for (const exp of experiments) {
      log(`  ${exp.id} - ${exp.name} (Design ${exp.design})`);
    }
    process.exit(1);
  }

  if (!conditionName) {
    log('Error: --condition=<name> is required');
    process.exit(1);
  }

  if (!taskId) {
    log('Error: --task=<id> is required');
    process.exit(1);
  }

  const run = initializeRun({
    experimentId,
    conditionName,
    taskId,
    runId,
  });

  log('✓ Run initialized');
  log(`\nRun ID: ${run.runId}`);
  log(`Directory: ${run.runDir}`);
  log('\nNext steps:');
  log(`  cd ${run.runDir}`);
  log(`  docker-compose up`);
}

/**
 * Execute an experiment run.
 */
async function runExperimentRun(args: string[]): Promise<void> {
  log('Quality Gate SGD - Execute Run');
  log('==============================\n');

  const expArg = args.find(a => a.startsWith('--experiment='));
  const runArg = args.find(a => a.startsWith('--run='));
  const followLogs = args.includes('--follow');
  const timeout = args.find(a => a.startsWith('--timeout='));

  const experimentId = expArg?.split('=')[1];
  const runId = runArg?.split('=')[1];

  if (!experimentId || !runId) {
    log('Error: --experiment=<id> and --run=<id> are required');
    process.exit(1);
  }

  const timeoutMs = timeout ? parseInt(timeout.split('=')[1], 10) * 1000 : undefined;

  log(`Running experiment ${experimentId}, run ${runId}...`);
  if (followLogs) {
    log('Following logs (Ctrl+C to stop)...\n');
  }

  const result = await executeDockerRun(experimentId, runId, {
    timeout: timeoutMs,
    followLogs,
    onStateChange: (state, _run) => {
      log(`State: ${state}`);
    },
    onLog: (service, message) => {
      log(`[${service}] ${message}`);
    },
  });

  log('\n' + '='.repeat(50));
  log(`Run completed: ${result.state}`);
  if (result.result) {
    log(`Gate passed: ${result.result.gatePassed}`);
    log(`Final score: ${result.result.finalScore}`);
    log(`Gate queries: ${result.result.gateQueries}`);
  }
  if (result.error) {
    log(`Error: ${result.error}`);
  }
}

/**
 * List experiments and runs.
 */
function runExperimentList(args: string[]): void {
  const expArg = args.find(a => a.startsWith('--experiment='));
  const jsonFlag = args.includes('--json');

  if (expArg) {
    // List runs for an experiment
    const experimentId = expArg.split('=')[1];
    const runs = listDockerRuns(experimentId);

    if (jsonFlag) {
      console.log(JSON.stringify(runs, null, 2));
      return;
    }

    log(`Runs for experiment ${experimentId}:`);
    log('');
    if (runs.length === 0) {
      log('  No runs found');
      return;
    }

    for (const run of runs) {
      log(`  ${run.runId}`);
      log(`    State: ${run.state}`);
      if (run.startedAt) {
        log(`    Started: ${new Date(run.startedAt).toISOString()}`);
      }
      if (run.result) {
        log(`    Passed: ${run.result.gatePassed}, Score: ${run.result.finalScore}`);
      }
      log('');
    }
  } else {
    // List all experiments
    const experiments = listExperiments();

    if (jsonFlag) {
      console.log(JSON.stringify(experiments, null, 2));
      return;
    }

    log('Available experiments:');
    log('');
    if (experiments.length === 0) {
      log('  No experiments found');
      log('  Create one with: npx quality-gate-sgd experiment create');
      return;
    }

    for (const exp of experiments) {
      log(`  ${exp.id}`);
      log(`    Name: ${exp.name}`);
      log(`    Design: ${exp.design}`);
      log(`    Agent: ${exp.agent.type}`);
      if (exp.description) {
        log(`    Description: ${exp.description}`);
      }
      log('');
    }
  }
}

/**
 * Analyze a completed experiment batch.
 */
function runExperimentAnalyze(args: string[]): void {
  const batchArg = args.find(a => a.startsWith('--batch='));
  const jsonFlag = args.includes('--json');

  if (!batchArg) {
    log('Error: --batch=<id> is required');
    log('\nUsage: npx quality-gate-sgd experiment analyze --batch=<batch-id>');
    process.exit(1);
  }

  const batchId = batchArg.split('=')[1];
  const batch = loadBatch(batchId);

  if (!batch) {
    log(`Error: Batch not found: ${batchId}`);
    process.exit(1);
  }

  const results = analyzeBatch(batch);

  if (jsonFlag) {
    console.log(JSON.stringify({
      batchId: batch.batchId,
      design: batch.design,
      hypotheses: batch.hypotheses,
      results,
    }, null, 2));
    return;
  }

  log('Quality Gate SGD - Batch Analysis');
  log('=================================\n');
  log(`Batch: ${batch.batchId}`);
  log(`Design: ${batch.design}`);
  log(`Runs: ${batch.runs.length}`);
  log(`Hypotheses: ${batch.hypotheses.join(', ')}`);
  log('');

  const supported = results.filter(r => r.supported).length;
  log(`Results: ${supported}/${results.length} hypotheses supported`);
  log('');

  for (const result of results) {
    const icon = result.supported ? '✓' : '✗';
    log(`${icon} ${result.hypothesis}: ${result.interpretation}`);
  }
}

/**
 * Generate a markdown analysis report for a batch.
 */
function runExperimentReport(args: string[]): void {
  const batchArg = args.find(a => a.startsWith('--batch='));
  const outputArg = args.find(a => a.startsWith('--output='));

  if (!batchArg) {
    log('Error: --batch=<id> is required');
    log('\nUsage: npx quality-gate-sgd experiment report --batch=<batch-id> [--output=<file>]');
    process.exit(1);
  }

  const batchId = batchArg.split('=')[1];
  const batch = loadBatch(batchId);

  if (!batch) {
    log(`Error: Batch not found: ${batchId}`);
    process.exit(1);
  }

  const results = analyzeBatch(batch);
  const report = generateAnalysisReport(batch, results);

  if (outputArg) {
    const outputPath = outputArg.split('=')[1];
    writeFileSync(outputPath, report);
    log(`Report written to: ${outputPath}`);
  } else {
    console.log(report);
  }
}

/**
 * Visualize experiment results with ASCII charts.
 */
function runExperimentVisualize(args: string[]): void {
  const batchArg = args.find(a => a.startsWith('--batch='));
  const typeArg = args.find(a => a.startsWith('--type='));

  if (!batchArg) {
    log('Error: --batch=<id> is required');
    log('\nUsage: npx quality-gate-sgd experiment visualize --batch=<batch-id> [--type=batch|results]');
    process.exit(1);
  }

  const batchId = batchArg.split('=')[1];
  const batch = loadBatch(batchId);

  if (!batch) {
    log(`Error: Batch not found: ${batchId}`);
    process.exit(1);
  }

  const vizType = typeArg?.split('=')[1] || 'batch';

  log('Quality Gate SGD - Experiment Visualization');
  log('==========================================\n');

  if (vizType === 'results') {
    const results = analyzeBatch(batch);
    log(visualizeResults(results));
  } else {
    log(visualizeBatch(batch));
  }
}

/**
 * Download SWE-bench dataset splits.
 */
async function runExperimentDownload(args: string[]): Promise<void> {
  const splitArg = args.find(a => a.startsWith('--split='));
  const dataDirArg = args.find(a => a.startsWith('--data-dir='));
  const forceFlag = args.includes('--force');
  const allFlag = args.includes('--all');
  const statusFlag = args.includes('--status');

  const dataDir = dataDirArg?.split('=')[1] || 'data/swe-bench';

  // Status check
  if (statusFlag) {
    log('Quality Gate SGD - SWE-bench Dataset Status');
    log('==========================================\n');

    checkSWEBenchLocalSplits(dataDir);
    const splits: DatasetSplit[] = ['dev', 'test', 'lite', 'verified'];

    for (const split of splits) {
      const info = getSWEBenchDatasetInfo(split, dataDir);
      if (info) {
        log(`  ✓ ${split.padEnd(10)} ${info.instanceCount} instances (${formatBytes(info.sizeBytes)})`);
      } else {
        log(`  ✗ ${split.padEnd(10)} not downloaded`);
      }
    }

    log('');
    log('Use --split=<split> to download a specific split');
    log('Use --all to download all splits');
    return;
  }

  // Determine which splits to download
  let splits: DatasetSplit[] = [];

  if (allFlag) {
    splits = ['dev', 'test', 'lite', 'verified'];
  } else if (splitArg) {
    const split = splitArg.split('=')[1] as DatasetSplit;
    if (!['dev', 'test', 'lite', 'verified'].includes(split)) {
      log(`Error: Invalid split "${split}". Valid options: dev, test, lite, verified`);
      process.exit(1);
    }
    splits = [split];
  } else {
    // Default to 'lite' for quick experiments
    splits = ['lite'];
    log('No split specified, defaulting to "lite" (smallest subset)\n');
  }

  log('Quality Gate SGD - SWE-bench Dataset Download');
  log('============================================\n');
  log(`Data directory: ${dataDir}`);
  log(`Splits to download: ${splits.join(', ')}`);
  log(`Force re-download: ${forceFlag ? 'yes' : 'no'}`);
  log('');

  for (const split of splits) {
    log(`Downloading ${split}...`);

    let lastProgress = '';
    const result = await downloadSWEBenchSplit(split, {
      dataDir,
      force: forceFlag,
      onProgress: (downloaded, total) => {
        const bar = progressBar(downloaded, total);
        if (bar !== lastProgress) {
          process.stderr.write(`\r  ${bar}`);
          lastProgress = bar;
        }
      },
    });

    // Clear progress line
    process.stderr.write('\r' + ' '.repeat(80) + '\r');

    if (result.success) {
      if (result.cached) {
        log(`  ✓ ${split}: Already downloaded (${result.instanceCount} instances, ${formatBytes(result.sizeBytes)})`);
      } else {
        log(`  ✓ ${split}: Downloaded ${result.instanceCount} instances (${formatBytes(result.sizeBytes)}) in ${(result.durationMs / 1000).toFixed(1)}s`);
      }
      log(`    Path: ${result.filePath}`);
    } else {
      log(`  ✗ ${split}: Failed - ${result.error}`);
    }
    log('');
  }

  log('Done! You can now run experiments with:');
  log(`  npx quality-gate-sgd experiment create --design=A --dataset=${splits[0]}`);
}

/**
 * Main experiment command dispatcher.
 */
async function runExperimentCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'create':
    case 'new':
      await runExperimentInit(args.slice(1));
      break;

    case 'init-run':
      await runExperimentInitRun(args.slice(1));
      break;

    case 'run':
    case 'execute':
      await runExperimentRun(args.slice(1));
      break;

    case 'list':
    case 'ls':
      runExperimentList(args.slice(1));
      break;

    case 'analyze':
      runExperimentAnalyze(args.slice(1));
      break;

    case 'report':
      runExperimentReport(args.slice(1));
      break;

    case 'visualize':
    case 'viz':
      runExperimentVisualize(args.slice(1));
      break;

    case 'download':
    case 'fetch':
      await runExperimentDownload(args.slice(1));
      break;

    default:
      log('Quality Gate SGD - Experiment Commands');
      log('======================================\n');
      log('USAGE:');
      log('  npx quality-gate-sgd experiment <command> [options]\n');
      log('COMMANDS:');
      log('  create      Create a new experiment scaffold');
      log('  init-run    Initialize a new run for an experiment');
      log('  run         Execute an experiment run');
      log('  list        List experiments or runs');
      log('  analyze     Analyze completed batch and test hypotheses');
      log('  report      Generate markdown analysis report');
      log('  visualize   Show ASCII visualizations of results');
      log('  download    Download SWE-bench dataset splits\n');
      log('EXAMPLES:');
      log('  npx quality-gate-sgd experiment create --name="Gate Test" --design=A');
      log('  npx quality-gate-sgd experiment init-run --experiment=exp-xxx --condition=baseline --task=test-1');
      log('  npx quality-gate-sgd experiment run --experiment=exp-xxx --run=run-xxx --follow');
      log('  npx quality-gate-sgd experiment list');
      log('  npx quality-gate-sgd experiment list --experiment=exp-xxx');
      log('  npx quality-gate-sgd experiment analyze --batch=batch-xxx');
      log('  npx quality-gate-sgd experiment report --batch=batch-xxx --output=report.md');
      log('  npx quality-gate-sgd experiment visualize --batch=batch-xxx --type=results');
      log('  npx quality-gate-sgd experiment download --split=lite');
      log('  npx quality-gate-sgd experiment download --status');
      break;
  }
}

function showHelp(): void {
  console.log(`
quality-gate-sgd - Deterministic quality gates for LLM agents

USAGE:
  npx quality-gate-sgd [command] [options]

COMMANDS:
  run           Run the quality gate (default if no command specified)
  init          Initialize quality gates with LLM-guided configuration
  trajectory    Analyze quality descent trajectory from cache
  list-issues   List SonarQube issues with filtering
  dimensions    List available metric dimensions
  score         Compute current fitness score (0-100)
  suggest       Get recommended next fixes based on gradient
  add-dimension Add a custom dimension using LLM analysis
  mcp           Start MCP server for Claude integration
  help          Show this help message

OPTIONS for 'init':
  -y, --yes           Accept all defaults (non-interactive)
  --docker=no         Skip SonarQube, coverage-only mode
  -v, --verbose       Show detailed analysis

OPTIONS for 'run':
  --coverage-only     Skip SonarQube, only use coverage/TS/ESLint metrics
  --docker=no         Same as --coverage-only (no Docker needed)

OPTIONS for 'trajectory':
  (No options - analyzes existing cache data)

OPTIONS for 'list-issues':
  --severity=LEVEL    Filter by severity (BLOCKER, CRITICAL, MAJOR, MINOR, INFO)
  --limit=N           Maximum issues to show (default: 100)
  --rule=RULE         Filter by rule ID
  --file=PATH         Filter by file path pattern
  --summary, -s       Show summary only

OPTIONS for 'dimensions':
  --category=NAME     Filter by category (coverage, errors, quality, custom)
  --json              Output as JSON for programmatic use

OPTIONS for 'score':
  --coverage-only     Skip SonarQube, only use coverage/TS/ESLint metrics
  --json              Output as JSON for programmatic use

OPTIONS for 'suggest':
  --quick             Dimension-level suggestions only (fastest, least specific)
  --deep              Symbol-level targets with cross-dimension analysis (most specific)
  --symbols           Unified symbol-level with normalized metrics (issue density, coverage gap)
  (default)           File-level targets - balances specificity and token cost
  --no-graph          Disable dependency graph weighting (pure ΔQ ranking)
  --call-graph        Use symbol call graph weighting (only with --symbols)
  --coverage-only     Skip SonarQube, only use coverage/TS/ESLint metrics
  --limit=N           Number of suggestions to show (default: 5)
  --json              Output as JSON for programmatic use
  --estimate-fixability  Use LLM to estimate what % of issues can be fixed in one pass
                         (requires OPENAI_API_KEY, works with --symbols)

  Graph Weighting (enabled by default for file/symbol modes):
    Targets are weighted by position in the dependency graph. Files with
    more dependents get higher priority because fixing them has cascading
    benefits across the codebase. Use --no-graph to disable.

  Symbol Call Graph Weighting (--call-graph):
    Uses a static symbol call graph to prioritize symbols with more callers.
    This is a symbol-level alternative to file dependency weighting and only
    applies to unified symbol mode (--symbols).

  Fixability Estimation (--estimate-fixability):
    Uses GPT-5-nano to pre-read each code segment and estimate what fraction
    of issues can realistically be fixed in one edit session. The ΔQ is then
    adjusted by this fixability score, prioritizing actionable suggestions.

  Unified Symbol Mode (--symbols):
    Uses TypeScript AST parsing to extract symbols (functions, classes, methods)
    and maps ALL issues from all axes to their containing symbols. This enables:
    - Normalized issue density (issues/SLOC within symbol)
    - Cross-axis analysis (same function has coverage gaps AND TS errors)
    - Fair comparison across symbols of different sizes

OPTIONS for 'add-dimension':
  <command>           Command or script to analyze (can be interactive if omitted)
  --no-run            Skip running the command (use if you have sample output)
  -y, --yes           Skip confirmation prompts

OPTIONS for 'mcp':
  (No options - starts stdio-based MCP server for Claude integration)

MCP TOOLS:
  quality_gate_run       Run quality gate, return pass/fail + metrics
  quality_gate_score     Get fitness score (0-100)
  quality_gate_suggest   Get recommended fixes by gradient
  quality_gate_trajectory Get quality improvement history
  quality_gate_explain   Explain dimension or concept

MCP RESOURCES:
  quality://dimensions       List all available dimensions
  quality://rules            Current rules.json configuration
  quality://fitness          Fitness weights and config
  quality://theory/convergence Convergence theorem docs
  quality://theory/geometry  Quality space geometry docs

EXAMPLES:
  npx quality-gate-sgd init                         # Interactive setup
  npx quality-gate-sgd init -y                      # Quick setup with defaults
  npx quality-gate-sgd init --docker=no             # Coverage-only configuration
  npx quality-gate-sgd                              # Run quality gate
  npx quality-gate-sgd run                          # Same as above
  npx quality-gate-sgd --coverage-only              # Run without SonarQube
  npx quality-gate-sgd trajectory                   # Analyze descent
  npx quality-gate-sgd list-issues --severity=MAJOR
  npx quality-gate-sgd list-issues -s               # Summary view
  npx quality-gate-sgd dimensions                   # List all dimensions
  npx quality-gate-sgd dimensions --category=coverage
  npx quality-gate-sgd score --coverage-only        # Get fitness score
  npx quality-gate-sgd suggest                      # File-level targets (default)
  npx quality-gate-sgd suggest --quick              # Dimension-level only (fast)
  npx quality-gate-sgd suggest --deep --limit=3     # Symbol-level targets (precise)
  npx quality-gate-sgd suggest --symbols            # Unified symbol-level (normalized)
  npx quality-gate-sgd add-dimension                # Interactive dimension builder
  npx quality-gate-sgd add-dimension "npx madge --circular --json src/" -y
  npx quality-gate-sgd mcp                          # Start MCP server for Claude

SGD THEORY:
  This tool creates "gradient descent-like" behavior from stochastic LLM agents
  by providing deterministic quality feedback. The trajectory command shows
  how quality has improved over iterations.

  DISCRETE DIFFERENTIABILITY:
  The 'suggest' command provides target-space gradients: ∇Q = [∂Q/∂target₁, ...]
  where each target is a (file, symbol) tuple. This enables "discrete SGD" -
  we compute expected ΔQ for each enumerable fix. One target may address
  MULTIPLE dimensions (coverage + errors + smells), making it more valuable
  than fixing issues in isolation.

CONFIGURATION:
  Run 'npx quality-gate-sgd init' for guided setup, or create a rules.json file
  manually. See templates/rules.template.json for an example.

ENVIRONMENT VARIABLES:
  SONARQUBE_URL           SonarQube server URL (default: http://localhost:9000)
  SONARQUBE_PROJECT_KEY   Project key (auto-detected from sonar-project.properties)
  QUALITY_RULES_FILE      Path to rules.json (default: rules.json)
  QUALITY_CODE_PATHSPECS  Paths to include in content hashing (default: src/,tests/,scripts/)
  ANTHROPIC_API_KEY       API key for LLM suggestions (optional, for init)

For more information, see: https://github.com/your-org/quality-gate-sgd
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'run';

  switch (command) {
    case 'run': {
      const runOptions = parseRunArgs(args.slice(1));
      await runQualityGate(runOptions);
      break;
    }

    case 'init':
      await runInit(args.slice(1));
      break;

    case 'trajectory':
      runTrajectoryAnalysis();
      break;

    case 'list-issues':
      await listIssues(args.slice(1));
      break;

    case 'dimensions':
      runDimensionsList(args.slice(1));
      break;

    case 'score':
      await runScore(args.slice(1));
      break;

    case 'suggest':
      await runSuggest(args.slice(1));
      break;

    case 'add-dimension':
      await runAddDimension(args.slice(1));
      break;

    case 'mcp':
      await runMcpServer();
      break;

    case 'experiment':
    case 'exp':
      await runExperimentCommand(args.slice(1));
      break;

    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;

    default:
      // If first arg doesn't look like a command, treat it as 'run' args
      if (command.startsWith('--') || command.startsWith('-')) {
        const runOptions = parseRunArgs(args);
        await runQualityGate(runOptions);
      } else {
        console.error(`Unknown command: ${command}`);
        console.error('Run "npx quality-gate-sgd help" for usage information.');
        process.exit(1);
      }
  }
}

main().catch((err) => {
  console.error(`\nError: ${err}`);
  process.exit(1);
});
