import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SpawnSyncReturns } from 'child_process';

import { eslintLintProvider } from '../../src/providers/eslint.js';
import { isErr, isOk } from '../../src/providers/result.js';
import type { MeasurementContext } from '../../src/providers/types.js';

vi.mock('child_process', () => ({ spawnSync: vi.fn() }));

const CONTEXT: MeasurementContext = {
  projectRoot: '/test/project',
  timeoutMs: 120_000,
  maxBufferBytes: 1024,
};

function spawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: '[]',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

async function mockEslint(overrides: Partial<SpawnSyncReturns<string>> = {}) {
  const { spawnSync } = await import('child_process');
  vi.mocked(spawnSync).mockReturnValue(spawnResult(overrides));
}

const FINDINGS = JSON.stringify([
  {
    filePath: '/test/project/src/a.ts',
    errorCount: 2,
    warningCount: 1,
    messages: [
      { ruleId: 'eqeqeq', severity: 2, message: 'Expected ===', line: 3, column: 10, endLine: 3, endColumn: 12 },
      { ruleId: 'eqeqeq', severity: 2, message: 'Expected ===', line: 9, column: 4 },
      { ruleId: 'no-console', severity: 1, message: 'Unexpected console', line: 5, column: 1 },
    ],
  },
  {
    filePath: '/test/project/src/b.ts',
    errorCount: 1,
    warningCount: 0,
    messages: [
      { ruleId: 'eqeqeq', severity: 2, message: 'Expected ===', line: 1, column: 1 },
    ],
  },
]);

describe('eslintLintProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies itself', () => {
    expect(eslintLintProvider.name).toBe('eslint');
    expect(eslintLintProvider.dimension).toBe('eslint');
  });

  describe('successful measurement', () => {
    it('returns metrics and issues from a single run', async () => {
      await mockEslint({ stdout: FINDINGS, status: 1 });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      expect(result.value.metrics).toEqual({ errors: 3, warnings: 1, rootCauses: 2 });
      expect(result.value.issues).toHaveLength(4);

      const { spawnSync } = await import('child_process');
      expect(spawnSync).toHaveBeenCalledTimes(1);
    });

    // eslint's per-file counts and its message list can legitimately disagree:
    // a fatal parse error raises errorCount without emitting an ordinary
    // message. Deriving the totals from messages would silently change them.
    it('takes totals from eslint\'s own counts, not from counting messages', async () => {
      await mockEslint({
        stdout: JSON.stringify([
          { filePath: '/test/project/src/broken.ts', errorCount: 7, warningCount: 4, messages: [] },
        ]),
        status: 1,
      });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value.metrics.errors).toBe(7);
      expect(result.value.metrics.warnings).toBe(4);
      expect(result.value.issues).toHaveLength(0);
    });

    it('counts root causes as distinct file+rule pairs, errors only', async () => {
      await mockEslint({ stdout: FINDINGS, status: 1 });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      // a.ts:eqeqeq and b.ts:eqeqeq. The two eqeqeq hits in a.ts collapse to
      // one, and no-console is a warning so it does not count at all.
      if (isOk(result)) expect(result.value.metrics.rootCauses).toBe(2);
    });

    it('maps severity, dimension and context onto each issue', async () => {
      await mockEslint({ stdout: FINDINGS, status: 1 });

      const result = eslintLintProvider.measure(CONTEXT);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      const [error] = result.value.issues;
      expect(error).toMatchObject({
        file: '/test/project/src/a.ts',
        line: 3,
        column: 10,
        endLine: 3,
        endColumn: 12,
        source: 'eslint',
        dimension: 'eslint.errors',
        code: 'eqeqeq',
        severity: 'major',
        message: 'Expected ===',
        context: 'Rule: eqeqeq',
        impact: { dimension: 'eslint.errors', delta: -1, direction: 'lower-better' },
      });

      const warning = result.value.issues.find((i) => i.code === 'no-console');
      expect(warning).toMatchObject({ dimension: 'eslint.warnings', severity: 'minor' });
    });

    it('labels a finding with no rule as unknown and gives it no context', async () => {
      await mockEslint({
        stdout: JSON.stringify([
          {
            filePath: '/test/project/src/c.ts',
            errorCount: 1,
            warningCount: 0,
            messages: [{ ruleId: null, severity: 2, message: 'Parsing error', line: 1, column: 1 }],
          },
        ]),
        status: 1,
      });

      const result = eslintLintProvider.measure(CONTEXT);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      expect(result.value.issues[0].code).toBe('unknown');
      expect(result.value.issues[0].context).toBeUndefined();
      // A ruleId-less error cannot be attributed to a rule, so it is not a root cause.
      expect(result.value.metrics.rootCauses).toBe(0);
    });
  });

  describe('failures are failures, not empty results', () => {
    // The regression test for the defect this refactor exists to remove.
    // 1038 real findings once arrived as exactly 1048576 bytes and were
    // reported as zero errors, which passed an `eslint.errors: 0` ceiling.
    it('reports truncated output as a failure rather than zero findings', async () => {
      await mockEslint({ stdout: 'x'.repeat(CONTEXT.maxBufferBytes), status: null });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('output-truncated');
      expect(result.error.dimension).toBe('eslint');
      expect(result.error.evidence.stdoutBytes).toBe(CONTEXT.maxBufferBytes);
    });

    it('reports a killed process as a failure rather than zero findings', async () => {
      await mockEslint({ stdout: '', status: null, signal: 'SIGSEGV' });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('crashed');
    });

    it('reports unparseable output with the evidence needed to diagnose it', async () => {
      await mockEslint({ stdout: 'Error: cannot find config', stderr: 'boom', status: 2 });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('unparseable-output');
      expect(result.error.evidence.exitCode).toBe(2);
      expect(result.error.evidence.stderrExcerpt).toBe('boom');
      expect(result.error.evidence.command).toContain('eslint');
    });

    it('reports a missing binary as tool-missing', async () => {
      const enoent = Object.assign(new Error('spawnSync npx ENOENT'), { code: 'ENOENT' });
      await mockEslint({ error: enoent, status: null, stdout: '' });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('tool-missing');
    });
  });

  describe('preserved pre-extraction behaviour', () => {
    // Retained deliberately: `stdout || '[]'`. It is half of the original
    // silent-failure bug, kept so the extraction step alters nothing, and
    // reachable now only when the process exited cleanly with no output --
    // the dangerous cases are caught before parsing. Step 6 removes it, and
    // this test is expected to change then.
    it('treats clean-exit empty output as zero findings', async () => {
      await mockEslint({ stdout: '', status: 0 });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value.metrics).toEqual({ errors: 0, warnings: 0, rootCauses: 0 });
      expect(result.value.issues).toHaveLength(0);
    });

    it('passes the caller-supplied budgets through to the subprocess', async () => {
      await mockEslint({ stdout: '[]', status: 0 });

      eslintLintProvider.measure(CONTEXT);

      const { spawnSync } = await import('child_process');
      expect(spawnSync).toHaveBeenCalledWith(
        'npx',
        ['eslint', '--format', 'json', 'src/'],
        expect.objectContaining({
          cwd: '/test/project',
          timeout: 120_000,
          maxBuffer: 1024,
        })
      );
    });
  });
});
