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
import type { MeasurementEvidence, MeasurementFailure, MeasurementFailureKind, Result } from './types.js';
/**
 * Matches the timeouts already in use so the extraction changes no behaviour.
 * The buffer does not match: spawnSync's 1 MiB default silently truncated a
 * real subject, so 64 MiB is the corrected value, far past any plausible
 * linter or compiler output.
 */
export declare const DEFAULT_MEASUREMENT_LIMITS: {
    readonly lintTimeoutMs: 120000;
    readonly typecheckTimeoutMs: 60000;
    readonly maxBufferBytes: number;
};
export declare const ok: <T>(value: T) => Result<T, never>;
export declare const err: <E>(error: E) => Result<never, E>;
export declare const isOk: <T, E>(result: Result<T, E>) => result is {
    readonly ok: true;
    readonly value: T;
};
export declare const isErr: <T, E>(result: Result<T, E>) => result is {
    readonly ok: false;
    readonly error: E;
};
export declare function measurementFailure(kind: MeasurementFailureKind, dimension: IssueSource, message: string, evidence: MeasurementEvidence): MeasurementFailure;
/**
 * What the process did, independent of whether it succeeded.
 *
 * Exported because a provider needs the same evidence when output arrives but
 * does not parse -- a failure it can classify but `classifyProcessOutput`
 * cannot, since only the caller knows the expected shape.
 */
export declare function buildEvidence(spawn: SpawnSyncReturns<string>, command: string, elapsedMs: number): MeasurementEvidence;
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
export declare function classifyProcessOutput(spawn: SpawnSyncReturns<string>, options: {
    readonly command: string;
    readonly dimension: IssueSource;
    readonly elapsedMs: number;
    readonly timeoutMs: number;
    readonly maxBufferBytes: number;
    /** Exit codes meaning "ran successfully", including ones reporting findings. */
    readonly successExitCodes: readonly number[];
}): Result<string, MeasurementFailure>;
//# sourceMappingURL=result.d.ts.map