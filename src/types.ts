/**
 * Type definitions for the Quality Gate system
 * Schema Version: 3
 */

import type { MeasurementFailure } from './providers/types.js';

// =============================================================================
// Cache Schema
// =============================================================================

/**
 * Bumped whenever the DEFINITION OF A PASS changes, because `cli.ts` exits 0 on a
 * cached pass without measuring anything. A stored verdict is a claim about
 * semantics that no longer exist, and reusing it carries the defect forward past
 * its fix. `loadCache` discards a mismatched schema, which is exactly the wanted
 * effect: the cost of a bump is one re-measurement per commit.
 *
 * 2 -- measurement failures started failing the gate. Version 1 entries were
 *   computed under the old semantics, where a crashed linter or type-checker
 *   became `{errors: 0}`, so a stored PASS from then may be a vacuous one.
 *
 * 3 -- two separate changes to what a pass means, either sufficient on its own:
 *
 *     - Zero-denominator dimensions changed VALUE. A branchless project's
 *       `coverage.*.branches` was 0 (union) or istanbul's copied-through 100
 *       (unit) and is now a deliberate 100 in both, with the all-zero report
 *       refused as `measured-nothing`. Stored metrics and stored verdicts about
 *       them disagree with what this version would compute from the same report.
 *     - Which measurement failures FAIL changed: only dimensions some rule grades
 *       do, now including the dimensions a graded one is DERIVED from. A
 *       version-2 entry can hold a stored FAIL for a dimension nothing grades --
 *       a stray `coverage-lambda` -- that this version passes.
 *
 *   The first makes a stored PASS potentially vacuous and the second makes a
 *   stored FAIL potentially spurious, so the entries cannot be salvaged in either
 *   direction.
 *
 * 4 -- an ABSENT coverage summary became a `report-missing` measurement failure
 *   for a suite that requires one (#43). This is squarely a change to what a pass
 *   means, and the entries it invalidates are the dangerous ones: a version-3
 *   entry can hold `coverage: {}`, no `measurementFailures`, and a PASS that a
 *   ceiling or a ratchet reached by silently skipping the absent value -- because
 *   `evaluateCeilings` and `evaluateMonotonic` both `continue` on an undefined
 *   metric while only `evaluateFloors` reports one. Confirmed by adversarial
 *   review: with the same key and the same rules, `isCacheValid` accepted exactly
 *   that entry, so this version printed `PASSED (cached)` and exited 0 without
 *   ever looking for the report. The fix would have been undone by any cache
 *   written before it, which is the situation this counter exists for.
 *
 *   Not a further reason, but worth recording next to them: a version-4 entry can
 *   only ever hold a reading with no RECORDED measurement failure. `cli.ts`
 *   refuses to cache a run with any failure, gated or not, and `isCacheValid`
 *   refuses an entry that carries one -- which covers entries written by an
 *   intermediate build that scoped the suppression to gated failures only.
 *
 *   "No recorded failure" is weaker than COMPLETE, and the gap is not closed:
 *     - `sonarqube` has no failure channel at all, so a reading that lost that
 *       whole dimension records an empty failure list and caches as clean (#42).
 *     - The key covers tracked content only, so a coverage report corrupted after
 *       a clean entry was written is never re-read (#41) -- and for a project
 *       whose code falls outside `codePathspecs` the WIP hash is sha256("") for
 *       every working-tree state, so the key never moves (#40).
 *   Do not strengthen this claim back to "complete" until those are closed.
 */
export interface QualityGateCache {
  schemaVersion: 4;
  entries: Record<string, CacheEntry>;
}

export interface CacheEntry {
  timestamp: number;
  rulesVersion: string;
  rulesHash: string;

  evaluation: {
    status: 'pass' | 'fail';
    failedRules: string[];
  };

  metrics: Metrics;

  /**
   * False when this run had monotonic rules configured and no baseline to compare
   * them against, so they did not execute.
   *
   * The entry is then a usable BASELINE and not a usable VERDICT, and that
   * distinction is the whole reason the field exists. Refusing to write it at all --
   * which is what happened before -- deadlocked the cache permanently for any
   * project with a ratchet:
   *
   *     a clean run needs a baseline at HEAD's parent
   *       -> that run needed one at ITS parent
   *         -> ... -> the root commit, which has none.
   *
   * So no entry was ever written, on any commit, ever; `PASSED (cached)` was
   * unreachable and -- far worse -- every monotonic rule was silently unevaluated on
   * every run while the gate printed PASS. Reproduced on a committed tree with one
   * ratchet: two consecutive clean runs, `{"schemaVersion":4,"entries":{}}` both
   * times. `init` generates ratchets by default, so that was the default experience.
   *
   * Optional rather than required because entries written before this field existed
   * are still honest readings; `isCacheValid` treats a missing value as "evaluated",
   * which is what it meant when they were written.
   */
  monotonicEvaluated?: boolean;
}

export interface Metrics {
  coverage?: AllCoverageMetrics;
  typescript?: TypescriptMetrics;
  eslint?: EslintMetrics;
  sonarqube?: SonarqubeMetrics;
  bundle?: BundleMetrics;
  scripts: Record<string, 'pass' | 'fail'>;
  sloc?: number; // Source lines of code for normalization
  /** Custom user-defined metrics (path without "custom." prefix → value) */
  custom?: Record<string, number>;

  /**
   * Measurements that could not be taken, and why.
   *
   * Carried inside Metrics rather than passed beside it deliberately. Every
   * dimension above is optional, so "absent" already means two different
   * things -- nobody asked for it, or asking failed -- and only this list tells
   * them apart. A ceiling on an absent metric is silently skipped by
   * `evaluateRules`, which is how a dead linter used to pass; the failures
   * recorded here are what make that same absence loud.
   *
   * It travels with the data so that no call site can forget to forward it. A
   * fourth parameter to `evaluateRules` would have to be threaded through six
   * call sites, and the one that got missed would be a silent hole of exactly
   * the kind this field exists to close.
   */
  measurementFailures?: readonly MeasurementFailure[];
}

// =============================================================================
// Normalized Metrics (for SGD continuity)
// =============================================================================

/**
 * Normalized metrics for smoother gradient descent behavior.
 * Discrete counts are transformed to per-kSLOC densities.
 */
export interface NormalizedMetrics {
  // Already continuous (percentages)
  coverageBranches: number;
  coverageStatements: number;
  coverageLines: number;
  coverageFunctions: number;
  duplications: number;

  // Normalized to per-kSLOC (smoother than raw counts)
  bugsPerKsloc: number;
  vulnerabilitiesPerKsloc: number;
  smellsPerKsloc: number;
  blockerPerKsloc: number;
  criticalPerKsloc: number;
  majorPerKsloc: number;
  minorPerKsloc: number;

  // Raw counts (for reference, not optimization)
  typescriptErrors: number;
  eslintErrors: number;
}

// =============================================================================
// Trajectory Types (for descent analysis)
// =============================================================================

export interface TrajectoryPoint {
  key: string; // commit hash or wip:hash
  timestamp: number;
  metrics: NormalizedMetrics;
  qualityScore: number; // Single scalar for descent tracking
  passed: boolean;
}

export interface Trajectory {
  points: TrajectoryPoint[];
  totalDescent: number; // Sum of quality improvements
  averageStepSize: number; // Mean |Δquality|
  monotonicSteps: number; // Steps that improved
  regressionSteps: number; // Steps that worsened
  convergenceState: ConvergenceState;
}

export type ConvergenceState =
  | 'improving' // Consistent descent
  | 'converged' // At or near target
  | 'stagnating' // No progress
  | 'oscillating'; // Back and forth

export interface AllCoverageMetrics {
  lambda?: TotalCoverageMetrics;
  unit?: TotalCoverageMetrics;
  union?: CoverageMetrics;
}

/**
 * Coverage read from one report's `total`.
 *
 * A fresh reading populates all four dimensions: a zero denominator beside a
 * non-zero one is reported as 100 (every one of the zero branches in a
 * branchless file is covered), and a report where EVERY denominator is zero is
 * refused outright as `measured-nothing` rather than yielding metrics at all.
 * See extractFromTotal in providers/coverage.ts for why those two zero cases
 * must not be treated alike.
 *
 * The fields stay optional anyway, for one reason that is not about fresh
 * readings: baseline metrics are deserialized from `.quality-gate-cache.json`,
 * written by whatever version of this tool last ran, and an earlier version
 * DROPPED zero-denominator dimensions instead of reporting them. Declaring them
 * required would be a claim about data this process did not produce. Every
 * consumer therefore still has to handle absence -- and `evaluateCeilings` and
 * `evaluateMonotonic` handling it by SKIPPING is exactly why the reader stopped
 * dropping dimensions.
 *
 * A separate type from CoverageMetrics rather than loosening that one, so the
 * ripple stops here. CoverageMetrics is also `FileInfo.coverage` and the
 * recomputed `union`, both of which are consumed arithmetically
 * (`Math.min(coverage.branches, ...)`, `cov.branches.toFixed(0)`) by code that
 * has nothing to do with this defect.
 */
export interface TotalCoverageMetrics {
  readonly statements?: number;
  readonly branches?: number;
  readonly functions?: number;
  readonly lines?: number;
}

export interface CoverageMetrics {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

export interface TypescriptMetrics {
  errors: number;
  warnings: number;
  // Root-cause counts for improved local continuity
  rootCauses?: number; // Distinct (file, code, symbolPath) combinations
}

export interface EslintMetrics {
  errors: number;
  warnings: number;
  // Root-cause counts for improved local continuity
  rootCauses?: number; // Distinct (file, ruleId, symbolPath) combinations
}

// =============================================================================
// Root-Cause Analysis Types
// =============================================================================

/**
 * A root cause identifies the source of potentially cascading errors.
 * Multiple errors with the same root cause count as ONE issue.
 */
export interface RootCause {
  file: string;
  code: string; // Error code (TS2345, @typescript-eslint/no-unused-vars)
  symbolPath?: string; // Path to affected symbol (e.g., "Foo.bar.baz")
  line?: number; // Line number (for grouping nearby issues)
}

/**
 * Groups errors by root cause to restore local continuity.
 * Cascading errors from one root cause = one unit of improvement when fixed.
 */
export interface RootCauseGroup {
  rootCause: RootCause;
  errorCount: number; // How many raw errors map to this root cause
  messages: string[]; // Sample error messages
}

export interface SonarqubeMetrics {
  bugs: number;
  vulnerabilities: number;
  codeSmells: number;
  coverage: number;
  duplications: number;
  // Severity breakdown
  blocker: number;
  critical: number;
  major: number;
  minor: number;
  info: number;
}

export interface BundleMetrics {
  totalSize: number;
  chunks: Record<string, number>;
}

// =============================================================================
// Rules Schema
// =============================================================================

export interface QualityRules {
  version: string;
  description: string;
  rules: {
    floors?: Record<string, number>;
    ceilings?: Record<string, number>;
    monotonic?: MonotonicRule[];
    requiredScripts?: string[];
  };
}

export interface MonotonicRule {
  direction: 'up' | 'down';
  metrics: string[];
}

// =============================================================================
// Evaluation Results
// =============================================================================

export interface EvaluationResult {
  status: 'pass' | 'fail';
  failedRules: FailedRule[];
}

export interface FailedRule {
  type: 'floor' | 'ceiling' | 'monotonic' | 'script' | 'measurement';
  rule: string;
  message: string;
  baseline?: number;
  current?: number;
}

// =============================================================================
// Dependency Graph Types
// =============================================================================

export interface FileInfo {
  path: string;
  degree: number;
  localDependencies: string[];
  dependencyCount: number;
  directDependents: number;
  indirectDependents: number;
  impact: number;
  coverage?: CoverageMetrics;
}

// =============================================================================
// Optimization Types
// =============================================================================

export interface OptimizationConfig {
  strategy: 'greedy' | 'sampled';
  candidates?: number;
  severityWeights?: Record<string, number>;
  priorityWeights?: PriorityWeights;
}

export interface PriorityWeights {
  coverage: number;
  ease: number;
  impact: number;
  severity: number;
}

export interface PrioritizedFile {
  file: FileInfo;
  priority: number;
  components: {
    coverageGap: number;
    easeOfTesting: number;
    importance: number;
    severityScore: number;
  };
}
