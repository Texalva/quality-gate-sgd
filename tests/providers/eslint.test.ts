import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import type { SpawnSyncReturns } from 'child_process';

import { eslintLintProvider } from '../../src/providers/eslint.js';
import { isErr, isOk } from '../../src/providers/result.js';
import type { MeasurementContext } from '../../src/providers/types.js';

vi.mock('child_process', () => ({ spawnSync: vi.fn() }));

const BASE_CONTEXT: MeasurementContext = {
  projectRoot: '/test/project',
  timeoutMs: 120_000,
  maxBufferBytes: 1024,
  packageManager: { manager: 'npm', reason: 'test fixture' },
  typecheckScript: { script: 'type-check', reason: 'test fixture', definedInManifest: true },
};

/**
 * Real directories rather than `/test/project`, because the provider now resolves
 * `node_modules/.bin/eslint` from the filesystem BEFORE it spawns anything -- so a
 * fictional root would make every test below a refusal.
 *
 * Only the RESOLUTION is real: `spawnSync` is still mocked, so no eslint ever runs.
 *
 * `bareRoot` has no shim, and the walk up from it reaches the filesystem root -- so
 * these assertions fail on a machine that genuinely has `/tmp/node_modules/.bin/eslint`
 * or `/node_modules/.bin/eslint`. Deliberate: it fails loudly rather than passing
 * vacuously, and bounding the walk in the test would mean bounding it in production,
 * which is the false failure this design refuses.
 */
let installedRoot: string;
let bareRoot: string;
let CONTEXT: MeasurementContext;

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
    installedRoot = mkdtempSync(path.join(tmpdir(), 'qg-eslint-installed-'));
    mkdirSync(path.join(installedRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(installedRoot, 'node_modules', '.bin', 'eslint'), '#!/bin/sh\n');
    bareRoot = mkdtempSync(path.join(tmpdir(), 'qg-eslint-bare-'));
    CONTEXT = { ...BASE_CONTEXT, projectRoot: installedRoot };
  });

  afterEach(() => {
    rmSync(installedRoot, { recursive: true, force: true });
    rmSync(bareRoot, { recursive: true, force: true });
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
    // 1038 real findings once arrived as roughly 1 MiB of truncated JSON and
    // were reported as zero errors, which passed an `eslint.errors: 0` ceiling.
    it('reports truncated output as a failure rather than zero findings', async () => {
      await mockEslint({ stdout: 'x'.repeat(CONTEXT.maxBufferBytes + 1), status: null });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('output-truncated');
      expect(result.error.dimension).toBe('eslint');
      expect(result.error.evidence.stdoutBytes).toBe(CONTEXT.maxBufferBytes + 1);
    });

    it('reports a killed process as a failure rather than zero findings', async () => {
      await mockEslint({ stdout: '', status: null, signal: 'SIGSEGV' });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('crashed');
    });

    it('reports unparseable output with the evidence needed to diagnose it', async () => {
      // Exit 1 (a declared success code) so the classifier passes it through
      // and the JSON parse is what actually fails.
      await mockEslint({ stdout: 'Error: cannot find config', stderr: 'boom', status: 1 });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('unparseable-output');
      expect(result.error.evidence.exitCode).toBe(1);
      expect(result.error.evidence.stderrExcerpt).toBe('boom');
      expect(result.error.evidence.command).toContain('eslint');
    });

    // eslint exits 2 with EMPTY stdout when its config is broken -- verified by
    // running it against a malformed config. Before this was fixed, exit 2 was
    // treated as success, '' became '[]', and the provider reported a clean
    // project that had never been linted.
    it('reports eslint\'s fatal exit 2 as a failure, not a clean project', async () => {
      await mockEslint({ stdout: '', stderr: 'Invalid config', status: 2 });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('crashed');
    });

    // Valid JSON of the wrong shape. The pre-extraction code caught this
    // because parse AND iteration shared one try; the extraction guarded only
    // the parse, so these threw an uncaught TypeError out of measure().
    //
    // The last three are the ones a shallower validator let through:
    //   messages:[null]   passed the array check, then threw on msg.severity
    //   absent counts     became 0 via `|| 0`, so malformed read as clean
    //   "7" as a count    made `errors` the STRING "07" by concatenation, which
    //                     rules.ts rejects as non-numeric and then SKIPS --
    //                     and a skipped ceiling passes
    it('reports well-formed JSON of the wrong shape as unparseable', async () => {
      for (const stdout of [
        '{}',
        '"a string"',
        '[{"filePath":"x.ts","errorCount":7,"warningCount":0}]',
        '[{"filePath":"x.ts","errorCount":1,"warningCount":0,"messages":null}]',
        '[null]',
        '[{"filePath":"x.ts","errorCount":1,"warningCount":0,"messages":[null]}]',
        '[{"filePath":"x.ts","messages":[]}]',
        '[{"filePath":"x.ts","errorCount":"7","warningCount":0,"messages":[]}]',
        '[{"filePath":"x.ts","errorCount":1,"warningCount":0,"messages":[{"ruleId":"r","message":"m"}]}]',
      ]) {
        await mockEslint({ stdout, status: 1 });

        let result;
        expect(() => {
          result = eslintLintProvider.measure(CONTEXT);
        }, `must not throw for ${stdout}`).not.toThrow();

        expect(isErr(result!), stdout).toBe(true);
        if (isErr(result!)) expect(result!.error.kind).toBe('unparseable-output');
      }
    });

    // This injects an ENOENT object, and it exercises classifyProcessOutput's branch
    // correctly -- but a real missing launcher does not produce one, because this
    // provider spawns with `shell: true`. MEASURED with the provider's exact options:
    // `spawnSync('definitely-not-a-real-launcher-47', [...], {shell: true})` gave status
    // **127**, signal null, error **undefined** and `/bin/sh: line 1: ...: command not
    // found` on stderr, which classifies as `crashed`. The companion test below pins
    // that reality so the two are not confused.
    it('reports a missing binary as tool-missing', async () => {
      const enoent = Object.assign(new Error('spawnSync npx ENOENT'), { code: 'ENOENT' });
      await mockEslint({ error: enoent, status: null, stdout: '' });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('tool-missing');
    });

    it('reports a launcher that is not on PATH as crashed, since shell:true makes it 127', async () => {
      await mockEslint({
        status: 127,
        stdout: '',
        stderr: '/bin/sh: line 1: npx: command not found\n',
        error: undefined,
      });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('crashed');
    });
  });

  describe('the missing-eslint pre-flight (backlog #47)', () => {
    it('refuses with tool-missing when the project has no eslint, without spawning anything', async () => {
      // The launcher does not FAIL on an absent binary, it SUBSTITUTES one. Reproduced
      // in a directory holding nothing but a package.json, an eslint.config.mjs and
      // src/a.js: `npx eslint --format json src/` exited 0 with a complete per-file
      // report, errorCount 0, from eslint v10.8.1 -- and `npx --no-install` and
      // `bunx --no-install` did exactly the same, out of their machine-global caches.
      //
      // Not spawning is also what keeps a missing linter from spending the lint budget:
      // `npx --no-install` for an absent binary still does a packument GET.
      await mockEslint({ stdout: FINDINGS, status: 1 });

      const result = eslintLintProvider.measure({ ...BASE_CONTEXT, projectRoot: bareRoot });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('tool-missing');
      expect(result.error.dimension).toBe('eslint');

      const { spawnSync } = await import('child_process');
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('names the package, the remedy and the detected manager in the refusal', () => {
      writeFileSync(path.join(bareRoot, 'eslint.config.mjs'), 'export default [];\n');

      const npmResult = eslintLintProvider.measure({ ...BASE_CONTEXT, projectRoot: bareRoot });
      expect(isErr(npmResult)).toBe(true);
      if (!isErr(npmResult)) return;
      expect(npmResult.error.message).toContain('npm install --save-dev eslint');
      expect(npmResult.error.message).toContain('node_modules/.bin/eslint');
      expect(npmResult.error.message).toContain(bareRoot);
      expect(npmResult.error.message).toContain('QUALITY_PACKAGE_MANAGER');

      // A refusal that tells a bun project to run `npm install` is the kind of
      // not-quite-right advice that makes an adopter stop reading the loud channel.
      const bunResult = eslintLintProvider.measure({
        ...BASE_CONTEXT,
        projectRoot: bareRoot,
        packageManager: { manager: 'bun', reason: 'bun.lock present' },
      });
      expect(isErr(bunResult)).toBe(true);
      if (!isErr(bunResult)) return;
      expect(bunResult.error.message).toContain('bun add --dev eslint');
    });

    it('does not tell a project with no eslint config to install a linter it rejected', () => {
      // A Biome or oxlint project has no eslint config and no eslint, and the honest
      // statement is that there is nothing here for this dimension to measure -- not
      // "install eslint". Still a refusal, because it is still not a zero.
      //
      // The message must also not offer a remedy that does nothing for them: "drop the
      // eslint.* rule from rules.json" is empty advice to a project that has no such
      // rule, so it says what the failure actually costs (reported every run, run not
      // cached, no opt-out) rather than pretending there is a switch.
      const result = eslintLintProvider.measure({ ...BASE_CONTEXT, projectRoot: bareRoot });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('tool-missing');
      expect(result.error.message).toContain('no eslint config');
      expect(result.error.message).toContain('does not fail the gate unless');
      expect(result.error.message).toContain('no way to switch the eslint dimension off');
      expect(result.error.message).not.toContain('It does have an eslint config');
    });

    it('claims report evidence for the pre-flight refusal, listing every path searched', () => {
      // No process evidence for a spawn that never happened: claiming an exit code here
      // would be a lie in the one field an investigator trusts.
      const result = eslintLintProvider.measure({ ...BASE_CONTEXT, projectRoot: bareRoot });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      const evidence = result.error.evidence;
      expect(evidence.via).toBe('report');
      expect(evidence.elapsedMs).toBe(0);
      if (evidence.via !== 'report') return;
      expect(evidence.attempts[0].path).toBe(
        path.join(bareRoot, 'node_modules', '.bin', 'eslint')
      );
      expect(evidence.attempts[0].outcome).toBe('absent');
      expect(evidence.attempts[0].existed).toBe(false);
      // One per ancestor, ending at the filesystem root.
      expect(evidence.attempts[evidence.attempts.length - 1].path).toBe(
        path.join(path.parse(bareRoot).root, 'node_modules', '.bin', 'eslint')
      );
    });

    it('reports a nonexistent project root as such, not as a missing eslint', () => {
      const missing = path.join(bareRoot, 'pacakges', 'web');

      const result = eslintLintProvider.measure({ ...BASE_CONTEXT, projectRoot: missing });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.message).toContain('the project root does not exist');
      expect(result.error.message).toContain(missing);
      // Installing eslint does not fix a mistyped path, so the remedy must not say to.
      expect(result.error.message).not.toContain('--save-dev eslint');
    });

    it('still invokes a locally-installed eslint unchanged, with the flag before the binary', async () => {
      await mockEslint({ stdout: FINDINGS, status: 1 });

      const result = eslintLintProvider.measure(CONTEXT);

      const { spawnSync } = await import('child_process');
      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(spawnSync).toHaveBeenCalledWith(
        'npx',
        ['--no-install', 'eslint', '--format', 'json', 'src/'],
        expect.objectContaining({ cwd: installedRoot, timeout: 120_000, maxBuffer: 1024 })
      );
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value.metrics).toEqual({ errors: 3, warnings: 1, rootCauses: 2 });
    });

    it('relabels a launcher refusal as tool-missing rather than unparseable output', async () => {
      // Both launchers refuse with exit **1**, which is inside ESLINT_SUCCESS_EXIT_CODES
      // because 1 is also how eslint reports findings -- so no exit-code check catches
      // this and the run lands in the empty-stdout guard, one step from being called a
      // formatter problem.
      const wordings = [
        'npm error npx canceled due to missing packages and no YES option: ["eslint@9.31.0"]',
        "error: Could not find an existing 'eslint' binary to run. Stopping because " +
          '--no-install was passed.',
      ];

      for (const stderr of wordings) {
        await mockEslint({ stdout: '', stderr, status: 1 });
        const result = eslintLintProvider.measure(CONTEXT);

        expect(isErr(result), stderr).toBe(true);
        if (!isErr(result)) return;
        expect(result.error.kind, stderr).toBe('tool-missing');
        // The shim the pre-flight DID find is the whole diagnostic value.
        expect(result.error.message).toContain(
          path.join(installedRoot, 'node_modules', '.bin', 'eslint')
        );
      }
    });

    it('keeps an empty report with unrelated stderr as unparseable-output', async () => {
      // The paired control. A relabel that fired always would make every genuine empty
      // report read as a missing tool, which trains an adopter to ignore the channel.
      await mockEslint({ stdout: '', stderr: 'Segmentation fault\n', status: 0 });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('unparseable-output');
    });
  });

  describe('preserved pre-extraction behaviour', () => {
    // This previously asserted the OPPOSITE -- that clean-exit empty output is
    // zero findings -- which locked in the vacuous pass rather than testing
    // anything. eslint's JSON formatter is `JSON.stringify(results)` and a
    // wholly clean project still emits a full per-file report, so empty stdout
    // cannot be a legitimate clean result. Verified against eslint 9.
    it('treats clean-exit empty output as a failure, not zero findings', async () => {
      await mockEslint({ stdout: '', status: 0 });

      const result = eslintLintProvider.measure(CONTEXT);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.kind).toBe('unparseable-output');
    });

    it('accepts a genuinely clean report', async () => {
      // What eslint actually emits for a clean file -- the case the empty-stdout
      // check must not break.
      await mockEslint({
        stdout: JSON.stringify([
          { filePath: '/x/src/a.js', messages: [], errorCount: 0, warningCount: 0 },
        ]),
        status: 0,
      });

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
        ['--no-install', 'eslint', '--format', 'json', 'src/'],
        expect.objectContaining({
          cwd: installedRoot,
          timeout: 120_000,
          maxBuffer: 1024,
        })
      );
    });
  });
});
