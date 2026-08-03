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
 *
 * They are kept distinct because they need different responses: a missing tool
 * is a configuration problem, truncation is a budget problem, and a crash is a
 * subject problem. Collapsing them is how the original defect stayed invisible.
 */
export type MeasurementFailureKind =
  | 'tool-missing'
  | 'crashed'
  | 'timed-out'
  | 'output-truncated'
  | 'unparseable-output'
  | 'report-missing';

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
 */
export type MeasurementDimension = IssueSource | 'custom' | `custom.${string}`;

/**
 * What the process actually did, captured whether or not it succeeded.
 *
 * These are the fields that distinguished a real 0-finding run from a silent
 * failure when this was diagnosed by hand: `stdoutBytes` at exactly 1048576
 * identified the truncation, and `exitCode: null` identified the kill. A
 * failure without them is not diagnosable.
 */
export interface MeasurementEvidence {
  /** The command as invoked, for reproduction. */
  readonly command: string;

  /** null when the child was killed rather than exiting on its own. */
  readonly exitCode: number | null;

  /** Set when the child was terminated by signal (e.g. 'SIGTERM' on timeout). */
  readonly signal: string | null;

  /** Wall time. Near the budget implicates the timeout even when output looks sane. */
  readonly elapsedMs: number;

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

export interface CoverageReading {
  readonly metrics: AllCoverageMetrics;
  readonly issues: readonly LocatedIssue[];
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
