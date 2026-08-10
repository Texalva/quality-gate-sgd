/**
 * Istanbul Coverage Provider
 * ==========================
 * The coverage extraction, moved behind CoverageProvider.
 *
 * Coverage was the last dimension read in two unrelated places. The METRICS came
 * from `coverage-summary.json` (metrics.ts), the ISSUES from Istanbul's
 * `coverage-final.json` with a summary fallback (targets/extract.ts), and
 * nothing checked that the two agreed -- a full extraction read the reports
 * twice, so the reported 23.86% and the reported findings could legitimately
 * come from two different generations of the report. types.ts pairs metrics and
 * issues in ONE reading precisely because they are one observation of one tool;
 * this file is where coverage finally becomes that.
 *
 * The arithmetic, the iteration order and every message string below are
 * deliberately IDENTICAL to what lived in metrics.ts and targets/extract.ts,
 * including the parts that look like tidy-up candidates, because the frozen
 * apollo-client baseline compares captures with raw `JSON.stringify` equality.
 * Four things that are load-bearing and look like bugs or redundancy:
 *
 *   - `unit` comes from `total.<dim>.pct`, which istanbul rounds to 2 dp, while
 *     `union` is recomputed from the per-file entries at full precision. They
 *     are genuinely different numbers (23.86 vs 23.869346733668344) and
 *     collapsing one into the other moves the baseline.
 *   - the coverage-final walk used to label every issue `coverage.unit.*` even when
 *     the file it was reading was the LAMBDA report. That was preserved through the
 *     extraction as pre-existing and is now FIXED (#36): the walk takes the suite.
 *     The apollo baseline cannot see the difference, and that is not luck -- apollo
 *     ships no coverage-final.json, so all 279 of its findings come from the summary
 *     path, which has always been suite-aware.
 *   - `mergeCoverageReports` does not apply `shouldSkipCoverageFile`, so it
 *     counts node_modules and test files that the issue extractor drops. Also
 *     pre-existing.
 *   - the emission ORDER of issues (finals before summaries, unit before lambda,
 *     per file in `Object.entries` order, branches before functions) is compared
 *     as a raw array. Sorting "for determinism" is a rejection.
 */

import * as path from 'path';

import type { LocatedIssue } from '../targets/types.js';
import type {
  AllCoverageMetrics,
  CoverageMetrics,
  TotalCoverageMetrics,
} from '../types.js';

import { buildReportEvidence, measurementFailure, ok, readJsonReport } from './result.js';
import type {
  CoverageProvider,
  CoverageReading,
  CoverageReportRead,
  CoverageSuite,
  MeasurementContext,
  MeasurementEvidence,
  MeasurementFailure,
  MeasurementFailureKind,
  ReportAttempt,
  Result,
} from './types.js';

/** Istanbul's per-file detail report, the only source of located findings. */
const FINAL_REPORT_FILE = 'coverage-final.json';

/** The four dimensions a coverage `total` reports, in report order. */
const COVERAGE_DIMENSIONS = ['statements', 'branches', 'functions', 'lines'] as const;

type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

/**
 * What a dimension with no denominator is worth, once the report as a whole is
 * known to have measured something.
 *
 * 100 rather than 0 or absent, and it is istanbul's own convention:
 * `percent(covered, total)` returns 100 for 0/0
 * (istanbul-lib-coverage/lib/percent.js). Every branch in a file with no
 * branches is covered -- there are none to miss. 0 would blame the project for
 * code it does not have and absent silently disables ceilings and monotonic
 * rules, which `continue` on an undefined value. See extractFromTotal.
 */
const VACUOUSLY_COVERED_PCT = 100;

/**
 * The setting an adopter changes to point a suite somewhere else.
 *
 * Named in every coverage failure message: "the report is broken" is only half a
 * diagnosis if the reader cannot tell which knob produced the path.
 */
export const SUITE_SETTING: Record<CoverageSuite, string> = {
  'coverage.unit': 'QUALITY_COVERAGE_UNIT_DIR',
  'coverage.lambda': 'QUALITY_COVERAGE_LAMBDA_DIR',
};

/**
 * Where one project keeps its coverage reports.
 *
 * A factory taking these rather than a singleton reading global config, because
 * the paths are per-project and neither existing provider reaches for config of
 * its own. `lambdaDir` is optional because most projects have exactly one suite.
 */
export interface CoverageReportPaths {
  readonly unitDir: string;
  readonly lambdaDir?: string;
  readonly summaryFile: string;

  /**
   * Whether each directory above came from the PROJECT or from a default.
   *
   * These exist for one question -- is an ABSENT summary for that suite a failed
   * measurement -- and it cannot be answered from the paths alone, because
   * `config.ts` resolves both with `||` against a hardcoded default. Without the
   * distinction, a project that deliberately configured a suite is
   * indistinguishable from one that has never heard of it, and the choice collapses
   * to failing everyone on a directory they never named or letting a
   * deliberately-configured suite vanish in silence.
   *
   * Both halves of that were reproduced by adversarial review of the first version,
   * which hardcoded the answer per suite:
   *   - lambda never required: a valid unit report, `QUALITY_COVERAGE_LAMBDA_DIR`
   *     set, no such summary, and an `up` ratchet on `coverage.lambda.branches`
   *     against a 90% baseline -- no metric, no failure, `status: "pass"`, cached.
   *   - unit always required: no unit summary, a valid LAMBDA summary at 25%, and a
   *     `coverage.union.statements` floor of 20 -- the union was correctly 25 and
   *     satisfied the floor, but `report-missing` on `coverage.unit` gated it through
   *     the derivation edge and the gate went red on a project that measured fine.
   *
   * Both default to false: a caller that cannot tell gets the conservative answer
   * rather than a failure about a directory it invented.
   */
  readonly unitDirConfigured?: boolean;
  readonly lambdaDirConfigured?: boolean;
}

interface CoverageSuiteRead {
  readonly suite: CoverageSuite;
  readonly dir: string;

  /**
   * Whether the project asked for this suite by name, as opposed to inheriting a
   * default. Decides whether an absent summary for it is a failed measurement --
   * see `summaryIsRequired`.
   */
  readonly configured: boolean;
}

/**
 * The suites this configuration actually has, unit first.
 *
 * "Configured" means the project named the directory, not that a directory exists.
 * Both flags default to false, so a caller that cannot tell gets the conservative
 * answer -- an absent summary for a suite nobody named is only required when NO
 * suite produced one at all. See summaryIsRequired.
 */
function suitesOf(paths: CoverageReportPaths): readonly CoverageSuiteRead[] {
  const suites: CoverageSuiteRead[] = [
    {
      suite: 'coverage.unit',
      dir: paths.unitDir,
      configured: paths.unitDirConfigured === true,
    },
  ];
  if (paths.lambdaDir !== undefined) {
    suites.push({
      suite: 'coverage.lambda',
      dir: paths.lambdaDir,
      configured: paths.lambdaDirConfigured === true,
    });
  }
  return suites;
}

/**
 * Whether an ABSENT summary for one suite is a failed measurement.
 *
 * Three inputs, and every one of them is load-bearing:
 *
 *   `absentIsFailure` -- the caller's policy. False only for a project that has
 *     declared it has no coverage AND grades none; see `coverageAbsenceIsFailure`
 *     in cli.ts, which is where that is decided, because it depends on the rules.
 *
 *   `configured` -- whether the project named this suite. An unconfigured suite is
 *     one `config.ts` invented (see suitesOf), and failing on its absence would
 *     fail nearly every project on a directory it has never heard of.
 *
 *   `anySuiteRead` -- whether ANY suite produced a summary. This is what makes a
 *     lambda-only layout work: a project that points QUALITY_COVERAGE_LAMBDA_DIR at
 *     its real report and leaves the unit directory at the default has coverage,
 *     just not where the default looks. Requiring the unit summary unconditionally
 *     produced `report-missing` on `coverage.unit` there, and since `coverage.union`
 *     derives from `coverage.unit`, it failed a union floor that the union number
 *     satisfied -- a false red on a project whose only real suite measured fine.
 *     Found by adversarial review, which also pointed out that an existing test
 *     ("reads lambda coverage independently of unit") documents that layout as
 *     supported.
 *
 * So: a suite the project NAMED must produce a summary. A suite it did not name only
 * has to when nothing was read anywhere, and then only the UNIT suite -- the one
 * every project has by default. That last restriction is not cosmetic: without it, a
 * CORRUPT unit report (outcome 'invalid-json', so nothing was "read") armed the
 * phantom lambda suite, and one broken report produced two failures, the second
 * about a directory the project has never heard of. Caught by existing tests.
 */
function summaryIsRequired(
  suite: CoverageSuiteRead,
  absentIsFailure: boolean,
  anySuiteRead: boolean
): boolean {
  if (!absentIsFailure) return false;
  if (suite.configured) return true;
  return suite.suite === 'coverage.unit' && !anySuiteRead;
}

// =============================================================================
// Report Shapes
// =============================================================================

interface CoverageEntry {
  statements: { total: number; covered: number; pct: number };
  branches: { total: number; covered: number; pct: number };
  functions: { total: number; covered: number; pct: number };
  lines: { total: number; covered: number; pct: number };
}

interface CoverageSummaryJson {
  total?: CoverageEntry;
  [key: string]: CoverageEntry | undefined;
}

/**
 * Istanbul coverage-final.json structure.
 *
 * There is deliberately no whole-report `IstanbulCoverage` type any more: the
 * walk validates and consumes ONE entry at a time, so nothing in this file is
 * ever in a position to assert that every entry of a report it did not write
 * conforms. See asIstanbulFileCoverage.
 */
interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, IstanbulLocation>;
  fnMap: Record<string, IstanbulFunction>;
  branchMap: Record<string, IstanbulBranch>;
  s: Record<string, number>; // statement hit counts
  f: Record<string, number>; // function hit counts
  b: Record<string, number[]>; // branch hit counts per branch
}

interface IstanbulLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface IstanbulFunction {
  name: string;
  decl: IstanbulLocation;
  loc: IstanbulLocation;
}

interface IstanbulBranch {
  type: string;
  loc: IstanbulLocation;
  locations: IstanbulLocation[];
}

/**
 * Shared by the metrics validators and the issue validators, because both halves
 * of this file are reading a file this tool did not write and the interfaces
 * above are assumptions rather than guarantees.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// =============================================================================
// Metrics
// =============================================================================

/**
 * The file entries the union arithmetic would throw on.
 *
 * `mergeCoverageReports` reads `entry.<dim>.total` and `entry.<dim>.covered` for
 * ALL FOUR dimensions of EVERY file entry, and `CoverageEntry` declares those as
 * required numbers -- a declaration about a file this tool did not write.
 * MEASURED against a summary carrying a valid `total` and one file entry with
 * branches/functions/lines and no `statements` key:
 * `TypeError: Cannot read properties of undefined (reading 'total')` escaped
 * `measure()` and escaped `extractCoverageIssues`, caught by nothing --
 * `readJsonReport` validates only "is an object".
 *
 * That crash is why this exists rather than a tidier merge. The same input
 * returned 2 findings cleanly BEFORE the extraction, because the merge was
 * metrics-only code on a different code path; pairing metrics and findings in one
 * reading put a metrics-only crash on the findings path. Measured both ways
 * against the committed dist at HEAD and at this revision.
 *
 * Validated rather than wrapped in a try/catch, for the reason
 * `asIstanbulFileCoverage` records -- but there is a second reason here, specific
 * to this function: a catch around the merge cannot say WHICH entry was
 * malformed, and this list can. With all four dimensions asserted to be records
 * carrying finite numeric `total` and `covered`, every property access the merge
 * performs is accounted for, so no residual throw is left for a catch to catch,
 * and a guard that cannot be made to fire is not a guard.
 *
 * Entries the merge SKIPS are not validated, matching the merge: `total` and any
 * falsy entry are skipped before their dimensions are touched.
 * `shouldSkipCoverageFile` is deliberately NOT applied, because the merge does
 * not apply it either -- see the fourth note in the file header.
 */
function unmergeableFileEntries(
  data: CoverageSummaryJson | undefined
): readonly string[] {
  if (!data) return [];

  const isCount = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value);

  const mergeable = (entry: unknown): boolean =>
    COVERAGE_DIMENSIONS.every((dimension) => {
      const measure = isRecord(entry) ? entry[dimension] : undefined;
      return isRecord(measure) && isCount(measure.total) && isCount(measure.covered);
    });

  return Object.entries(data)
    .filter(([file, entry]) => file !== 'total' && Boolean(entry) && !mergeable(entry))
    .map(([file]) => file);
}

/**
 * Merge two coverage reports by file.
 * For files appearing in both reports, take the max coverage per file.
 * Then recalculate totals from merged file data.
 *
 * The zero-denominator arithmetic here follows extractFromTotal's rule, and it
 * matters MORE here than there: `normalizeMetrics` (trajectory.ts:75) prefers
 * `union` over `unit`, so this function's answer is the one that reaches the
 * quality score, the trajectory and the gradient. It used to return 0 for a zero
 * denominator, which is wrong in the direction that actually hurts -- a
 * branchless project was reported as 0% branch coverage, its
 * `coverage.union.branches` floor failed at 0%, and its quality score was
 * permanently depressed for code it does not contain.
 *
 * All four denominators zero -> `undefined`, not `{100,100,100,100}`. There is no
 * failure channel on this path (union is not a suite, so it has no report to
 * blame), and the suite whose report was all zeros has already produced a
 * `measured-nothing` failure of its own. Returning nothing is the same answer
 * extractFromTotal gives for that shape, and it is the one shape where a
 * fabricated 100 would be the original defect verbatim.
 */
function mergeCoverageReports(
  unitData: CoverageSummaryJson | undefined,
  lambdaData: CoverageSummaryJson | undefined
): CoverageMetrics | undefined {
  // Collect all file entries (excluding 'total')
  const mergedFiles = new Map<string, CoverageEntry>();

  // Process unit test coverage
  if (unitData) {
    for (const [file, entry] of Object.entries(unitData)) {
      if (file === 'total' || !entry) continue;
      mergedFiles.set(file, entry);
    }
  }

  // Process lambda test coverage - take max covered for overlapping files
  if (lambdaData) {
    for (const [file, entry] of Object.entries(lambdaData)) {
      if (file === 'total' || !entry) continue;

      const existing = mergedFiles.get(file);
      if (!existing) {
        mergedFiles.set(file, entry);
      } else {
        // File exists in both - take max covered for each metric
        mergedFiles.set(file, {
          statements: {
            total: existing.statements.total,
            covered: Math.max(
              existing.statements.covered,
              entry.statements.covered
            ),
            pct: 0, // Will recalculate
          },
          branches: {
            total: existing.branches.total,
            covered: Math.max(
              existing.branches.covered,
              entry.branches.covered
            ),
            pct: 0,
          },
          functions: {
            total: existing.functions.total,
            covered: Math.max(
              existing.functions.covered,
              entry.functions.covered
            ),
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
  let totalStatements = 0,
    coveredStatements = 0;
  let totalBranches = 0,
    coveredBranches = 0;
  let totalFunctions = 0,
    coveredFunctions = 0;
  let totalLines = 0,
    coveredLines = 0;

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

  if (
    totalStatements === 0 &&
    totalBranches === 0 &&
    totalFunctions === 0 &&
    totalLines === 0
  ) {
    return undefined;
  }

  return {
    statements:
      totalStatements > 0
        ? (coveredStatements / totalStatements) * 100
        : VACUOUSLY_COVERED_PCT,
    branches:
      totalBranches > 0
        ? (coveredBranches / totalBranches) * 100
        : VACUOUSLY_COVERED_PCT,
    functions:
      totalFunctions > 0
        ? (coveredFunctions / totalFunctions) * 100
        : VACUOUSLY_COVERED_PCT,
    lines: totalLines > 0 ? (coveredLines / totalLines) * 100 : VACUOUSLY_COVERED_PCT,
  };
}

/**
 * Extract coverage from a single report's total, refusing to launder a missing
 * denominator into a percentage.
 *
 * istanbul computes every `pct` as `percent(covered, total)`, which returns
 * **100.0** when total is 0 (istanbul-lib-coverage/lib/percent.js). The old
 * implementation copied `total.<dim>.pct` through verbatim, so a coverage run
 * that measured nothing arrived as 100% across the board and satisfied every
 * floor -- including the 50/50 floors that both the embedded defaults and `init`
 * generate. Reproduced from a real vitest 4 + @vitest/coverage-v8 run whose
 * `include` matched only a type-only file.
 *
 * The two zero cases are deliberately NOT treated alike, and the distinction is
 * the whole design:
 *
 *   ALL FOUR denominators zero -> `measured-nothing`, and no metrics at all.
 *     No real project reaches this: a single instrumented statement makes both
 *     `lines` and `statements` non-zero. So rejecting it outright has no
 *     false-positive cost, and it is also the shape istanbul's `blankSummary`
 *     emits for a report with no file entries (where the pcts are the STRING
 *     "Unknown" rather than 100 -- also caught here, before anything reads a
 *     pct).
 *
 *   SOME denominators zero, beside a non-zero one -> that dimension does not
 *     EXIST in this codebase, and 0 of 0 branches covered is complete coverage
 *     of the branches there are. Reported as 100, with one line on stderr.
 *     Measured: a branchless module reports
 *     `branches: {total: 0, covered: 0, pct: 100}` beside an honest
 *     `statements: {total: 3, covered: 0, pct: 0}`, and the committed synthetic
 *     subject contains two such files.
 *
 * Reporting 100 here is safe only BECAUSE of the clause above it: the dangerous
 * shape -- a report where nothing at all was instrumented -- is already refused
 * as `measured-nothing` before this line is reached, so the only 100s that get
 * out are ones sitting beside a real denominator that proves the coverage tool
 * ran over real code. That is the whole reason istanbul's 0/0 == 100% convention
 * is acceptable here and was not acceptable in the old implementation, which
 * copied it through with no such guard.
 *
 * An earlier revision DROPPED these dimensions instead, and that was worse in a
 * way that took three reviewers to see: `evaluateFloors` reports an absent
 * metric loudly, but `evaluateCeilings` and `evaluateMonotonic` both `continue`
 * on an undefined value. So dropping the dimension closed the vacuous pass for
 * floors and merely RESHAPED it for the other two rule types, from "passes as a
 * fabricated 100" into "passes as a rule that was silently skipped". It also
 * made `init` write a floor for a dimension the reader then reported as absent,
 * which is permanently unsatisfiable on a branchless codebase.
 *
 * Note that a zero denominator means the `pct` beside it is never read, which
 * also immunises this path against istanbul's non-numeric "Unknown": there is
 * nothing to parse when the answer is arithmetic.
 */
function extractFromTotal(
  data: CoverageSummaryJson | undefined,
  suite: CoverageSuite,
  evidence: MeasurementEvidence
): {
  readonly metrics: TotalCoverageMetrics | undefined;
  readonly failures: readonly MeasurementFailure[];
} {
  const fail = (kind: MeasurementFailureKind, message: string) => ({
    metrics: undefined,
    failures: [measurementFailure(kind, suite, message, evidence)],
  });

  // The READ was already classified by readFailure -- absent, unreadable,
  // invalid-json and wrong-shape all arrive here as `undefined`, and reporting
  // them again would double-count one broken report as two failed measurements.
  // This function judges the CONTENT of a summary that was read.
  if (data === undefined) return { metrics: undefined, failures: [] };

  // A summary object with no `total` at all. Was silent, and silence here was the
  // same hole as an absent report one layer up: no metrics and no failure, which a
  // ceiling or a monotonic rule on `coverage.unit.*` reads as nothing to check.
  // istanbul's json-summary reporter always writes `total`, so a report without
  // one is not a summary this tool can grade -- and `readJsonReport` cannot catch
  // it, since it validates only that the file parsed to a keyed object.
  //
  // Scoped to the suite rather than the whole reading, for the same reason
  // `unmergeableFileEntries` is scoped to the union: `coverage.union` is summed from
  // the per-file entries by `mergeCoverageReports` and does not read `total` at all,
  // so a summary with real file entries and no `total` still yields an arithmetically
  // honest union NUMBER. That number is still reported.
  //
  // But a `coverage.union.*` RULE fails anyway, and the message must not pretend
  // otherwise -- two independent reviewers flagged the earlier wording for claiming
  // the union was "unaffected" while the gate went red on a union floor the union
  // satisfied. The cause is the derivation edge in rules.ts: `coverage.union` is
  // declared as derived FROM `coverage.unit`, so a failure on the suite gates rules
  // on the union. That edge is right in general -- the union is normally computed
  // from the suites' totals -- and it is not worth a per-failure list of which
  // derived dimensions a failure does NOT invalidate, for a shape istanbul never
  // emits. So the behaviour is fail-closed on a malformed report and the message
  // says so plainly.
  if (!isRecord(data.total)) {
    return fail(
      'unparseable-output',
      `${evidence.command} has no \`total\` object (found ${JSON.stringify(data.total)}), so ` +
        `${suite}.* cannot be read from it -- that is the only thing \`total\` provides. An ` +
        `istanbul json-summary report always has one. Check that ${SUITE_SETTING[suite]} points ` +
        'at a directory written by the `json-summary` reporter, and that the file was written ' +
        'completely. A coverage.union number is still summed from the per-file entries, but a ' +
        'coverage.union rule fails with this one, because the union is derived from the suite ' +
        'that could not be read.'
    );
  }
  const total = data.total as CoverageEntry;

  // Typed loosely on purpose. CoverageEntry declares these as required numbers,
  // but the value came from JSON.parse of a file this tool did not write, and
  // the declaration is an assumption rather than a guarantee -- a `pct` of the
  // STRING "Unknown" is what istanbul actually emits for an empty summary, and
  // it type-checked its way into a `number` field for as long as this code has
  // existed.
  const readEntry = (dimension: CoverageDimension) =>
    total[dimension] as
      | { total?: unknown; covered?: unknown; pct?: unknown }
      | undefined;

  const denominators = COVERAGE_DIMENSIONS.map((dimension) => {
    const entry = readEntry(dimension);
    return { dimension, denominator: entry?.total, covered: entry?.covered };
  });

  // `covered` is read for one reason only: to check it against `total`. Nothing
  // downstream needs the count -- the percentages come from `pct` -- but without
  // this check the vacuous-100 rule below is exploitable. `{total: 0, covered: 5}`
  // beside any positive denominator walks past the all-zero `measured-nothing`
  // clause and is reported as 100%, and that is NOT the branchless codebase the
  // rule exists for; it is an internally inconsistent measurement satisfying a
  // floor with no failure recorded. The all-zero guard makes the ALL-zero case
  // safe, not every partially-zero one.
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;

  const malformed = denominators.filter(
    (d) => !isCount(d.denominator) || !isCount(d.covered)
  );
  if (malformed.length > 0) {
    const describe = (d: (typeof denominators)[number]) =>
      `total.${d.dimension} = {total: ${JSON.stringify(d.denominator)}, ` +
      `covered: ${JSON.stringify(d.covered)}}`;
    return fail(
      'unparseable-output',
      `${evidence.command} does not report a whole non-negative count for ` +
        `${malformed.map(describe).join('; ')}, so it cannot be read as a coverage report. ` +
        'Check that the file is an istanbul coverage summary and was written completely.'
    );
  }

  // Non-negative integers, so `covered <= total` also gives `covered === 0`
  // whenever `total === 0` -- the shape the vacuous-100 rule depends on.
  const inconsistent = denominators.filter(
    (d) => (d.covered as number) > (d.denominator as number)
  );
  if (inconsistent.length > 0) {
    const describe = (d: (typeof denominators)[number]) =>
      `${String(d.covered)} of ${String(d.denominator)} ${d.dimension}`;
    return fail(
      'unparseable-output',
      `${evidence.command} reports more covered than total: ` +
        `${inconsistent.map(describe).join('; ')}. A report that contradicts itself cannot be ` +
        'graded -- delete it and re-run the coverage tool.'
    );
  }

  const measured = denominators.filter((d) => (d.denominator as number) > 0);

  if (measured.length === 0) {
    const fileEntries = Object.keys(data).filter((key) => key !== 'total').length;
    return fail(
      'measured-nothing',
      `${evidence.command} reports 0 statements, 0 branches, 0 functions and 0 lines across ` +
        `${fileEntries} file entr${fileEntries === 1 ? 'y' : 'ies'}, so nothing was actually ` +
        'covered OR uncovered. istanbul renders 0/0 as 100%, which would satisfy every coverage ' +
        'floor. Check that the coverage tool\'s `include`/`exclude` patterns match your source ' +
        `files and that \`reportsDirectory\` is the directory this gate reads (${SUITE_SETTING[suite]}).`
    );
  }

  // Built in COVERAGE_DIMENSIONS order, in ONE pass, because the key order of
  // this object is compared by the frozen apollo baseline with raw
  // `JSON.stringify` equality. Two loops -- measured dimensions then vacuous
  // ones -- would reorder `{statements, branches, functions, lines}` on any
  // project that has a zero denominator anywhere.
  const metrics: Record<string, number> = {};
  for (const { dimension, denominator } of denominators) {
    if ((denominator as number) === 0) {
      metrics[dimension] = VACUOUSLY_COVERED_PCT;
      continue;
    }

    const pct = readEntry(dimension)?.pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) {
      return fail(
        'unparseable-output',
        `${evidence.command} reports total.${dimension}.pct as ` +
          `${JSON.stringify(pct)} over ${String(denominator)} ${dimension}, which is not a ` +
          'percentage. Check that the file is an istanbul coverage summary and was written ' +
          'completely.'
      );
    }
    metrics[dimension] = pct;
  }

  const vacuous = denominators
    .filter((d) => d.denominator === 0)
    .map((d) => d.dimension);

  if (vacuous.length > 0) {
    // Said out loud because 100% is a number an adopter would otherwise take as
    // evidence of a test suite. It is deliberately NOT a MeasurementFailure: a
    // codebase with no conditionals in it is not broken, and failing it would be
    // the false positive the all-zero clause above exists to keep separate.
    console.error(
      `Warning: ${evidence.command} has no ${vacuous.join('/')} to measure ` +
        `(denominator 0), so ${vacuous.map((d) => `${suite}.${d}`).join(', ')} ` +
        `is reported as ${VACUOUSLY_COVERED_PCT}% -- every one of the zero ${vacuous.join('/')} ` +
        'in this codebase is covered. The other dimensions in the same report have real ' +
        'denominators, so the coverage tool did run over real code.'
    );
  }

  return { metrics: metrics as TotalCoverageMetrics, failures: [] };
}

// =============================================================================
// Issues
// =============================================================================

function shouldSkipCoverageFile(filePath: string): boolean {
  return (
    filePath.includes('node_modules') ||
    filePath.includes('.test.') ||
    filePath.includes('.spec.')
  );
}

/**
 * A location the walk can read without throwing.
 *
 * Deliberately does NOT require `line`/`column` to be numbers, because REAL
 * istanbul output does not supply them. Measured against the committed synthetic
 * subject's own coverage-final.json:
 *
 *     "end": { "line": 7, "column": null }
 *     "locations": [ {...}, { "start": {}, "end": {} } ]
 *
 * `column: null` and wholly EMPTY start/end objects are both normal -- istanbul
 * emits them for an implicit else branch. The previous code read
 * `loc.start.line` straight through, so those became `line: undefined` and
 * `endColumn: null` on the issue, and the frozen findings contain exactly that.
 * A validator demanding numbers here rejected the real report and silently
 * downgraded 12 located findings to 6 file-level ones -- caught by comparing
 * captures, not by any test.
 *
 * So the contract is precisely "property access will not throw", which is the
 * only thing the caller needs and the only thing that can be asserted about a
 * file this tool did not write.
 */
const isReadableLocation = (value: unknown): boolean =>
  isRecord(value) && isRecord(value.start) && isRecord(value.end);

/**
 * Validates ONE file entry of the detail report before the walk touches it.
 *
 * Validated rather than wrapped in a try/catch, which is the same lesson
 * eslint.ts records: parse and iteration used to share ONE try/catch here, so a
 * well-formed-JSON-but-wrong-shape payload landed on the failure path by
 * accident. Splitting the parse out (readJsonReport) without adding this let a
 * TypeError escape `measure()` -- `Object.values(fileCoverage.branchMap)` on an
 * undefined branchMap throws "Cannot convert undefined or null to object", which
 * is what happens when a coverage-SUMMARY is found at the detail report's path.
 *
 * PER ENTRY, and that is the correction rather than an implementation detail. An
 * earlier revision validated the whole report and returned null for the first bad
 * entry, which discarded the findings of every GOOD file with it -- and because
 * the summary fallback fires on `issues.length === 0`, emptying `issues` then
 * substituted coarse file-level findings for precise located ones. That is the
 * silent downgrade the note on `isReadableLocation` above was written to prevent,
 * reappearing one level up. MEASURED: a report with one good file (3 located
 * findings) and one lacking `branchMap` returned 2 unlocated summary findings; it
 * now returns the 3 located ones and records the rejected entry.
 *
 * Files the walk SKIPS are not validated, matching the walk: `continue` on
 * node_modules and test files happens before their branchMap is touched, so a
 * dependency with an odd entry cannot invalidate anything.
 */
function asIstanbulFileCoverage(value: unknown): IstanbulFileCoverage | null {
  if (!isRecord(value)) return null;

  const { branchMap, fnMap, b, f } = value;
  if (!isRecord(branchMap) || !isRecord(fnMap) || !isRecord(b) || !isRecord(f)) return null;

  for (const branch of Object.values(branchMap)) {
    if (!isRecord(branch)) return null;
    if (!Array.isArray(branch.locations)) return null;
    if (!branch.locations.every(isReadableLocation)) return null;
  }

  for (const fn of Object.values(fnMap)) {
    if (!isRecord(fn) || !isReadableLocation(fn.loc)) return null;
  }

  return value as unknown as IstanbulFileCoverage;
}

/**
 * Validates a summary report's shape for FINDING extraction.
 *
 * Deliberately separate from what the metrics need: the metrics read `total`
 * alone and `extractFromTotal` validates that itself, while finding extraction
 * touches `branches`/`functions` on every file entry. Rejecting the whole report
 * rather than the offending entry mirrors the previous behaviour exactly -- parse
 * and loop shared one try/catch, so the first malformed entry discarded every
 * finding and logged a warning.
 *
 * `pct` is required to be a number ONLY when the extractor would actually format
 * it, because `.toFixed(1)` is reached solely for a dimension with something
 * uncovered. Requiring it unconditionally would reject a report whose fully
 * covered dimensions carry istanbul's non-numeric "Unknown" -- a shape this code
 * has no measurement of, and after the location mistake above, not one to guess
 * about.
 */
function asCoverageSummaryForIssues(parsed: unknown): CoverageSummaryJson | null {
  if (!isRecord(parsed)) return null;

  for (const [filePath, entry] of Object.entries(parsed)) {
    if (filePath === 'total' || entry === null || entry === undefined) continue;
    if (shouldSkipCoverageFile(filePath)) continue;
    if (!isRecord(entry)) return null;

    for (const dimension of ['branches', 'functions'] as const) {
      const measure = entry[dimension];
      if (!isRecord(measure)) return null;

      const total = typeof measure.total === 'number' ? measure.total : 0;
      const covered = typeof measure.covered === 'number' ? measure.covered : 0;
      const willFormatPct = total > 0 && Math.max(total - covered, 0) > 0;
      if (willFormatPct && typeof measure.pct !== 'number') return null;
    }
  }

  return parsed as CoverageSummaryJson;
}

/**
 * File-level coverage findings from a summary report.
 *
 * The coarser of the two sources: a summary has no locations, so each finding
 * names a file and a proportion rather than a line. Used when the detail report
 * is absent -- which is the apollo-client shape, and therefore the source of the
 * frozen baseline's 279 findings.
 */
function extractCoverageIssuesFromSummary(
  data: CoverageSummaryJson,
  dimensionPrefix: CoverageSuite
): LocatedIssue[] {
  const issues: LocatedIssue[] = [];

  for (const [filePath, entry] of Object.entries(data)) {
    if (filePath === 'total' || !entry) continue;
    if (shouldSkipCoverageFile(filePath)) continue;

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

/**
 * Uncovered branches and functions from Istanbul's detail report.
 *
 * Each uncovered branch becomes a LocatedIssue with estimated coverage impact.
 *
 * Collection is INCREMENTAL: an entry that fails validation is recorded in
 * `rejected` and the walk continues, so one malformed file costs its own findings
 * and no others. See `asIstanbulFileCoverage` for the measurement that made this
 * necessary. The emission order for a fully valid report is unchanged -- per file
 * in `Object.entries` order, branches before functions -- which the frozen
 * baseline compares as a raw array.
 */
function extractCoverageIssuesFromFinal(
  data: Record<string, unknown>,
  // The suite this report belongs to. Was not a parameter, and every finding was
  // labelled `coverage.unit.*` no matter which report it came from -- so fix advice
  // for a lambda-suite finding claimed that covering it would move the UNIT
  // dimension. `extractCoverageIssuesFromSummary` has always taken this; only the
  // detail walk hardcoded it, which is why the frozen apollo baseline cannot see the
  // difference (apollo has no coverage-final.json, so all 279 of its findings come
  // from the summary path).
  suite: CoverageSuite
): {
  readonly issues: LocatedIssue[];
  readonly rejected: readonly string[];
} {
  const issues: LocatedIssue[] = [];
  const rejected: string[] = [];

  for (const [filePath, value] of Object.entries(data)) {
    // Skip node_modules and test files
    if (shouldSkipCoverageFile(filePath)) {
      continue;
    }

    const fileCoverage = asIstanbulFileCoverage(value);
    if (fileCoverage === null) {
      rejected.push(filePath);
      continue;
    }

    // Count total branches for this file to estimate per-branch impact
    const totalBranches = Object.values(fileCoverage.branchMap).reduce(
      (sum, branch) => sum + branch.locations.length,
      0
    );

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
            dimension: `${suite}.branches`,
            code: `branch-${branch.type}`,
            impact: {
              dimension: `${suite}.branches`,
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
          dimension: `${suite}.functions`,
          code: 'uncovered-function',
          impact: {
            dimension: `${suite}.functions`,
            delta: 0.5, // Rough estimate: covering a function helps
            direction: 'higher-better',
          },
          message: `Uncovered function: ${fn.name || 'anonymous'}`,
          context: `Function at line ${fn.loc.start.line}`,
        });
      }
    }
  }

  return { issues, rejected };
}

// =============================================================================
// Provider
// =============================================================================

/**
 * What the caller wants out of the reading.
 *
 * `issues: 'skip'` exists because the METRICS path does not use them and paying
 * for them there is not free. `coverage-final.json` is the largest artifact this
 * tool touches -- one entry per source file, with a statementMap, an fnMap and a
 * branchMap each -- and before this extraction the metrics path never opened it
 * at all. Collecting issues for a caller that discards them means reading,
 * parsing, validating and walking BOTH detail reports and holding the complete
 * LocatedIssue array, so a full extraction (metrics, then findings) does it twice
 * and peaks at two copies. On a monorepo with a 150 MB detail report that is an
 * out-of-memory kill rather than a slow run.
 *
 * A provider-construction option rather than a field on MeasurementContext: the
 * context is shared by every provider and none of the others has a second
 * artifact to decline, so an ignored flag there would be a budget nothing
 * enforces. Each call site already builds its own provider.
 */
export interface CoverageProviderOptions {
  /** 'collect' (default) walks the detail reports; 'skip' does not open them. */
  readonly issues?: 'collect' | 'skip';

  /**
   * What an absent coverage summary means. 'fail' (default) reports it as
   * `report-missing`; 'ignore' restores the silence, for a project that
   * deliberately has no coverage report at all.
   *
   * Defaulting to 'fail' is the safe direction: a caller that forgets this option
   * gets the loud reading, and the quiet one has to be asked for. See readFailure
   * for what the silence cost.
   */
  readonly absentReport?: 'fail' | 'ignore';
}

export function createIstanbulCoverageProvider(
  paths: CoverageReportPaths,
  options: CoverageProviderOptions = {}
): CoverageProvider {
  const wantIssues = (options.issues ?? 'collect') === 'collect';
  const absentIsFailure = (options.absentReport ?? 'fail') === 'fail';

  return {
    name: 'istanbul',
    dimension: 'coverage',

    measure(context: MeasurementContext): Result<CoverageReading, MeasurementFailure> {
      const startedAt = Date.now();
      const suites = suitesOf(paths);

      // Read order matters and is asserted by existing tests that count
      // existsSync calls: detail reports first, in suite order, then summaries.
      // Each candidate path is read AT MOST ONCE, which is the point -- the
      // previous code read the summaries again inside the issue fallback, so the
      // metrics and the findings could come from two different reads of the same
      // file.
      //
      // Not even STATTED when issues are not wanted. An attempt is a record of
      // what was looked at, and recording one for a path this run deliberately
      // did not open would be evidence about nothing -- so `reads` carries the
      // summaries alone in that mode, which is all the graded numbers ever came
      // from.
      const finals = wantIssues
        ? suites.map(({ suite, dir }) => ({
            suite,
            ...readJsonReport(path.join(context.projectRoot, dir, FINAL_REPORT_FILE)),
          }))
        : [];
      const summaryReads = suites.map((suite) => ({
        suite,
        ...readJsonReport(path.join(context.projectRoot, suite.dir, paths.summaryFile)),
      }));
      const elapsedMs = Date.now() - startedAt;

      // Decided AFTER every summary has been read, because whether an
      // unconfigured suite's absence matters depends on whether ANOTHER suite
      // produced one. See summaryIsRequired.
      const anySuiteRead = summaryReads.some((r) => r.attempt.outcome === 'read');
      const summaries = summaryReads.map((r) => ({
        suite: r.suite.suite,
        attempt: r.attempt,
        data: r.data,
        summaryRequired: summaryIsRequired(r.suite, absentIsFailure, anySuiteRead),
      }));

      const evidenceFor = (attempt: ReportAttempt): MeasurementEvidence =>
        buildReportEvidence(`read ${attempt.path}`, elapsedMs, [attempt]);

      // What a read that did not produce a summary is worth.
      //
      // A report that EXISTS but cannot be read is a failure: `catch { /* Skip if
      // invalid */ }` made a corrupt report and an unmeasured project the same
      // thing, and the corrupt one then passed any ruleset without a coverage
      // floor.
      //
      // An ABSENT summary is a failure too, for the suite that requires one. It
      // used to be silent, and silence was not neutral: `evaluateFloors` is the
      // only evaluator that reports a missing metric, so a project whose only
      // coverage rule was a ceiling or a ratchet lost coverage enforcement
      // entirely and still cached the pass as fully earned. `report-missing` is
      // exactly this shape -- the run succeeded and wrote no artifact -- and until
      // now was the one declared kind nothing emitted. Rule scoping keeps the
      // false-positive cost off projects that do not gate coverage: they get the
      // ungated advisory rather than a failed gate, and can silence it for good
      // with QUALITY_COVERAGE_REQUIRED=false.
      //
      // Called for the SUMMARIES only, which is why absence can be graded here at
      // all. An absent detail report is genuinely not a fault -- apollo-client has
      // a summary and no coverage-final.json -- and it is a documented fallback
      // rather than a missing measurement.
      const readFailure = (
        attempt: ReportAttempt,
        suite: CoverageSuite,
        summaryRequired: boolean
      ): readonly MeasurementFailure[] => {
        if (attempt.outcome === 'read') return [];

        if (attempt.outcome === 'absent') {
          if (!summaryRequired) return [];
          return [
            measurementFailure(
              'report-missing',
              suite,
              `${attempt.path} does not exist, so no coverage was measured. A ceiling or ` +
                'monotonic rule reads a missing coverage number as nothing to check, so this ' +
                'would otherwise pass silently. Run the script that writes coverage (the one ' +
                'that passes --coverage) before the gate and list it in `requiredScripts`, or ' +
                `point ${SUITE_SETTING[suite]} at the directory your coverage tool writes. If ` +
                'this project has no coverage at all and never will, set ' +
                'QUALITY_COVERAGE_REQUIRED=false to say so.',
              evidenceFor(attempt)
            ),
          ];
        }

        const detail =
          attempt.outcome === 'invalid-json'
            ? `contains ${String(attempt.bytesRead)} bytes that are not valid JSON`
            : attempt.outcome === 'wrong-shape'
              ? 'contains valid JSON that is not a coverage summary object'
              : `could not be read (${attempt.errorCode ?? 'unknown error'})`;

        return [
          measurementFailure(
            'unparseable-output',
            suite,
            `${attempt.path} ${detail}, so no coverage number can be derived from it. Delete it ` +
              `and re-run the coverage tool, or point ${SUITE_SETTING[suite]} at the directory ` +
              'that holds the real report.',
            evidenceFor(attempt)
          ),
        ];
      };

      // --- metrics, from the summaries ---------------------------------------
      const summaryData = new Map<CoverageSuite, CoverageSummaryJson | undefined>(
        summaries.map((s) => [s.suite, s.data as CoverageSummaryJson | undefined])
      );

      const perSuite = summaries.map((s) => ({
        suite: s.suite,
        ...extractFromTotal(
          s.data as CoverageSummaryJson | undefined,
          s.suite,
          evidenceFor(s.attempt)
        ),
      }));

      const unitData = summaryData.get('coverage.unit');
      const lambdaData = summaryData.get('coverage.lambda');

      // A file entry the union arithmetic cannot add up costs the UNION and
      // nothing else: `unit` and `lambda` come from `total`, which
      // `extractFromTotal` validates on its own, so refusing the whole reading
      // would discard two good numbers over one bad entry.
      //
      // Refused rather than merged around. Skipping the entry would quietly lower
      // every denominator in the union and hand back a number that looks like a
      // measurement of the whole project -- the vacuous pass in its
      // most-plausible-looking form. `normalizeMetrics` falls back from `union` to
      // `unit`, so the trajectory and the score still have an honest reading to
      // use.
      //
      // The dimension is `coverage.union`, not the suite: the suite's own numbers
      // WERE measured and are reported, and naming it here would claim otherwise.
      // The message still names the report and the setting that produced its path,
      // because that is the file to fix.
      const unmergeableFailures = summaries.flatMap((s) => {
        const bad = unmergeableFileEntries(s.data as CoverageSummaryJson | undefined);
        if (bad.length === 0) return [];

        const named = bad.slice(0, 3).join(', ');
        const rest = bad.length > 3 ? `, and ${bad.length - 3} more` : '';
        return [
          measurementFailure(
            'unparseable-output',
            'coverage.union',
            `${s.attempt.path} has ${bad.length} file entr${bad.length === 1 ? 'y' : 'ies'} ` +
              `whose per-dimension counts cannot be read (${named}${rest}), so coverage.union ` +
              `cannot be summed from it. Each entry must carry numeric \`total\` and \`covered\` ` +
              `for all of ${COVERAGE_DIMENSIONS.join(', ')}. ${s.suite}'s own numbers come from ` +
              `\`total\` and are unaffected. Delete the report and re-run the coverage tool, or ` +
              `point ${SUITE_SETTING[s.suite]} at the directory that holds the real report.`,
            evidenceFor(s.attempt)
          ),
        ];
      });

      // --- issues, from the detail reports, falling back to the summaries -----
      const issues: LocatedIssue[] = [];
      const unexpectedShapes = new Set<string>();
      let foundCoverageFinal = false;

      for (const final of finals) {
        // Set on EXISTENCE rather than on a successful parse, preserving the
        // original: a detail report that is present but corrupt still means the
        // summary fallback below is a fallback, not the primary source.
        if (final.attempt.existed) foundCoverageFinal = true;
        if (final.attempt.outcome !== 'read') continue;

        // `readJsonReport` already refused anything that is not a keyed object
        // (outcome 'wrong-shape'), so this is the belt on a guarantee rather than
        // a case that has been observed. It stays because the walk below indexes
        // by key and the alternative is a claim about a file this tool did not
        // write.
        if (!isRecord(final.data)) {
          unexpectedShapes.add(final.attempt.path);
          continue;
        }

        // Findings from the entries that ARE readable are kept even when some
        // entry is not, and the report is flagged rather than discarded. See
        // asIstanbulFileCoverage for what discarding cost.
        const walked = extractCoverageIssuesFromFinal(final.data, final.suite);
        if (walked.rejected.length > 0) unexpectedShapes.add(final.attempt.path);

        // A loop rather than `issues.push(...walked.issues)`, and the difference
        // is not stylistic. A spread passes every element as a separate ARGUMENT,
        // so it is bounded by the call-stack size, not by memory. MEASURED on Node
        // 26.5.1 against a generated 96 MB coverage-final.json (20 000 files x 12
        // branches x 12 functions = 480 000 findings): the spread died with
        // `RangeError: Maximum call stack size exceeded` from inside `measure()`,
        // which the caller would report as a coverage read that found nothing.
        //
        // Not a hazard before this extraction: the walk used to push each finding
        // straight into the shared array, and the spread appeared only when the
        // walk was made a function that returns one. It is exactly the shape of
        // report -- a monorepo detail report -- that `issues: 'skip'` above exists
        // for, so both halves of that problem are on this path.
        for (const issue of walked.issues) issues.push(issue);
      }

      // Fallback: use coverage-summary.json when coverage-final.json is missing.
      //
      // Fires on `issues.length === 0`, which includes a detail report that
      // parsed PERFECTLY and simply had nothing uncovered -- pinned by an
      // existing test, and the reason this is not `if (!foundCoverageFinal)`.
      if (wantIssues && issues.length === 0) {
        for (const summary of summaries) {
          if (summary.attempt.outcome !== 'read') continue;

          const data = asCoverageSummaryForIssues(summary.data);
          if (data === null) {
            unexpectedShapes.add(summary.attempt.path);
            continue;
          }

          const summaryIssues = extractCoverageIssuesFromSummary(data, summary.suite);
          if (summaryIssues.length > 0 && foundCoverageFinal) {
            console.error(
              `Warning: Using ${paths.summaryFile} fallback for ${summary.suite} coverage`
            );
          }
          issues.push(...summaryIssues);
        }
      }

      const reads: CoverageReportRead[] = [
        ...finals.map((f) => ({
          suite: f.suite,
          kind: 'final' as const,
          attempt: f.attempt,
          shape: unexpectedShapes.has(f.attempt.path)
            ? ('unexpected' as const)
            : ('expected' as const),
        })),
        ...summaries.map((s) => ({
          suite: s.suite,
          kind: 'summary' as const,
          attempt: s.attempt,
          shape: unexpectedShapes.has(s.attempt.path)
            ? ('unexpected' as const)
            : ('expected' as const),
        })),
      ];

      const metrics: AllCoverageMetrics = {
        // Key order is load-bearing: the refactor harness compares capture
        // sections with raw `JSON.stringify` equality and does not sort keys, so
        // `{unit, union}` and `{union, unit}` are a rejection with no numeric
        // change at all.
        lambda: perSuite.find((s) => s.suite === 'coverage.lambda')?.metrics,
        unit: perSuite.find((s) => s.suite === 'coverage.unit')?.metrics,
        union:
          unmergeableFailures.length > 0
            ? undefined
            : mergeCoverageReports(unitData, lambdaData),
      };

      // Always `ok`. Every way this measurement can fail is attributable to ONE
      // suite's report, and is reported as such in `failures` -- a broken
      // coverage-lambda summary must not discard a perfectly good coverage/ one.
      // `err` is reserved by the MeasurementProvider contract for "the
      // measurement could not be carried out at all", which for a reader of
      // files has no instance: it either reads them or records that they are
      // absent. Do not invent one to make the union look busier.
      return ok({
        metrics,
        issues,
        // SUMMARY read failures only, not the detail reports'.
        //
        // The gate's NUMBERS come from the summaries, so a corrupt summary is a
        // measurement that failed. A corrupt coverage-final.json degrades the
        // located findings -- the fix ADVICE -- while the verdict stays sound on
        // the summary, so promoting it to a gate failure would be a behaviour
        // change this extraction has no business making. Its attempt is in
        // `reads`, and targets/extract.ts warns about it there, exactly as
        // before. Closing that hole properly means giving ExtractedIssues a
        // failure channel of its own, which is its own step.
        failures: [
          ...summaries.flatMap((s) => readFailure(s.attempt, s.suite, s.summaryRequired)),
          ...perSuite.flatMap((s) => s.failures),
          // Appended last so the existing per-suite ordering that tests assert on
          // is untouched.
          ...unmergeableFailures,
        ],
        reads,
      });
    },
  };
}
