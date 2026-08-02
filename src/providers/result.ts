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

import type { IssueSource } from '../targets/types.js';
import type {
  MeasurementEvidence,
  MeasurementFailure,
  MeasurementFailureKind,
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
  dimension: IssueSource,
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
): MeasurementEvidence {
  const stderr = spawn.stderr ?? '';
  return {
    command,
    exitCode: spawn.status,
    signal: spawn.signal ?? null,
    elapsedMs,
    stdoutBytes: Buffer.byteLength(spawn.stdout ?? ''),
    stderrExcerpt: stderr.slice(0, STDERR_EXCERPT_BYTES) || undefined,
  };
}

/**
 * Turns a finished spawnSync into either its stdout or a classified failure.
 *
 * Deliberately does NOT treat a non-zero exit code as failure. eslint exits 1
 * when it finds problems and tsc exits 2 when it finds type errors — those are
 * successful measurements reporting bad news, and the original code's
 * `result.status === 0 ? 0 : 1` fallback had this exactly backwards. Only
 * process-level death, truncation, or a missing binary count here; malformed
 * output is the caller's to classify, since only it knows the expected shape.
 */
export function classifyProcessOutput(
  spawn: SpawnSyncReturns<string>,
  options: {
    readonly command: string;
    readonly dimension: IssueSource;
    readonly elapsedMs: number;
    readonly timeoutMs: number;
    readonly maxBufferBytes: number;
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

  // ENOBUFS, or stdout sitting exactly on the ceiling. Checked before the
  // kill check below, because exceeding the buffer also kills the child and
  // would otherwise be misreported as a crash.
  if (spawnError?.code === 'ENOBUFS' || evidence.stdoutBytes >= options.maxBufferBytes) {
    return fail(
      'output-truncated',
      `\`${options.command}\` produced at least ${evidence.stdoutBytes} bytes and was cut off at the ` +
        `${options.maxBufferBytes}-byte limit. The output is incomplete; any count derived from it would be wrong.`
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
    return fail(
      'crashed',
      `\`${options.command}\` exited without a status code after ${options.elapsedMs}ms.`
    );
  }

  return ok(stdout);
}
