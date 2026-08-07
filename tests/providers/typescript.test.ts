import { describe, it, expect, vi, beforeEach } from 'vitest';

import { spawnSync } from 'child_process';
import type { SpawnSyncReturns } from 'child_process';

import { isErr, isOk } from '../../src/providers/result.js';
import { typescriptTypecheckProvider } from '../../src/providers/typescript.js';
import type { MeasurementContext } from '../../src/providers/types.js';

vi.mock('child_process', () => ({ spawnSync: vi.fn() }));

const CONTEXT: MeasurementContext = {
  projectRoot: '/test/project',
  timeoutMs: 60_000,
  maxBufferBytes: 1024,
  packageManager: { manager: 'npm', reason: 'test fixture' },
  typecheckScript: { script: 'type-check', reason: 'test fixture', definedInManifest: true },
};

async function mockTsc(overrides: Partial<SpawnSyncReturns<string>> = {}) {
  const { spawnSync } = await import('child_process');
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>);
}

const TWO_ERRORS = [
  "src/file.ts(10,5): error TS2345: Argument of type 'string' is not assignable.",
  "src/file.ts(15,3): error TS2339: Property 'foo' does not exist.",
].join('\n');

/**
 * The bun fall-through, refused before anything is spawned.
 *
 * `bun run <name>` for a script package.json does not define runs a same-named binary
 * from node_modules/.bin instead. Reproduced against bun 1.3.14 with a `.bin/type-check`
 * that printed nothing and exited 0, where npm exited 1. Exit 0 with empty output is
 * exactly what a clean project looks like, so no check after the spawn can catch it --
 * which is why the assertion below is that spawnSync was never CALLED.
 */
describe('a typecheck script the manifest does not define', () => {
  const undefinedScript = {
    ...CONTEXT,
    typecheckScript: { script: 'type-check', reason: 'package.json defines none of type-check, typecheck', definedInManifest: false },
  }

  it('fails as tool-missing without spawning anything', () => {
    const result = typescriptTypecheckProvider.measure(undefinedScript)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('tool-missing')
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled()
  })

  it('does not report zero errors, which is what the fall-through produced', () => {
    const result = typescriptTypecheckProvider.measure(undefinedScript)

    // The defect: a successful exit-0 run of the wrong binary yielded {errors: 0}.
    expect(result.ok).toBe(false)
  })

  it('names the script and how it was chosen, so the fix is obvious', () => {
    const result = typescriptTypecheckProvider.measure(undefinedScript)

    if (result.ok) throw new Error('expected a failure')
    expect(result.error.message).toContain('type-check')
    expect(result.error.message).toContain('QUALITY_TYPECHECK_SCRIPT')
  })

  // Evidence must not claim a process ran when none did.
  it('reports read evidence rather than fabricated process evidence', () => {
    const result = typescriptTypecheckProvider.measure(undefinedScript)

    if (result.ok) throw new Error('expected a failure')
    expect(result.error.evidence.via).toBe('report')
  })
})

describe('typescriptTypecheckProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies itself', () => {
    expect(typescriptTypecheckProvider.name).toBe('tsc');
    expect(typescriptTypecheckProvider.dimension).toBe('typescript');
  });

  describe('successful measurement', () => {
    it('parses located diagnostics into metrics and issues', async () => {
      // tsc exits 2 when it found diagnostics but still emitted output.
      await mockTsc({ stdout: TWO_ERRORS, status: 2 });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      expect(result.value.metrics).toEqual({ errors: 2, warnings: 0, rootCauses: 2 });
      expect(result.value.issues).toHaveLength(2);
      expect(result.value.issues[0]).toMatchObject({
        file: 'src/file.ts',
        line: 10,
        column: 5,
        source: 'typescript',
        dimension: 'typescript.errors',
        code: 'TS2345',
        message: "Argument of type 'string' is not assignable.",
        context: "TS2345: Argument of type 'string' is not assignable.",
        impact: { dimension: 'typescript.errors', delta: -1, direction: 'lower-better' },
      });
    });

    it('collapses cascading errors sharing a file and code into one root cause', async () => {
      await mockTsc({
        stdout: [
          'src/file.ts(10,5): error TS2345: First.',
          'src/file.ts(15,3): error TS2345: Same code, same file.',
          'src/other.ts(5,1): error TS2345: Same code, different file.',
        ].join('\n'),
        status: 2,
      });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value.metrics.errors).toBe(3);
      expect(result.value.metrics.rootCauses).toBe(2);
    });

    it('scans stderr as well as stdout', async () => {
      await mockTsc({
        stdout: 'src/file.ts(10,5): error TS2345: In stdout.',
        stderr: 'src/other.ts(5,1): error TS2339: In stderr.',
        status: 2,
      });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value.metrics.errors).toBe(2);
    });

    // A global diagnostic carries no file/line prefix, so the located-issue
    // regex cannot represent it. Real tsc 5 output, exit code included.
    it('counts diagnostics it cannot locate, and reports no issue for them', async () => {
      await mockTsc({
        stdout: "error TS18003: No inputs were found in config file 'tsconfig.json'.",
        status: 2,
      });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value.metrics.errors).toBe(1);
      expect(result.value.metrics.rootCauses).toBe(0);
      expect(result.value.issues).toHaveLength(0);
    });

    // tsc colourises under --pretty even through a pipe, and the escapes land
    // between "error" and the code, so an un-stripped scan matches nothing and
    // the run reads as clean. Verbatim tsc 5 output for `const x: number = "str"`.
    it('counts pretty-printed diagnostics, whose ANSI codes split "error TSnnnn"', async () => {
      await mockTsc({
        stdout:
          '\u001b[96ms/a.ts\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m7\u001b[0m - ' +
          "\u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'string' is not assignable to type 'number'.",
        status: 2,
      });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      // Counted, but not locatable: pretty puts the position in a `file:l:c`
      // shape the located regex does not read.
      expect(result.value.metrics.errors).toBe(1);
      expect(result.value.issues).toHaveLength(0);
    });

    // Exit 1 is a CLI-level failure in practice (TS5023 is an unknown compiler
    // option), not tsc's "diagnostics present" -- which is 2. It still emits a
    // diagnostic, so counting it fails the gate loudly rather than passing a
    // project that was never checked.
    it('counts a CLI-level failure that still emits a diagnostic', async () => {
      await mockTsc({
        stdout: "error TS5023: Unknown compiler option '--nonsense'.",
        status: 1,
      });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value.metrics.errors).toBe(1);
    });

    // spawnSync returns null streams on some paths (notably `stdio: 'inherit'`),
    // and concatenating those would produce the string "nullnull" and scan it.
    it('handles absent stdout and stderr without stringifying null', async () => {
      await mockTsc({
        stdout: null as unknown as string,
        stderr: null as unknown as string,
        status: 0,
      });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value.metrics).toEqual({ errors: 0, warnings: 0, rootCauses: 0 });
      expect(result.value.issues).toHaveLength(0);
    });

    it('accepts a genuinely clean run', async () => {
      await mockTsc({ stdout: '', stderr: '> tsc --noEmit -p tsconfig.json\n', status: 0 });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value.metrics).toEqual({ errors: 0, warnings: 0, rootCauses: 0 });
      expect(result.value.issues).toHaveLength(0);
    });

    // A `type-check` script written as `tsc --noEmit || true` exits 0 with
    // diagnostics. The diagnostics are still correct, so this must be counted
    // rather than treated as a contradiction -- the corroboration check below
    // is deliberately one-directional.
    it('counts diagnostics from a wrapper script that swallows the exit code', async () => {
      await mockTsc({ stdout: TWO_ERRORS, status: 0 });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value.metrics.errors).toBe(2);
    });

    // The scans use /g regexes, which carry a mutable lastIndex. Two identical
    // measurements must agree; a leaked lastIndex would make the second skip
    // the start of the output.
    it('gives the same answer on a repeated measurement', async () => {
      await mockTsc({ stdout: TWO_ERRORS, status: 2 });
      const first = typescriptTypecheckProvider.measure(CONTEXT);
      const second = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isOk(first) && isOk(second)).toBe(true);
      if (!isOk(first) || !isOk(second)) return;
      expect(second.value.metrics).toEqual(first.value.metrics);
      expect(second.value.issues).toHaveLength(first.value.issues.length);
    });
  });

  describe('failures are failures, not zero errors', () => {
    // The defect this provider exists to close. Type-check output is
    // regex-scanned rather than parsed, so unlike eslint there is no parse step
    // to fail: a dead process produces no `error TS` lines and reads as clean.
    it('reports a killed process as a failure rather than zero errors', async () => {
      await mockTsc({ stdout: '', status: null, signal: 'SIGTERM' });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('crashed');
    });

    it('reports truncated output as a failure rather than zero errors', async () => {
      await mockTsc({ stdout: 'x'.repeat(CONTEXT.maxBufferBytes + 1), status: null });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('output-truncated');
    });

    // Diagnostics are scanned out of stdout AND stderr, and spawnSync applies
    // maxBuffer per stream, so stderr is just as able to be the truncated one.
    it('reports truncated stderr as a failure too', async () => {
      await mockTsc({ stdout: '', stderr: 'x'.repeat(CONTEXT.maxBufferBytes + 1), status: 1 });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('output-truncated');
    });

    it('reports exits outside tsc\'s ExitStatus range as a crash', async () => {
      // 3 is InvalidProject_OutputsSkipped: the project could not be built as
      // configured, which is not a measurement of it.
      await mockTsc({ stdout: '', stderr: 'error: invalid project', status: 3 });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('crashed');
    });

    // The corroboration check. Exit 1 says "diagnostics present"; no diagnostic
    // text means whatever ended the run was not a type error.
    it('refuses a non-zero exit that produced no diagnostics', async () => {
      await mockTsc({ stdout: '', stderr: 'Killed\n', status: 1 });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('crashed');
      expect(result.error.message).toMatch(/no TypeScript diagnostics/);
    });

    // Apollo Client ships `typecheck`; this tool shells `npm run type-check`.
    // npm exits 1 for that, exactly like tsc reporting diagnostics, and the old
    // code scored it zero errors.
    it('names a missing script rather than reporting a clean project', async () => {
      await mockTsc({
        stdout: '',
        stderr: 'npm error Missing script: "type-check"\n',
        status: 1,
      });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('tool-missing');
      expect(result.error.evidence.stderrExcerpt).toMatch(/Missing script/);
    });

    it('reports a missing npm binary as tool-missing', async () => {
      const enoent = Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' });
      await mockTsc({ error: enoent, status: null, stdout: '' });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('tool-missing');
    });

    it('carries the evidence needed to diagnose the failure', async () => {
      await mockTsc({ stdout: '', stderr: 'boom', status: 3 });

      const result = typescriptTypecheckProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.dimension).toBe('typescript');
      expect(result.error.evidence.exitCode).toBe(3);
      expect(result.error.evidence.stderrExcerpt).toBe('boom');
      expect(result.error.evidence.command).toContain('type-check');
    });
  });

  it('passes the caller-supplied budgets through to the subprocess', async () => {
    await mockTsc({ stdout: '', status: 0 });

    typescriptTypecheckProvider.measure(CONTEXT);

    const { spawnSync } = await import('child_process');
    expect(spawnSync).toHaveBeenCalledWith(
      'npm',
      ['run', 'type-check'],
      expect.objectContaining({
        cwd: '/test/project',
        timeout: 60_000,
        maxBuffer: 1024,
      })
    );
  });
});
