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
 * Deliberately does NOT treat a non-zero exit code as failure. eslint exits 1
 * when it finds problems and tsc exits 2 when it finds type errors — those are
 * successful measurements reporting bad news, and the original code's
 * `result.status === 0 ? 0 : 1` fallback had this exactly backwards. Only
 * process-level death, truncation, or a missing binary count here; malformed
 * output is the caller's to classify, since only it knows the expected shape.
 */
export declare function classifyProcessOutput(spawn: SpawnSyncReturns<string>, options: {
    readonly command: string;
    readonly dimension: IssueSource;
    readonly elapsedMs: number;
    readonly timeoutMs: number;
    readonly maxBufferBytes: number;
}): Result<string, MeasurementFailure>;
//# sourceMappingURL=result.d.ts.map