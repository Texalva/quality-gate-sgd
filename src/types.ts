/**
 * Type definitions for the Quality Gate system
 * Schema Version: 3
 */

import type { MeasurementFailure } from './providers/types.js';
import type { PackageManager } from './runner.js';

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
 *     - The key covers tracked content only, so a coverage report corrupted after
 *       a clean entry was written is never re-read (#41) -- and for a project
 *       whose code falls outside `codePathspecs` the WIP hash is sha256("") for
 *       every working-tree state, so the key never moves (#40).
 *   Do not strengthen this claim back to "complete" until those are closed.
 *
 * 5 -- an individual ratcheted metric absent from the baseline became a rule that
 *   DID NOT RUN, rather than one that silently passed. Version 4 recorded the
 *   opposite: `monotonicSkipped` in cli.ts was true only when the whole baseline was
 *   missing, so a run that skipped a ratchet per-metric was stamped
 *   `monotonicEvaluated: true`, and `isCacheValid` refuses only an explicit `false`.
 *   Adversarial review CONSTRUCTED such an entry and confirmed `isCacheValid`
 *   returns true for it -- so without this bump the fixed build would serve, as an
 *   earned verdict, precisely the run the fix exists to catch. Reachable by anyone
 *   who ran a previous build with a ratchet in rules.json.
 *
 *   Also carried by 5: `measurementInputsHash`, below.
 *
 * 6 -- a lost SonarQube reading became a measurement failure, where version 5 had no
 *   channel for one at all. A version-5 entry can therefore hold a PASS from a run
 *   whose SonarQube was unreachable, refusing, or unprovisioned: no `sonarqube`
 *   metrics, no recorded failure, and every `sonarqube.*` ceiling reached by the
 *   silent skip in `evaluateCeilings`. Adversarial review constructed that entry and
 *   confirmed `isCacheValid` accepts it -- so the fixed build would serve, as an
 *   earned verdict, the exact run the fix exists to catch, and would exit 0 before
 *   contacting the server. Reachable by anyone who ran a version-5 build, which is
 *   every build between the ratchet fix and this one.
 *
 *   Three further changes to what a pass means arrived with it, any one sufficient:
 *     - An absent CEILING metric with no stated reason is now reported as a rule that
 *       did not run, which marks the entry baseline-only. Version 5 skipped it in
 *       silence, so a stored PASS can rest on ceilings nothing applied.
 *     - A partial `/api/measures/component` response is refused. Version 5
 *       substituted 0 for any measure the server did not send, so a response
 *       carrying only `bugs` satisfied every other sonarqube ceiling at zero.
 *     - Only HTTP 200 counts as a reading. Version 5 accepted every status below
 *       400, so a 3xx redirect body of the right shape was accepted as measures.
 *
 * 7 -- an eslint the project does not have became a measurement failure, where version
 *   6 measured whatever the launcher supplied. `npx eslint` and `bunx eslint` do not
 *   fail on an absent binary, they SUPPLY one: reproduced in a directory holding only a
 *   package.json, an eslint.config.mjs and src/a.js, `npx eslint --format json src/`
 *   exited 0 with a complete per-file errorCount-0 report from eslint v10.8.1 out of
 *   `~/.npm/_npx`, and the version-6 CLI printed `ESLint: errors=0, warnings=0` and
 *   `✓ Quality gate PASSED` against an `eslint.errors: 0` ceiling. A version-6 entry can
 *   therefore hold a PASS whose lint number came from a linter the project never
 *   installed, with no recorded failure -- and `cli.ts` exits 0 on a cached pass before
 *   `binaryInvocation` is ever called, so the fixed build would serve exactly the run
 *   the fix exists to catch. Reachable by anyone who upgrades the tool without touching
 *   the tree: the content hash folds in `git ls-files`, `git diff HEAD` and the untracked
 *   listing, so an unchanged commit re-gated after an upgrade hits the stored entry.
 *
 *   Version 7 carries a SECOND change to what a pass means, landed in the same
 *   unreleased version rather than as an eighth bump because no build with one and not
 *   the other was ever published: a sonarqube reading is now BOUND to the analysis this
 *   run submitted (`Metrics.sonarqubeProvenance`). A version-6 entry -- and an entry
 *   from an intermediate build of version 7 -- can hold a PASS whose `sonarqube.*`
 *   ceilings were satisfied by an analysis a second publisher for the same project key
 *   replaced between `waitForSonarTask` returning SUCCESS and the measures read.
 *   `/api/measures/component` takes a component and a metric list and nothing else, so
 *   nothing in that response said which analysis it described and nothing compared the
 *   two; the entry is stamped `monotonicEvaluated: true` because no rule was recorded
 *   as unapplied. `isCacheValid` refuses such an entry explicitly -- see the
 *   provenance check there -- because the schema counter alone cannot catch an entry
 *   written by an intermediate revision of the same version, which is the same
 *   allowance version 3 records for cache suppression.
 *
 *   The cost is the standing cost of every bump and it was accepted at 3, 4, 5 and 6:
 *   one re-measurement, and one commit's worth of baseline-missing ratchets, which are
 *   reported as rules that did not run and resolve against the entry that run writes.
 */
export interface QualityGateCache {
  schemaVersion: 7;
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
   * False when some monotonic rule configured for this run did not execute.
   *
   * TWO ways that happens, and the second was silently unrecorded for longer than
   * the first. (1) No baseline entry at all, so `evaluateMonotonic` returns nothing.
   * (2) A baseline exists and is accepted, but an INDIVIDUAL ratcheted metric is
   * absent from it (a ratchet added to rules.json after the baseline was written, a
   * dimension renamed, a dimension that was failing to measure when the baseline was
   * taken) or absent from this run's reading. Both leave a configured rule
   * unexecuted, so both write `false`; see `EvaluationResult.unevaluated`.
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

  /**
   * Which package manager produced these numbers.
   *
   * The cache key is a hash of tracked code under `codePathspecs` (default
   * `src/,tests/,scripts/`), which does NOT include lockfiles -- so adding a
   * `bun.lock` to an npm project changes the runner, and can change the
   * measurements, without moving the key by a single bit. The stored verdict would
   * then be served for a toolchain that never produced it. Coverage is the
   * concrete path: a different test runner produces a different report, or none.
   *
   * Absence means npm, and that is an inference rather than a default: entries
   * written before this field existed came from versions with `npm` hardcoded at
   * every spawn site, so npm is what they measured with. That is why adding this
   * needs no schema bump -- no existing entry is ambiguous.
   */
  packageManager?: PackageManager;

  /**
   * A digest of the config files that decide what this reading MEANS.
   *
   * Same mechanism as `packageManager` above and for the same reason: the KEY cannot
   * carry this. A clean tree keys on the bare commit hash -- it has to, because
   * `findBaselineEntry` looks an entry up by commit hash -- so a GITIGNORED
   * `quality-gate.config.js` or `tsconfig.json` can be rewritten with `git status`
   * still reporting a clean tree, the key still landing on the same commit, and the
   * previous verdict still being served. The WIP content hash covers the dirty case;
   * this covers the clean one, which is the one an adopter is normally in.
   *
   * Checked on the VERDICT path only, not on the baseline path. Refusing a baseline
   * on a mismatch would discard every baseline on any edit to `rules.json` -- which
   * is in the digest -- so the commit that adds a ratchet would have nothing to
   * compare against, the deadlock `monotonicEvaluated` exists to avoid. The residual
   * cost is that a ratchet can difference two numbers taken under different configs;
   * see the note in `findBaselineEntry`.
   *
   * Absence cannot be given a sound meaning the way `packageManager`'s can -- there
   * is no config state it implies -- so schema 5 exists partly to guarantee every
   * entry has one, and a reader treats an absent value as a mismatch.
   */
  measurementInputsHash?: string;
}

/**
 * Whether the sonarqube numbers in a reading can be tied to a known analysis.
 *
 * `/api/measures/component` takes a component and a metric list and NOTHING else --
 * no analysis, no task, no revision -- so it answers with the LIVE measures: whatever
 * the most recently processed analysis of that project key left in the table. A second
 * publisher for the same key between `waitForSonarTask` returning SUCCESS and that read
 * replaces them, and nothing in the response says which analysis it described. The gate
 * confirmed analysis A and graded analysis B, with a `sonarqube.blocker: 0` ceiling
 * satisfied by a scan of code nobody in this run wrote. That is why the binding has to
 * travel alongside the numbers instead of being read out of them.
 *
 * `confirmed` means SonarQube itself named this analysis as the current one for the
 * project key AFTER the measures had been read. `unconfirmed` carries the reason it
 * could not be established, which is not the same as evidence against it -- a server
 * that will not discuss provenance is refused where a server that cannot is reported.
 */
export type SonarqubeAnalysisProvenance =
  | { readonly kind: 'confirmed'; readonly analysisId: string }
  | { readonly kind: 'unconfirmed'; readonly why: string };

export interface Metrics {
  coverage?: AllCoverageMetrics;
  typescript?: TypescriptMetrics;
  eslint?: EslintMetrics;
  sonarqube?: SonarqubeMetrics;

  /**
   * Whether `sonarqube` above describes the analysis this run submitted.
   *
   * Travels with the data for the same reason `measurementFailures` does: a fourth
   * parameter to `evaluateRules` would have to be threaded through six call sites and
   * the one that got missed would be a silent hole of exactly the kind this field
   * exists to close.
   *
   * ABSENT means no sonarqube reading was taken at all -- the dimension was skipped
   * (`--coverage-only`), or the read failed and there is a `MeasurementFailure`
   * instead. It never means "confirmed": a reader that treats absence as confirmation
   * re-opens the hole for every entry written before this field existed, which is why
   * `isCacheValid` and `evaluateMonotonic` both test for `kind === 'confirmed'`
   * explicitly rather than for the absence of `'unconfirmed'`.
   */
  sonarqubeProvenance?: SonarqubeAnalysisProvenance;
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
  /**
   * Optional because SonarQube reports coverage only where the scan imported a
   * coverage report, and a project that feeds it none is not a project with 0%
   * coverage. Absent is not zero: a floor on this fails as "not available", where a
   * substituted 0 would report a real measurement of nil.
   */
  coverage?: number;
  /** Optional for the same reason as {@link coverage}. */
  duplications?: number;
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

  /**
   * Rules that were configured and did not execute -- neither passed nor failed.
   *
   * A third outcome, distinct from both lists above, and it exists because the
   * second list cannot express it. This tool's thesis is that a passing check is
   * evidence only if it was capable of failing; a rule that never ran, or that ran
   * against numbers whose origin could not be established, produced no evidence
   * either way, and folding that into `status: 'pass'` with an empty `failedRules` is
   * exactly the vacuous pass everything else here is built to prevent.
   *
   * Reported rather than failed, deliberately: failing here would break every fresh
   * clone and every commit that adds a ratchet, which is a policy change adopters
   * must opt into. What it DOES buy is that the run is recorded as a narrower
   * reading -- `monotonicEvaluated: false` -- so `isCacheValid` will not serve it as
   * a verdict later. The gap converges instead of being inherited: the entry written
   * now carries the metric, so the next commit ratchets against it properly.
   *
   * REQUIRED, not optional. An optional list defaulting to empty lets a future
   * evaluation path forget to report what it skipped, which is the failure mode this
   * field exists to close.
   */
  unevaluated: UnevaluatedRule[];
}

/**
 * A rule that could not be applied AS WRITTEN, and why.
 *
 * "Configured" was accurate until `unbound-provenance` arrived, and it is now accurate
 * for every member but that one: `sonarqube.provenance` is SYNTHETIC, named for a
 * condition rather than for a line in rules.json, in the same way
 * `evaluateMeasurements` synthesises `${dimension}.measurement`. It stands for the set
 * of configured rules listed in its message.
 *
 * `rule` uses the same identity string as `FailedRule.rule` for the same rule
 * (`${direction}:${metricPath}` for monotonic), so a reader can match the two -- again
 * excepting the synthetic entry, which has no counterpart in `failedRules` by design.
 */
export interface UnevaluatedRule {
  /**
   * `monotonic`: a ratchet that compared nothing.
   *
   * `skipped-dimension`: a floor or ceiling on a dimension this run was told not to
   * measure. `--coverage-only` with a rules.json that grades `sonarqube.*` is the
   * case: the metric is absent, so the ceiling hits the silent `continue` in
   * `evaluateCeilings` and the run reports a clean pass on rules nothing checked.
   * Reported rather than failed, because the adopter asked for the skip -- but
   * recorded, so the entry cannot later be served to a run that did NOT skip it.
   *
   * `unbound-provenance`: the dimension WAS measured and the threshold WAS compared.
   * Distinct from `skipped-dimension`, whose whole claim is that there is no value:
   * here there is a value, and what is missing is the evidence that it describes this
   * commit's scan.
   */
  type: 'monotonic' | 'skipped-dimension' | 'unbound-provenance';
  rule: string;
  metricPath: string;
  /**
   * `no-baseline`: there is no baseline entry at all, so nothing was compared. The
   * CLI states this once in its own words and drops these from the list it prints;
   * every other consumer needs them, which is why they are produced (an MCP client
   * was confirmed reporting `{status:"pass", failedRules:[], unevaluated:[]}` for a
   * run where every ratchet was skipped).
   *
   * `baseline-missing`: a baseline exists and was accepted, but carries no value for
   * this metric -- a ratchet added after it was written, a renamed dimension.
   *
   * `current-missing`: this run's reading carries no value. Usually arrives with a
   * measurement failure that fails the gate on its own, but not always -- a
   * dimension whose reading is absent for a reason nothing classified loses its
   * value silently. (sonarqube was that dimension until it got a channel of its own.)
   *
   * `no-metrics`: the rule itself names no metric paths, so it compares nothing. A
   * configuration error rather than a missing reading, and reported here because the
   * consequence is identical: a configured rule that cannot fail.
   *
   * `dimension-skipped`: the run was told not to measure the dimension this rule
   * grades, so there is no value to compare against the threshold.
   *
   * `provenance-unconfirmed`: the rule was applied to numbers that could not be tied
   * to a known analysis. Reported rather than failed because refusing every adopter
   * whose server will not name the current analysis would block them over a hazard the
   * tool cannot even detect there; what it buys is that the run is not servable as a
   * verdict.
   *
   * `baseline-unbound`: the BASELINE's numbers for this metric could not be tied to a
   * known analysis, so differencing this run's number against them proves nothing. The
   * quiet half of the same problem: an unconfirmed run is only baseline-only, and a
   * later run that ratchets against it is stamped fully evaluated and cached as a
   * verdict -- so the unbound numbers become the floor without ever being graded.
   */
  reason:
    | 'no-baseline'
    | 'baseline-missing'
    | 'current-missing'
    | 'no-metrics'
    | 'dimension-skipped'
    | 'provenance-unconfirmed'
    | 'baseline-unbound';
  message: string;
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
