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
import type { IssueSource, LocatedIssue } from '../targets/types.js';
import type { AllCoverageMetrics, EslintMetrics, TypescriptMetrics } from '../types.js';
/**
 * Errors as values. Deliberately not an exception: a thrown error can be
 * swallowed by a `catch` that returns a default, which is precisely the bug
 * this type exists to make impossible.
 */
export type Result<T, E> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: E;
};
/**
 * How a measurement can fail. Every member corresponds to a failure actually
 * observed against a real subject, not a hypothetical:
 *
 * - `tool-missing`       apollo-client ships a `typecheck` script; the tool
 *                        shells `npm run type-check` and got nothing back.
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
 * There is deliberately NO kind for "the report is older than the code". One was
 * added and removed: the rule behind it (compare the summary's mtime against the
 * newest file under `codePathspecs`) was inert on any project without a literal
 * top-level `src/` and false-failed mtime-preserving archive restores, branch
 * switches, clock skew and any bulk tree write longer than its tolerance. A
 * declared kind nothing can emit is a claim that the tool detects something it
 * does not, so the kind went with the rule. The open question is backlog #39.
 *
 * `report-missing` is the one kind that is declared and never emitted; it remains
 * the right kind for a run that succeeds and writes nothing, and is not a claim
 * about a report that exists.
 */
export type MeasurementFailureKind = 'tool-missing' | 'crashed' | 'timed-out' | 'output-truncated' | 'unparseable-output' | 'report-missing' | 'measured-nothing';
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
export type MeasurementDimension = IssueSource | 'custom' | `custom.${string}` | `coverage.${string}`;
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
 * One report file a provider looked for, and what it found there.
 *
 * `outcome` is a closed set rather than a boolean because the four ways a read
 * can go wrong need four different answers from the adopter: an absent report
 * means the tool did not write one, an unreadable one is a permissions or
 * filesystem problem, invalid JSON means the writer was interrupted, and a
 * wrong shape means the file is not the report we were told to expect.
 */
export interface ReportAttempt {
    readonly path: string;
    readonly existed: boolean;
    /** null when nothing was read -- absent, or the read itself threw. */
    readonly bytesRead: number | null;
    /**
     * mtimeMs. RECORDED, never judged -- by this provider or by any caller.
     *
     * It is the only signal separating a report written by this run from last
     * week's, so it belongs in the evidence a human reads. Nothing in the tool
     * compares it against anything: a caller did, briefly, and the comparison was
     * wrong in both directions at once (see MeasurementFailureKind and backlog
     * #39). Adding a threshold here would additionally be the provider vouching for
     * its own freshness, which the note on MeasurementProvider below rules out.
     */
    readonly modifiedMs: number | null;
    readonly outcome: 'read' | 'absent' | 'unreadable' | 'invalid-json' | 'wrong-shape';
    /** Whatever `code` the throw carried, e.g. 'EACCES'. */
    readonly errorCode?: string;
}
/**
 * What a report-reading provider actually looked at.
 *
 * A provider that reads an artifact has no exit status, no signal and no
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
}
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
 * records what it saw and lets that layer decide. It is NOT a freshness channel;
 * nothing judges `attempt.modifiedMs`.
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
export {};
//# sourceMappingURL=types.d.ts.map