import { describe, it, expect } from 'vitest';

import type { SpawnSyncReturns } from 'child_process';

import {
  classifyProcessOutput,
  DEFAULT_MEASUREMENT_LIMITS,
  err,
  isErr,
  isOk,
  ok,
} from '../../src/providers/result.js';

const MAX_BUFFER = 1024;
const TIMEOUT_MS = 10_000;

function spawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

// eslint's codes: 0 clean, 1 findings, 2 could-not-run.
const SUCCESS_CODES = [0, 1];

const classify = (
  spawn: SpawnSyncReturns<string>,
  elapsedMs = 100,
  successExitCodes: readonly number[] = SUCCESS_CODES
) =>
  classifyProcessOutput(spawn, {
    command: 'npx eslint --format json src/',
    dimension: 'eslint',
    elapsedMs,
    timeoutMs: TIMEOUT_MS,
    maxBufferBytes: MAX_BUFFER,
    successExitCodes,
  });

describe('Result helpers', () => {
  it('narrows ok and err through the guards', () => {
    const good = ok(42);
    const bad = err('boom');

    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isErr(bad)).toBe(true);

    if (isOk(good)) expect(good.value).toBe(42);
    if (isErr(bad)) expect(bad.error).toBe('boom');
  });
});

describe('classifyProcessOutput', () => {
  describe('successful measurements', () => {
    it('returns stdout for a clean run', () => {
      const result = classify(spawnResult({ stdout: '[]', status: 0 }));

      expect(result.ok).toBe(true);
      if (isOk(result)) expect(result.value).toBe('[]');
    });

    // eslint exits 1 whenever it finds anything, so a declared success code
    // must stay success -- otherwise every imperfect project reads as
    // unmeasurable.
    it('treats a declared non-zero success code as success', () => {
      const foundProblems = classify(spawnResult({ stdout: '[{"messages":[]}]', status: 1 }));
      expect(foundProblems.ok).toBe(true);
    });

    // The mirror image, and the defect this parameter exists for: eslint's 2
    // means "could not run", arrives with EMPTY stdout, and used to be waved
    // through as a clean measurement.
    it('treats an undeclared exit code as a failure, not an empty result', () => {
      const couldNotRun = classify(spawnResult({ stdout: '', status: 2 }));

      expect(isErr(couldNotRun)).toBe(true);
      if (isErr(couldNotRun)) expect(couldNotRun.error.kind).toBe('crashed');
    });

    // The same code means different things to different tools, which is why
    // the set is required rather than defaulted.
    it('honours a different tool\'s exit-code contract', () => {
      const tscFoundErrors = classify(
        spawnResult({ stdout: 'src/a.ts(1,1): error TS2322: nope', status: 2 }),
        100,
        [0, 1, 2] // tsc reports type errors with 2
      );
      expect(tscFoundErrors.ok).toBe(true);
    });

    it('returns empty stdout as success when the process exited normally', () => {
      // A genuinely clean project. Distinguishable from a dead one ONLY by the
      // process having exited on its own, which is the whole point.
      const result = classify(spawnResult({ stdout: '', status: 0 }));
      expect(result.ok).toBe(true);
    });
  });

  describe('failures', () => {
    it('reports a missing binary as tool-missing', () => {
      const enoent = Object.assign(new Error('spawnSync npx ENOENT'), { code: 'ENOENT' });
      const result = classify(spawnResult({ error: enoent, status: null }));

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('tool-missing');
    });

    it('reports ENOBUFS as output-truncated', () => {
      const enobufs = Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' });
      const result = classify(spawnResult({ error: enobufs, status: null }));

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('output-truncated');
    });

    // The regression test for the bug this whole module exists to prevent:
    // 1038 real findings arrived as exactly 1048576 bytes and were reported
    // as zero errors.
    it('reports stdout sitting on the buffer ceiling as output-truncated', () => {
      const result = classify(spawnResult({ stdout: 'x'.repeat(MAX_BUFFER), status: null }));

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('output-truncated');
        expect(result.error.evidence.stdoutBytes).toBe(MAX_BUFFER);
      }
    });

    it('prefers truncation over crash when the child was killed by the buffer', () => {
      // Overflowing the buffer also kills the child, so both signals are
      // present. Misreporting it as a crash would send someone hunting a
      // subject bug instead of raising a limit.
      const result = classify(
        spawnResult({ stdout: 'x'.repeat(MAX_BUFFER), status: null, signal: 'SIGTERM' })
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('output-truncated');
    });

    it('attributes a kill near the budget to the timeout', () => {
      const result = classify(spawnResult({ status: null, signal: 'SIGTERM' }), TIMEOUT_MS);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('timed-out');
    });

    it('attributes an early kill to a crash rather than the timeout', () => {
      const result = classify(spawnResult({ status: null, signal: 'SIGSEGV' }), 12);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('crashed');
    });

    // The two shapes a permission failure actually takes, measured rather than
    // imagined: spawning the binary directly yields {error: EACCES, status:
    // null}, while the production `shell: true` path yields {error: undefined,
    // status: 126} because the shell reports it instead.
    it('rejects a permission failure in both of its real forms', () => {
      const eacces = Object.assign(new Error('spawnSync EACCES'), { code: 'EACCES' });
      const direct = classify(spawnResult({ error: eacces, status: null, stdout: '', signal: null }));
      expect(isErr(direct)).toBe(true);
      if (isErr(direct)) expect(direct.error.kind).toBe('crashed');

      // 126 is "found but not executable" -- not a declared success code.
      const viaShell = classify(spawnResult({ status: 126, stdout: '' }));
      expect(isErr(viaShell)).toBe(true);
      if (isErr(viaShell)) expect(viaShell.error.kind).toBe('crashed');
    });

    // Defensive rather than observed: spawnSync has not been seen returning an
    // error alongside a numeric status. The branch exists so a future/platform
    // variant cannot fall through to success, which is what happened when only
    // ENOENT and ENOBUFS were recognised.
    it('rejects an error carried alongside a numeric status', () => {
      for (const code of ['EPERM', 'EAGAIN']) {
        const spawnErr = Object.assign(new Error(`spawnSync ${code}`), { code });
        const result = classify(spawnResult({ error: spawnErr, status: 0, stdout: '' }));

        expect(isErr(result), code).toBe(true);
        if (isErr(result)) {
          expect(result.error.kind).toBe('crashed');
          expect(result.error.message).toContain(code);
        }
      }
    });

    it('reports a null status with no signal as a crash', () => {
      const result = classify(spawnResult({ status: null, signal: null }));

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('crashed');
    });

    it('names the spawn error alongside a null status', () => {
      const spawnErr = Object.assign(new Error('spawnSync EAGAIN'), { code: 'EAGAIN' });
      const result = classify(spawnResult({ error: spawnErr, status: null, signal: null }));

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.message).toContain('EAGAIN');
    });

    // Not every spawn error carries a `code`; falling back to the message keeps
    // the failure diagnosable instead of reporting "undefined".
    it('falls back to the error message when there is no error code', () => {
      const codeless = new Error('resource temporarily unavailable');

      const nullStatus = classify(spawnResult({ error: codeless, status: null, signal: null }));
      expect(isErr(nullStatus)).toBe(true);
      if (isErr(nullStatus)) {
        expect(nullStatus.error.message).toContain('resource temporarily unavailable');
      }

      const withStatus = classify(spawnResult({ error: codeless, status: 0, stdout: '' }));
      expect(isErr(withStatus)).toBe(true);
      if (isErr(withStatus)) {
        expect(withStatus.error.kind).toBe('crashed');
        expect(withStatus.error.message).toContain('resource temporarily unavailable');
      }
    });

    it('survives a child that produced no stdout or stderr at all', () => {
      // spawnSync returns null, not '', for streams it never received -- a
      // child killed before writing anything hits this. Reading it as a string
      // would throw inside the classifier, converting a diagnosable failure
      // into an unhandled crash at the call site.
      const result = classify(
        spawnResult({
          stdout: null as unknown as string,
          stderr: null as unknown as string,
          status: null,
        })
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('crashed');
        expect(result.error.evidence.stdoutBytes).toBe(0);
        expect(result.error.evidence.stderrExcerpt).toBeUndefined();
      }
    });
  });

  describe('evidence', () => {
    it('captures what the process did, so a failure is diagnosable', () => {
      const result = classify(
        spawnResult({ stdout: 'partial', stderr: 'it broke', status: null, signal: 'SIGTERM' }),
        9_999
      );

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;

      const { evidence } = result.error;
      expect(evidence.command).toBe('npx eslint --format json src/');
      expect(evidence.exitCode).toBeNull();
      expect(evidence.signal).toBe('SIGTERM');
      expect(evidence.elapsedMs).toBe(9_999);
      expect(evidence.stdoutBytes).toBe('partial'.length);
      expect(evidence.stderrExcerpt).toBe('it broke');
      expect(result.error.dimension).toBe('eslint');
    });

    it('omits the stderr excerpt when there was no stderr', () => {
      const result = classify(spawnResult({ status: null }));

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.evidence.stderrExcerpt).toBeUndefined();
    });
  });

  describe('invariants', () => {
    // Whatever else is true of a run, output at or past the ceiling is never
    // trustworthy -- no combination of exit code or signal should let it
    // through as a successful measurement.
    it('never returns ok for stdout at or beyond the buffer limit', () => {
      const statuses: Array<number | null> = [0, 1, 2, null];
      const signals: Array<NodeJS.Signals | null> = [null, 'SIGTERM', 'SIGKILL'];

      for (const status of statuses) {
        for (const signal of signals) {
          for (const size of [MAX_BUFFER, MAX_BUFFER + 1, MAX_BUFFER * 2]) {
            const result = classify(spawnResult({ stdout: 'x'.repeat(size), status, signal }));
            expect(result.ok, `status=${status} signal=${signal} size=${size}`).toBe(false);
          }
        }
      }
    });

    it('never returns ok when the process produced no status of its own', () => {
      for (const signal of [null, 'SIGTERM', 'SIGKILL'] as Array<NodeJS.Signals | null>) {
        const result = classify(spawnResult({ stdout: 'fine', status: null, signal }));
        expect(result.ok, `signal=${signal}`).toBe(false);
      }
    });
  });

  describe('default limits', () => {
    it('keeps the existing timeouts and raises only the buffer', () => {
      expect(DEFAULT_MEASUREMENT_LIMITS.lintTimeoutMs).toBe(120_000);
      expect(DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs).toBe(60_000);
      // Must exceed spawnSync's 1 MiB default, which is what truncated a real run.
      expect(DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes).toBeGreaterThan(1024 * 1024);
    });
  });
});
