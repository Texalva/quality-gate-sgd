/**
 * Provider Types
 * ==============
 * The boundary between "the gate wants a reading" and "some particular tool
 * produces one".
 *
 * The tool currently has its toolchain welded in: `spawnSync('npx', ['eslint',
 * ...])` appears literally in metrics.ts and again in targets/extract.ts. No
 * configuration can make that run biome. These types are what the extraction
 * moves behind.
 *
 * The load-bearing decision here is `Result<Reading, MeasurementFailure>`.
 * Today every extraction path collapses failure into absence:
 *
 *     const output = result.stdout || '[]';   // crash, timeout, truncation
 *     const results = JSON.parse(output);     // ...parses, yields zero findings
 *
 * A linter that never ran reports `{errors: 0}`, which satisfies an
 * `eslint.errors: 0` ceiling. That has bitten this repo twice: once when a
 * missing gitignored file crashed eslint, and once when output crossed
 * spawnSync's 1 MiB buffer and was silently truncated. Making the return type
 * a union forces every implementation to say which of the two happened, and
 * makes "measured nothing" unrepresentable as an error.
 */

import type { RunnerSelection, TypecheckScriptSelection } from '../runner.js';
import type { IssueSource, LocatedIssue } from '../targets/types.js';
import type {
  AllCoverageMetrics,
  EslintMetrics,
  TypescriptMetrics,
} from '../types.js';

// =============================================================================
// Result
// =============================================================================

/**
 * Errors as values. Deliberately not an exception: a thrown error can be
 * swallowed by a `catch` that returns a default, which is precisely the bug
 * this type exists to make impossible.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// =============================================================================
// Failure
// =============================================================================

/**
 * How a measurement can fail. Every member but one corresponds to a failure actually
 * observed against a real subject, not a hypothetical; `wrong-subject` is the
 * exception and says so in its own paragraph:
 *
 * - `tool-missing`       apollo-client ships a `typecheck` script; the tool
 *                        shells `npm run type-check` and got nothing back. Also
 *                        emitted for a project with an eslint config and no
 *                        eslint installed, where `npx eslint --format json src/`
 *                        exited 0 with a complete errorCount-0 report from a
 *                        registry-supplied v10.8.1 -- see providers/eslint.ts.
 * - `crashed`            eslint died on a gitignored `canonical-references.json`
 *                        and the tool reported 0 findings.
 * - `timed-out`          the spawn budget elapsed and the child was killed.
 * - `output-truncated`   1038 findings exceeded spawnSync's 1 MiB default;
 *                        stdout came back at exactly 1048576 bytes, unparseable.
 * - `unparseable-output` output arrived but did not match the expected shape.
 * - `report-missing`     the run succeeded but wrote no artifact to read
 *                        (vitest emits no coverage at all when tests fail).
 * - `measured-nothing`   the artifact exists and parses, but every denominator
 *                        in it is zero. istanbul's `percent(covered, total)`
 *                        returns 100.0 when total is 0
 *                        (istanbul-lib-coverage/lib/percent.js), so a coverage
 *                        report that measured nothing renders as 100% and
 *                        satisfies every floor. Observed directly: vitest 4 +
 *                        @vitest/coverage-v8 with `include` matching only a
 *                        type-only file emitted
 *                        `total.lines = {total: 0, covered: 0, pct: 100}` for
 *                        all four dimensions, and passed floors of 50.
 * They are kept distinct because they need different responses: a missing tool
 * is a configuration problem, truncation is a budget problem, a crash is a
 * subject problem, and measuring nothing is a coverage
 * `include`/`reportsDirectory` problem. Collapsing them is how the original
 * defect stayed invisible.
 *
 * `stale-report` is the one kind that says a report on DISK describes something
 * other than the code being graded, and it is worth stating exactly what it is not,
 * because a kind meaning almost this was added here and removed. That one compared
 * the summary's mtime against the newest file under `codePathspecs`: inert on any
 * project without a literal top-level `src/`, and false-failing mtime-preserving
 * archive restores (`actions/cache`), branch switches that rewrite identical
 * content, clock skew, and any bulk tree write longer than its tolerance -- a
 * constant sized from file COUNT when the real quantity is wall time. A declared
 * kind nothing can honestly emit is a claim the tool cannot support, so the kind
 * went with the rule.
 *
 * What replaced it (coverage-provenance.ts) is honest where that was not, and the
 * difference is not one of degree: nothing is inferred from a timestamp. A sidecar
 * beside the report records the commit the report was produced at plus a digest of
 * the code against that commit, and verification RECOMPUTES that digest against the
 * RECORDED commit and compares it exactly. There is no tolerance constant, no
 * cross-clock arithmetic and no comparison against another file's age. Absence of a
 * sidecar is not this kind -- it is an advisory that the origin is unestablished --
 * so the kind is emitted only when the tool has positive evidence. MEASURED, on the
 * two shapes that killed the mtime rule: stamping at a clean commit and then editing
 * README.md, committing that edit, reverting a code change so content is identical,
 * or switching to a branch with identical content all move the cache key and all
 * recompute to the SAME digest -- verified, no failure. And `chmod +x src/index.ts`
 * followed by a commit moves the digest while `git diff --raw` reports identical blob
 * shas (`:100644 100755 cb0ff5c cb0ff5c M`), which is classified as no content change
 * rather than as a stale report.
 *
 * `wrong-subject` is NOT that kind returning under a new name, and the difference is
 * worth stating because one of its two emitters does compare a SonarQube analysis's git
 * revision against the commit being graded. That comparison is exact -- two 40-character
 * shas, equal or not -- so none of the three reasons the mtime rule was cut applies to
 * it: there is no tolerance window to tune, an mtime-preserving archive restore or a
 * branch switch does not change a commit hash, and clock skew cannot reach it. It is also
 * not inert, because the revision comes from the server's own response rather than from a
 * directory layout that may not exist. `stale-report` reaches the same standard by the
 * same route -- an exact comparison of recorded identities -- one layer down, about a
 * file rather than about a server's answer. Neither claims a report is OLDER than the
 * code; both claim it describes a DIFFERENT one, which is a statement a comparison can
 * actually support.
 *
 * `report-missing` was for a long time declared and never emitted. It is now
 * emitted for an absent coverage summary on the suite that requires one
 * (providers/coverage.ts readFailure), which is precisely "the run succeeded and
 * wrote nothing" and makes no claim about a report that exists. A project that
 * genuinely has no coverage says so with QUALITY_COVERAGE_REQUIRED=false; every
 * other project used to lose its coverage ceilings and ratchets in silence,
 * because `evaluateFloors` is the only evaluator that reports a missing metric.
 */
export type MeasurementFailureKind =
  | 'tool-missing'
  | 'crashed'
  | 'timed-out'
  | 'output-truncated'
  | 'unparseable-output'
  | 'report-missing'
  | 'measured-nothing'
  /**
   * The report parsed and yielded a number, and a sidecar beside it records that the
   * number was produced from a DIFFERENT state of the code than the one being graded.
   *
   * Its own kind because the response it calls for is unlike every neighbour's: the
   * measurement machinery is fine, the file is fine, the number is arithmetically
   * honest -- what is wrong is which code it describes, and the remedy is to
   * regenerate or re-stamp the report rather than to fix a tool.
   *
   * It is also the ONLY kind that arrives alongside a value for its dimension, which
   * is why `evaluateMeasurements` and the `score`/`suggest` surfaces word it
   * differently: "could not be measured" is false here, and printing it over a
   * dimension the same output reports a percentage for would be exactly the
   * confidently-wrong sentence this module exists to prevent.
   *
   * Emitted only from positive evidence -- a sidecar naming a commit, and a
   * recomputed digest against that commit that differs, with a tracked file's content
   * or an untracked source file to point at. Never from a timestamp, never against
   * another file's mtime, never against another machine's clock, and with no tolerance
   * constant. A report nobody stamped is not this; it is an advisory that says so.
   */
  | 'stale-report'
  /**
   * The report parsed and yielded a number, and NOTHING establishes which state of the
   * code that number describes -- no sidecar, or one that cannot be used.
   *
   * The counterpart of `stale-report` and its opposite in epistemic character: that one
   * is a definite claim built from positive evidence, this one is the absence of
   * evidence said out loud. They are separate kinds because the remedy differs -- a
   * stale report has to be regenerated, an unvouched one only has to be stamped, and a
   * message that conflates them sends an adopter to rerun tests that were fine.
   *
   * Emitted only when `config.coverage.provenanceRequired`. That gate is a POLICY
   * decision recorded in config.ts, not a measurement one: the tool's confidence in
   * these numbers is identical in both modes, and what changes is whether that
   * confidence is enough to ship on. In `optional` mode the same verdict travels as an
   * `UnevaluatedRule` advisory instead, and the run is still refused as a cacheable
   * verdict either way.
   *
   * Like `stale-report`, and unlike every other kind, it arrives ALONGSIDE a value for
   * its dimension -- so `describeUnmeasured` reports it as `numberReported` and the
   * `score`/`suggest` surfaces must not print "could not be measured" over it.
   */
  | 'provenance-unverified'
  /**
   * A script or extractor rewrote the code WHILE its coverage was being measured, so
   * the report describes one generation of the source and the tree now holds another.
   *
   * Positive evidence, which is why it is a failure in both provenance modes and sits
   * beside `stale-report` rather than `provenance-unverified`: the gate did not fail to
   * find out which code the report describes, it found out that the answer changed
   * underneath it. The usual cause is codegen into `src/` from a `build` script listed
   * in `requiredScripts` after the coverage script.
   *
   * Carries a number for its dimension, for the same reason its two neighbours do.
   */
  | 'code-changed-during-measurement'
  /**
   * The service answered and REFUSED: 401 or 403 from a SonarQube endpoint.
   *
   * Its own kind for the reason the others are: the response it calls for is
   * different from every neighbour. `tool-missing` says fix the URL, this says
   * rotate or grant the token, and confusing the two sends an adopter to the wrong
   * file. It is also the likeliest sonarqube failure in practice -- a rotated
   * SONARQUBE_TOKEN needs no change to anything else to arrive.
   */
  | 'access-denied'
  /**
   * The measurement succeeded and describes something other than what was asked about:
   * SonarQube named a DIFFERENT analysis as current for this project key than the one
   * the CE task confirmed, so the numbers just parsed are that analysis's.
   *
   * Its own kind because the response it calls for is neither of its neighbours'.
   * `tool-missing` says fix the URL, `access-denied` says rotate the token, and this
   * says serialise the scans on this project key or give each job its own key --
   * folding it into `crashed` would send the adopter looking for a broken subject when
   * the subject is fine and the SUBJECT IDENTITY is what went wrong.
   *
   * The honest caveat, since the sentence above this list makes a claim about every
   * member: this is the one kind whose failure was read in the code path rather than
   * reproduced against a live subject. Confirming it needs a SonarQube with two
   * concurrent publishers on one project key, which was not reproducible here. What IS
   * measured is every fact the detection rests on, probed against SonarQube Server
   * Community 26.6.0 and SonarQube Cloud 8.0.0 -- see the WHY block above
   * `bindReadingToAnalysis` in metrics.ts. The emitter reports a definite contradiction
   * from the server (this analysis, not that one), never an inference from silence:
   * every "cannot tell" answer routes to `SonarqubeAnalysisProvenance.unconfirmed`
   * instead, which is an advisory and fails nothing.
   */
  | 'wrong-subject';

/**
 * The kinds that arrive ALONGSIDE a value for their dimension.
 *
 * Lives here, beside the union it partitions, because three separate surfaces have to
 * agree about it and each one says something FALSE if it disagrees. `evaluateMeasurements`
 * in rules.ts prints "could not be measured", `describeUnmeasured` labels a dimension
 * "missing from this score", and the MCP handlers serialise the same partition -- all
 * three of which are wrong about a dimension whose percentage appears in the very same
 * output. Each one used to carry its own `=== 'stale-report'` check and its own comment
 * explaining the exception, so adding a second such kind silently made all three false at
 * once. It is a closed set rather than a predicate on the string so that adding a fourth
 * is a deliberate edit here.
 *
 * All of them are provenance findings: the tool ran, the report parsed, the arithmetic is
 * honest, and what is in doubt is WHICH CODE the number describes.
 */
export const MEASUREMENT_KINDS_REPORTING_A_NUMBER: ReadonlySet<MeasurementFailureKind> =
  new Set(['stale-report', 'provenance-unverified', 'code-changed-during-measurement']);

/**
 * What a failed measurement was measuring.
 *
 * Wider than `IssueSource` because that type answers a different question --
 * which tool located an issue -- and custom dimensions never locate one. They
 * still need to be nameable here: a `custom.*` dimension is gated by a ceiling
 * and by nothing else, so a broken extractor is precisely the case where saying
 * WHICH dimension went unmeasured is the whole value of the report.
 *
 * The specific path (`custom.anyCount`) rather than a bare `custom` wherever it
 * is known, since a project with a dozen custom dimensions gains nothing from
 * being told that one of them failed.
 *
 * `coverage.${string}` is here for the same reason one level down. Coverage is
 * the one dimension read from more than one report -- `coverage.unit` and
 * `coverage.lambda` are separate suites with separate summary files -- so a
 * failure that says only "coverage" leaves the adopter to guess which of the two
 * they have to fix. A bare `coverage` remains correct for a failure that is
 * about the dimension as a whole, such as an unreadable report.
 */
export type MeasurementDimension =
  | IssueSource
  | 'custom'
  | `custom.${string}`
  | `coverage.${string}`;

/**
 * The two fields every measurement has, however it was taken.
 *
 * `command` is deliberately not "the argv": for a provider that reads an
 * artifact there is no argv, and the reproduction instruction is the read
 * itself. What matters is that the string names something a human can re-run or
 * re-inspect.
 */
interface MeasurementEvidenceBase {
  /** The measurement as invoked, for reproduction. */
  readonly command: string;

  /** Wall time. Near the budget implicates the timeout even when output looks sane. */
  readonly elapsedMs: number;
}

/**
 * What the process actually did, captured whether or not it succeeded.
 *
 * These are the fields that distinguished a real 0-finding run from a silent
 * failure when this was diagnosed by hand: `stdoutBytes` at exactly 1048576
 * identified the truncation, and `exitCode: null` identified the kill. A
 * failure without them is not diagnosable, which is why they are REQUIRED here
 * rather than optional on one shared interface -- see MeasurementEvidence below.
 */
export interface ProcessEvidence extends MeasurementEvidenceBase {
  readonly via: 'process';

  /** null when the child was killed rather than exiting on its own. */
  readonly exitCode: number | null;

  /** Set when the child was terminated by signal (e.g. 'SIGTERM' on timeout). */
  readonly signal: string | null;

  /** Byte length of stdout. Equal to the buffer limit means truncation, not emptiness. */
  readonly stdoutBytes: number;

  /**
   * Byte length of stderr. maxBuffer is a budget shared with stdout rather than
   * a per-stream one, so stderr can be what pushes a run over it. That matters
   * for type-checking in particular, where diagnostics are scanned out of both
   * streams, so a truncated stderr silently lowers the error count.
   */
  readonly stderrBytes: number;

  /** Leading stderr, truncated. For humans; never parsed. */
  readonly stderrExcerpt?: string;
}

/**
 * One filesystem path a provider consulted, and what it found there.
 *
 * Named for the case it was built for -- a coverage report a provider tried to
 * read -- and used for two others, because "which paths did you look at, and
 * what was there" is the same evidence in all three. The typecheck provider
 * records the `package.json` it settled a script's existence from, and the
 * eslint provider records every `node_modules/.bin/eslint` candidate its
 * pre-flight probed. Those two are EXISTENCE probes rather than reads, which is
 * why `bytesRead` and `modifiedMs` are null on them: no file was opened.
 *
 * `outcome` is a closed set rather than a boolean because the four ways a read
 * can go wrong need four different answers from the adopter: an absent report
 * means the tool did not write one, an unreadable one is a permissions or
 * filesystem problem, invalid JSON means the writer was interrupted, and a
 * wrong shape means the file is not the report we were told to expect. An
 * existence probe that missed is `absent`, which is the same statement.
 */
export interface ReportAttempt {
  readonly path: string;
  readonly existed: boolean;

  /** null when nothing was read -- absent, an existence probe, or the read threw. */
  readonly bytesRead: number | null;

  /**
   * mtimeMs. RECORDED here, and judged NOWHERE that reads this field.
   *
   * For a report it is the only signal separating one written by this run from last
   * week's, so it belongs in the evidence a human reads. No threshold is applied to
   * it here, and none may be: that would be the provider vouching for its own
   * freshness, which the note on MeasurementProvider below rules out.
   *
   * There IS now exactly one place in the tool where a coverage summary's mtime is
   * compared, and it is worth naming precisely because this comment used to say
   * "nothing in the tool compares it against anything", which is no longer true.
   * `coverage-provenance.ts` stats the summary itself before `runScripts` and again
   * after, to answer one question: did THIS file get written during THIS process. Same
   * file, same process, ONE clock, no tolerance constant. It is never persisted, never
   * compared against another file's mtime, and never against another machine's --
   * which is the whole difference from the rule that was removed for doing all three.
   * It takes its own `statSync` and does not read this field, so nothing a provider
   * records here can influence it.
   *
   * It is OR'd with a content hash there because a comment-only source edit can
   * regenerate a byte-identical `coverage-summary.json`, and content alone would leave
   * a correctly-regenerated report looking unstamped.
   *
   * Null for an existence probe, and that is not a lost signal: a shim path or a
   * manifest was never claimed to be a report this run produced, so there is no
   * freshness question to answer about it.
   */
  readonly modifiedMs: number | null;

  readonly outcome: 'read' | 'absent' | 'unreadable' | 'invalid-json' | 'wrong-shape';

  /** Whatever `code` the throw carried, e.g. 'EACCES'. */
  readonly errorCode?: string;
}

/**
 * What a provider that did not spawn anything actually looked at.
 *
 * A provider that reads an artifact -- or that settles a question from the
 * filesystem before spawning, as the typecheck and eslint pre-flights do -- has
 * no exit status, no signal and no
 * streams, so ProcessEvidence's required fields cannot be filled honestly --
 * and filling them with `exitCode: 0, stdoutBytes: 0` would state that a
 * process ran cleanly and printed nothing, which is exactly the kind of
 * confident-but-false claim this module exists to prevent. The field-by-field
 * substitution, so the choice is auditable:
 *
 *   exit status  -> `outcome`, per path attempted
 *   stdoutBytes  -> `bytesRead` (a zero-byte report is the file analogue of
 *                   empty stdout, and just as diagnostic)
 *   signal       -> nothing; there is no child to kill
 *
 * `timeoutMs` and `maxBufferBytes` in MeasurementContext are simply unused by a
 * report reader -- a file read has neither a budget to exceed nor a stream to
 * truncate. They are left in the context rather than made optional, because
 * every OTHER provider needs them and an optional budget is a budget that gets
 * forgotten.
 */
export interface ReportEvidence extends MeasurementEvidenceBase {
  readonly via: 'report';
  readonly attempts: readonly ReportAttempt[];
}

/**
 * Evidence for a measurement, tagged by how the measurement was taken.
 *
 * A discriminated union rather than one interface with optional fields, because
 * the process fields being REQUIRED is what made the 1 MiB truncation
 * diagnosable at all. Making them optional to accommodate a file reader would
 * let a future spawn-based provider omit the very fields that caught the
 * original defect.
 */
export type MeasurementEvidence = ProcessEvidence | ReportEvidence;

export interface MeasurementFailure {
  readonly kind: MeasurementFailureKind;
  readonly dimension: MeasurementDimension;

  /** Human-readable, safe to surface directly in gate output. */
  readonly message: string;

  readonly evidence: MeasurementEvidence;
}

// =============================================================================
// Context
// =============================================================================

/**
 * Everything a provider needs from its caller.
 *
 * The budgets are explicit rather than baked into each call site because both
 * of them have silently caused wrong readings: the 1 MiB stdout default
 * truncated a real subject, and the 5s/60s/120s timeouts are the difference
 * between a slow project and an apparently clean one. A limit that can be
 * asserted in a test is a limit that cannot regress unnoticed.
 */
export interface MeasurementContext {
  /** Absolute path to the project being measured. */
  readonly projectRoot: string;

  /** Kill the child after this long. */
  readonly timeoutMs: number;

  /** Fail loudly rather than truncating past this many bytes of stdout. */
  readonly maxBufferBytes: number;

  /**
   * Which package manager to shell, already resolved.
   *
   * Required rather than defaulted, and that is the point: an optional field
   * falling back to npm would let a call site that forgot to thread it through
   * silently measure with the wrong runner, which is the class of drift this
   * indirection exists to remove. A provider that shells nothing still takes it,
   * for the same reason.
   */
  readonly packageManager: RunnerSelection;

  /**
   * The script the typecheck provider should run, already resolved.
   *
   * Here rather than looked up by the provider, because a provider that shells `tsc`
   * or `deno check` directly has no package.json script to look up -- the same
   * reasoning that keeps the missing-script pattern out of the provider.
   */
  readonly typecheckScript: TypecheckScriptSelection;
}

// =============================================================================
// Readings
// =============================================================================

/**
 * Metrics and located issues together, because they come from a SINGLE run of
 * the underlying tool.
 *
 * Today they do not: `extractEslintMetrics()` and `extractEslintIssues()` each
 * spawn eslint independently, so a full extraction runs it twice and nothing
 * checks that the two runs agree. Pairing them in one reading removes both the
 * duplicated work and the possibility of disagreement.
 */
export interface LintReading {
  readonly metrics: EslintMetrics;
  readonly issues: readonly LocatedIssue[];
}

export interface TypecheckReading {
  readonly metrics: TypescriptMetrics;
  readonly issues: readonly LocatedIssue[];
}

/** Which coverage suite a report belongs to. */
export type CoverageSuite = 'coverage.unit' | 'coverage.lambda';

/** One report the coverage provider looked at, and which role it plays. */
export interface CoverageReportRead {
  readonly suite: CoverageSuite;

  /** `summary` feeds the metrics; `final` feeds the located findings. */
  readonly kind: 'final' | 'summary';

  readonly attempt: ReportAttempt;

  /**
   * Whether the report's CONTENT was the shape findings can be read from.
   *
   * Separate from `attempt.outcome`, which is about the read itself, because the
   * two have different consequences and collapsing them would change behaviour.
   * A summary whose file entries are malformed still yields perfectly good
   * METRICS -- those come from `total`, which is validated on its own -- so it
   * must not be reported as an unreadable report. What it does cost is the
   * findings, and that is worth a warning from whoever discards them.
   */
  readonly shape: 'expected' | 'unexpected';
}

/**
 * Coverage carries two things the lint and typecheck readings do not, both
 * because it is the one dimension read from MORE THAN ONE report.
 *
 * `failures` exists because partial success is real here: a broken
 * `coverage-lambda` summary must not discard a perfectly good `coverage/` one, so
 * a single `Result` of "all metrics or one error" cannot express the outcome.
 * This is the shape `extractAllCustomMetrics` already uses for the same reason --
 * many independent measurements behind one call.
 *
 * `reads` exists because a caller can need to know which report a shortfall came
 * from without being handed a failure for it. targets/extract.ts is that caller:
 * it warns about a detail report it could not read findings from, which is a
 * degraded fix-advice problem rather than a failed measurement, so the provider
 * records what it saw and lets that layer decide. It is still NOT a freshness
 * channel: freshness is judged in coverage-provenance.ts, from a sidecar beside the
 * report, and that module takes its own `statSync` rather than reading
 * `attempt.modifiedMs`. So adding a consumer of this field for freshness would be a
 * second, weaker answer to a question that already has one.
 */
export interface CoverageReading {
  readonly metrics: AllCoverageMetrics;

  /**
   * Empty when the caller asked for metrics only, and then `reads` carries the
   * summaries alone -- the detail reports were not opened. See
   * CoverageProviderOptions in providers/coverage.ts for why that is an option at
   * all. An empty array from a caller that DID ask for issues means the reports
   * were read and nothing was uncovered.
   */
  readonly issues: readonly LocatedIssue[];

  readonly failures: readonly MeasurementFailure[];
  readonly reads: readonly CoverageReportRead[];
}

// =============================================================================
// Providers
// =============================================================================

/**
 * One way of measuring one dimension.
 *
 * `measure` is synchronous because every existing extraction path is
 * synchronous (spawnSync throughout); making it async here would ripple a
 * behavioural change through the extraction step, which must preserve
 * behaviour exactly. Revisit only alongside a deliberate move off spawnSync.
 *
 * Note this interface carries no liveness reporting, on purpose. Evidence a
 * provider reports about itself is self-attestation, and a provider broken
 * enough to return zero findings is broken enough to claim it ran. The
 * harness's independent probe re-runs the underlying tool precisely so its
 * evidence does not share a failure mode with the thing it is checking.
 */
export interface MeasurementProvider<TReading> {
  /** Identifies the implementation, e.g. 'eslint' or 'biome'. */
  readonly name: string;

  /** Which dimension this feeds. */
  readonly dimension: IssueSource;

  measure(context: MeasurementContext): Result<TReading, MeasurementFailure>;
}

export type LintProvider = MeasurementProvider<LintReading>;
export type TypecheckProvider = MeasurementProvider<TypecheckReading>;
export type CoverageProvider = MeasurementProvider<CoverageReading>;
