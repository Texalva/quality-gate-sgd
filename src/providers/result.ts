/**
 * Result helpers and shared subprocess classification.
 *
 * `classifyProcessOutput` is the point of this module. Every extraction path in
 * the tool currently repeats the same three lines:
 *
 *     const output = result.stdout || '[]';
 *     const results = JSON.parse(output);
 *     ... catch { return zero }
 *
 * Repeated per call site, that defect has to be fixed per call site, and it was
 * reintroduced at four of them. Classifying once means a provider cannot decide
 * on its own that a dead process found nothing.
 */

import type { SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';

import type {
  MeasurementDimension,
  MeasurementEvidence,
  MeasurementFailure,
  MeasurementFailureKind,
  ProcessEvidence,
  ReportAttempt,
  ReportEvidence,
  Result,
} from './types.js';

/**
 * Matches the timeouts already in use so the extraction changes no behaviour.
 * The buffer does not match: spawnSync's 1 MiB default silently truncated a
 * real subject, so 64 MiB is the corrected value, far past any plausible
 * linter or compiler output.
 */
export const DEFAULT_MEASUREMENT_LIMITS = {
  lintTimeoutMs: 120_000,
  typecheckTimeoutMs: 60_000,
  maxBufferBytes: 64 * 1024 * 1024,
} as const;

/**
 * A run whose wall time reached this fraction of its budget is treated as
 * timed out rather than crashed. spawnSync reports a killed child as
 * `status: null` either way, so elapsed time is the only signal separating
 * "exceeded its budget" from "died on startup".
 */
const TIMEOUT_ATTRIBUTION_RATIO = 0.95;

const STDERR_EXCERPT_BYTES = 2_000;

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(
  result: Result<T, E>
): result is { readonly ok: true; readonly value: T } => result.ok;

export const isErr = <T, E>(
  result: Result<T, E>
): result is { readonly ok: false; readonly error: E } => !result.ok;

export function measurementFailure(
  kind: MeasurementFailureKind,
  dimension: MeasurementDimension,
  message: string,
  evidence: MeasurementEvidence
): MeasurementFailure {
  return { kind, dimension, message, evidence };
}

/**
 * What the process did, independent of whether it succeeded.
 *
 * Exported because a provider needs the same evidence when output arrives but
 * does not parse -- a failure it can classify but `classifyProcessOutput`
 * cannot, since only the caller knows the expected shape.
 */
export function buildEvidence(
  spawn: SpawnSyncReturns<string>,
  command: string,
  elapsedMs: number
): ProcessEvidence {
  const stderr = spawn.stderr ?? '';
  return {
    via: 'process',
    command,
    exitCode: spawn.status,
    signal: spawn.signal ?? null,
    elapsedMs,
    stdoutBytes: Buffer.byteLength(spawn.stdout ?? ''),
    stderrBytes: Buffer.byteLength(stderr),
    stderrExcerpt: stderr.slice(0, STDERR_EXCERPT_BYTES) || undefined,
  };
}

/**
 * Reads one JSON report, recording what happened rather than collapsing it.
 *
 * `classifyProcessOutput` exists so no provider can decide on its own that a
 * dead process found nothing. This is the same argument for a dead FILE, which
 * the tool got wrong in two places at once: `loadCoverageData` swallowed every
 * parse error into `undefined` with a bare `catch { // Skip if invalid }`, and
 * `extractCoverageIssues` swallowed into `[]` plus a warning. In both, a corrupt
 * report was indistinguishable from an unmeasured project -- and a project with
 * no coverage floor then passed green over a dimension nobody measured.
 *
 * The four ways to fail are kept apart for the same reason the failure KINDS
 * are: absent means the tool never wrote it, unreadable is a filesystem
 * problem, invalid JSON means the writer was cut off mid-file, and a wrong
 * shape means this is not the report we were told to read. One boolean would
 * make them all "no coverage".
 *
 * Existence is probed with `existsSync` first, preserving the contract the
 * previous implementation had, so "the tool never wrote a lambda report" stays
 * the ordinary silent case it has always been. `statSync` is called only for
 * `modifiedMs`, inside its own try, and CANNOT change the outcome -- mtime is
 * supplementary evidence for a human, never a verdict.
 *
 * Does not log. The caller decides whether this failure is fatal or discarded,
 * and only the layer that discards an error should be talking about it.
 */
export function readJsonReport(absolutePath: string): {
  readonly attempt: ReportAttempt;
  readonly data?: unknown;
} {
  if (!fs.existsSync(absolutePath)) {
    return {
      attempt: {
        path: absolutePath,
        existed: false,
        bytesRead: null,
        modifiedMs: null,
        outcome: 'absent',
      },
    };
  }

  let raw: unknown;
  try {
    raw = fs.readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    return {
      attempt: {
        path: absolutePath,
        existed: true,
        bytesRead: null,
        modifiedMs: null,
        outcome: 'unreadable',
        errorCode: (error as { code?: string } | undefined)?.code,
      },
    };
  }

  if (typeof raw !== 'string') {
    return {
      attempt: {
        path: absolutePath,
        existed: true,
        bytesRead: null,
        modifiedMs: null,
        outcome: 'unreadable',
      },
    };
  }

  let modifiedMs: number | null = null;
  try {
    const stat: unknown = fs.statSync(absolutePath);
    const mtimeMs = (stat as { mtimeMs?: unknown } | undefined)?.mtimeMs;
    if (typeof mtimeMs === 'number') modifiedMs = mtimeMs;
  } catch {
    // Evidence only. A report we just read successfully is not un-measured
    // because its mtime was unavailable.
  }

  const base = {
    path: absolutePath,
    existed: true,
    bytesRead: Buffer.byteLength(raw),
    modifiedMs,
  } as const;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { attempt: { ...base, outcome: 'invalid-json' } };
  }

  // An array or a scalar parses perfectly and then yields nothing when iterated
  // as a keyed report -- the shape of failure that reads as a clean project.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { attempt: { ...base, outcome: 'wrong-shape' } };
  }

  return { attempt: { ...base, outcome: 'read' }, data: parsed };
}

export function buildReportEvidence(
  command: string,
  elapsedMs: number,
  attempts: readonly ReportAttempt[]
): ReportEvidence {
  return { via: 'report', command, elapsedMs, attempts };
}

/**
 * Turns a finished spawnSync into either its stdout or a classified failure.
 *
 * `successExitCodes` is required, and has no default, because exit codes are
 * per-tool and getting them wrong is silent. eslint exits 0 clean, 1 when it
 * finds problems, and **2 when it could not run at all** -- so a blanket
 * "non-zero is still success" rule (needed for 1) hands back empty output for
 * 2, which parses as zero findings and passes an `eslint.errors: 0` ceiling.
 * That was a real defect in this file: a broken eslint config exits 2 with
 * empty stdout, and the measurement was reported clean.
 *
 * Making the caller state the set forces the question to be answered per tool
 * rather than inherited from whichever tool was considered first.
 *
 * Malformed output is NOT classified here -- only the caller knows the shape
 * it expects.
 */
export function classifyProcessOutput(
  spawn: SpawnSyncReturns<string>,
  options: {
    readonly command: string;
    readonly dimension: MeasurementDimension;
    readonly elapsedMs: number;
    readonly timeoutMs: number;
    readonly maxBufferBytes: number;
    /** Exit codes meaning "ran successfully", including ones reporting findings. */
    readonly successExitCodes: readonly number[];
  }
): Result<string, MeasurementFailure> {
  const stdout = spawn.stdout ?? '';
  const evidence = buildEvidence(spawn, options.command, options.elapsedMs);

  const fail = (kind: MeasurementFailureKind, message: string) =>
    err(measurementFailure(kind, options.dimension, message, evidence));

  const spawnError = spawn.error as (Error & { code?: string }) | undefined;

  if (spawnError?.code === 'ENOENT') {
    return fail(
      'tool-missing',
      `\`${options.command}\` could not be run: the command was not found.`
    );
  }

  // ENOBUFS, or the two streams together past the ceiling.
  //
  // Measured on Node 26.5.1 against a 1000-byte limit, since every part of this
  // is easy to get wrong:
  //
  //   999 bytes    -> status 0, 999 returned      (fine)
  //   1000 bytes   -> status 0, 1000 returned     (fine -- EXACTLY the limit is
  //                                                not truncation)
  //   1001 bytes   -> ENOBUFS, status null
  //   600 + 600    -> ENOBUFS, status 0           (budget is SHARED across the
  //                                                two streams, not per-stream)
  //
  // Hence STRICTLY greater than. `>=` here rejected a complete run whose output
  // happened to land exactly on the limit, and the caller then read that
  // rejection as zero findings -- a false failure that becomes a false pass.
  //
  // ENOBUFS is the authoritative signal and the byte sum only backs it up. The
  // order matters more than either: that 600+600 case pairs ENOBUFS with a
  // CLEAN exit status, so testing the status first would hand back truncated
  // output as a successful measurement.
  const combinedBytes = evidence.stdoutBytes + evidence.stderrBytes;

  if (spawnError?.code === 'ENOBUFS' || combinedBytes > options.maxBufferBytes) {
    return fail(
      'output-truncated',
      `\`${options.command}\` produced at least ${combinedBytes} bytes across stdout and stderr ` +
        `(${evidence.stdoutBytes} + ${evidence.stderrBytes}) against a ${options.maxBufferBytes}-byte ` +
        'limit, and was cut off. The output is incomplete; any count derived from it would be wrong.'
    );
  }

  if (spawn.signal !== null && spawn.signal !== undefined) {
    const timedOut = options.elapsedMs >= options.timeoutMs * TIMEOUT_ATTRIBUTION_RATIO;
    return timedOut
      ? fail(
          'timed-out',
          `\`${options.command}\` was killed after ${options.elapsedMs}ms against a ${options.timeoutMs}ms budget.`
        )
      : fail(
          'crashed',
          `\`${options.command}\` was killed by ${spawn.signal} after ${options.elapsedMs}ms.`
        );
  }

  if (spawn.status === null) {
    const detail = spawnError ? ` (${spawnError.code ?? spawnError.message})` : '';
    return fail(
      'crashed',
      `\`${options.command}\` exited without a status code after ${options.elapsedMs}ms${detail}.`
    );
  }

  // Any other spawn-level error -- EPERM, EACCES, EAGAIN. Previously only
  // ENOENT and ENOBUFS were recognised and everything else fell through as a
  // successful measurement.
  if (spawnError) {
    return fail(
      'crashed',
      `\`${options.command}\` failed to run: ${spawnError.code ?? spawnError.message}.`
    );
  }

  if (!options.successExitCodes.includes(spawn.status)) {
    return fail(
      'crashed',
      `\`${options.command}\` exited ${spawn.status}, which this tool uses to report a failed run ` +
        `rather than a findings report. Its output cannot be read as a measurement.`
    );
  }

  return ok(stdout);
}
