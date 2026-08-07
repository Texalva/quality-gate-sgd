/**
 * Package manager detection and command construction.
 *
 * Real temporary directories rather than a mocked `fs`. Detection is entirely a
 * question of which files exist, so mocking `existsSync` would leave the test
 * asserting against its own model of the filesystem -- and the precedence rules
 * below are exactly where such a model drifts from the real one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  binaryCommand,
  detectPackageManager,
  detectTypecheckScript,
  manifestDefinesScript,
  MISSING_SCRIPT_PATTERN,
  PACKAGE_MANAGER_ENV_VAR,
  readEntryManager,
  scriptCommand,
  TYPECHECK_SCRIPT_ENV_VAR,
  type RunnerSelection,
} from '../src/runner.js';

let root: string;
const savedOverride = process.env[PACKAGE_MANAGER_ENV_VAR];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'qg-runner-'));
  delete process.env[PACKAGE_MANAGER_ENV_VAR];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedOverride === undefined) delete process.env[PACKAGE_MANAGER_ENV_VAR];
  else process.env[PACKAGE_MANAGER_ENV_VAR] = savedOverride;
});

const touch = (name: string, contents = '') => writeFileSync(path.join(root, name), contents);
const manifest = (obj: unknown) => touch('package.json', JSON.stringify(obj));

describe('detectPackageManager', () => {
  describe('the override', () => {
    it('wins over every other signal', () => {
      // Everything on disk says npm; the override still decides.
      manifest({ packageManager: 'npm@10.2.0' });
      touch('package-lock.json');
      process.env[PACKAGE_MANAGER_ENV_VAR] = 'bun';

      const selection = detectPackageManager(root);
      expect(selection.manager).toBe('bun');
      expect(selection.reason).toContain(PACKAGE_MANAGER_ENV_VAR);
    });

    it('refuses a manager this tool cannot run, rather than falling back to npm', () => {
      // Falling back would silently answer a different question than the one asked.
      process.env[PACKAGE_MANAGER_ENV_VAR] = 'pnpm';
      expect(() => detectPackageManager(root)).toThrow(/pnpm/);
      expect(() => detectPackageManager(root)).toThrow(new RegExp(PACKAGE_MANAGER_ENV_VAR));
    });

    it('names the values it does accept, so the refusal is actionable', () => {
      process.env[PACKAGE_MANAGER_ENV_VAR] = 'yarn';
      expect(() => detectPackageManager(root)).toThrow(/npm and bun|bun and npm/);
    });

    it('ignores an empty or whitespace value instead of refusing it', () => {
      // `export QUALITY_PACKAGE_MANAGER=` is an unset variable in practice, not a
      // request for a manager named "". Refusing it would break a shell that
      // blanks its environment rather than unsetting it.
      touch('bun.lock');
      process.env[PACKAGE_MANAGER_ENV_VAR] = '  ';
      expect(detectPackageManager(root).manager).toBe('bun');
    });
  });

  describe('the packageManager manifest field', () => {
    it('reads bun from a corepack-style value', () => {
      manifest({ packageManager: 'bun@1.3.14' });
      expect(detectPackageManager(root)).toMatchObject({ manager: 'bun' });
    });

    it('reads npm, and beats a bun lockfile left in the tree', () => {
      manifest({ packageManager: 'npm@10.2.0' });
      touch('bun.lock');
      expect(detectPackageManager(root).manager).toBe('npm');
    });

    it('falls through for a manager this tool does not spawn', () => {
      // pnpm and yarn run package.json scripts fine under `npm run`, so they get
      // the npm path rather than a refusal. See the module comment.
      manifest({ packageManager: 'pnpm@9.1.0' });
      expect(detectPackageManager(root).manager).toBe('npm');
    });

    it('falls through rather than throwing on a package.json it cannot parse', () => {
      touch('package.json', '{ not json');
      touch('bun.lock');
      expect(detectPackageManager(root).manager).toBe('bun');
    });

    it('ignores a non-string field', () => {
      manifest({ packageManager: { name: 'bun' } });
      expect(detectPackageManager(root).manager).toBe('npm');
    });
  });

  describe('lockfiles', () => {
    it('detects bun.lock', () => {
      touch('bun.lock');
      expect(detectPackageManager(root)).toMatchObject({
        manager: 'bun',
        reason: 'bun.lock present',
      });
    });

    it('detects the pre-1.2 binary bun.lockb', () => {
      touch('bun.lockb');
      expect(detectPackageManager(root).manager).toBe('bun');
    });

    it('detects package-lock.json', () => {
      touch('package-lock.json');
      expect(detectPackageManager(root).manager).toBe('npm');
    });

    it('prefers bun when both lockfiles are present', () => {
      // A package-lock.json left behind by a migration to bun is common and
      // harmless; a bun.lock only appears if someone ran bun.
      touch('package-lock.json');
      touch('bun.lock');
      expect(detectPackageManager(root).manager).toBe('bun');
    });
  });

  describe('bunfig.toml', () => {
    it('selects bun when nothing has been installed yet', () => {
      touch('bunfig.toml', '[install]\nminimumReleaseAge = 604800\n');
      expect(detectPackageManager(root).manager).toBe('bun');
    });

    it('loses to a lockfile, because config outlives the choice it configured', () => {
      touch('bunfig.toml');
      touch('package-lock.json');
      expect(detectPackageManager(root).manager).toBe('npm');
    });
  });

  it('defaults to npm on an empty directory, and says why', () => {
    const selection = detectPackageManager(root);
    expect(selection.manager).toBe('npm');
    expect(selection.reason).toMatch(/no bun/i);
  });
});

describe('detectTypecheckScript', () => {
  const savedScript = process.env[TYPECHECK_SCRIPT_ENV_VAR];

  beforeEach(() => {
    delete process.env[TYPECHECK_SCRIPT_ENV_VAR];
  });

  afterEach(() => {
    if (savedScript === undefined) delete process.env[TYPECHECK_SCRIPT_ENV_VAR];
    else process.env[TYPECHECK_SCRIPT_ENV_VAR] = savedScript;
  });

  it('uses the override, whatever the manifest says', () => {
    manifest({ scripts: { 'type-check': 'tsc --noEmit' } });
    process.env[TYPECHECK_SCRIPT_ENV_VAR] = 'ci:types';
    expect(detectTypecheckScript(root).script).toBe('ci:types');
  });

  it('finds `type-check`', () => {
    manifest({ scripts: { 'type-check': 'tsc --noEmit' } });
    expect(detectTypecheckScript(root)).toMatchObject({ script: 'type-check' });
  });

  // The whole point of the task: this project previously got `tool-missing` for a
  // type-check it does have.
  it('finds `typecheck`, which used to report a missing tool', () => {
    manifest({ scripts: { typecheck: 'tsc --noEmit' } });
    expect(detectTypecheckScript(root).script).toBe('typecheck');
  });

  // Apollo Client ships both, and they are NOT the same check -- its `type-check` is
  // `tsc --noEmit -p tsconfig.json` while its `typecheck` also runs a nested test
  // suite. `type-check` winning is what keeps every existing project's measurement
  // identical; the alias only rescues projects that had no `type-check` at all.
  it('prefers `type-check` when a project defines both', () => {
    manifest({ scripts: { typecheck: 'tsc -b && npm run test', 'type-check': 'tsc --noEmit' } });
    const selection = detectTypecheckScript(root);

    expect(selection.script).toBe('type-check');
    expect(selection.reason).toContain('typecheck');
    expect(selection.reason).toContain(TYPECHECK_SCRIPT_ENV_VAR);
  });

  // Must still name a script so the provider RUNS it and fails loudly with
  // `tool-missing`. Reporting "nothing to run" would turn a missing type-check into an
  // unmeasured dimension, which under a ceiling rule is the vacuous pass.
  it('falls back to the conventional name so the failure stays loud', () => {
    manifest({ scripts: { build: 'tsc' } });
    const selection = detectTypecheckScript(root);

    expect(selection.script).toBe('type-check');
    expect(selection.reason).toMatch(/defines none of/);
  });

  it('falls back when there is no package.json at all', () => {
    expect(detectTypecheckScript(root).script).toBe('type-check');
  });

  it('ignores a non-string script body', () => {
    manifest({ scripts: { 'type-check': { run: 'tsc' } } });
    expect(detectTypecheckScript(root).reason).toMatch(/defines none of/);
  });

  it('does not pick `build`, `tsc` or `check-types`', () => {
    // Deliberately narrow: a wrong guess here does not fail loudly, it measures the
    // wrong thing successfully.
    manifest({ scripts: { tsc: 'tsc --noEmit', 'check-types': 'tsc', build: 'tsc' } });
    expect(detectTypecheckScript(root).reason).toMatch(/defines none of/);
  });
});

/**
 * The bun fall-through, which is the sharpest vacuous pass in this area.
 *
 * `bun run <name>` for a script package.json does NOT define falls through to a
 * same-named executable in node_modules/.bin. Reproduced against bun 1.3.14: with a
 * `.bin/type-check` that prints nothing and exits 0, `bun run type-check` exited 0
 * while `npm run type-check` exited 1 with "Missing script". Exit 0 plus empty output
 * is indistinguishable from a clean project at the process level, so existence has to
 * be settled from the manifest before anything is spawned.
 */
describe('manifestDefinesScript', () => {
  it('is true for a defined script', () => {
    manifest({ scripts: { 'type-check': 'tsc --noEmit' } });
    expect(manifestDefinesScript(root, 'type-check')).toBe(true);
  });

  it('is false for a script that only exists as a node_modules binary', () => {
    manifest({ scripts: { other: 'echo hi' } });
    // The exact shape that made bun exit 0: a binary, no script.
    mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', '.bin', 'type-check'), '#!/bin/sh\nexit 0\n');

    expect(manifestDefinesScript(root, 'type-check')).toBe(false);
  });

  it('is false when there is no package.json', () => {
    expect(manifestDefinesScript(root, 'type-check')).toBe(false);
  });

  it('is false for an unparseable package.json', () => {
    touch('package.json', '{ not json');
    expect(manifestDefinesScript(root, 'type-check')).toBe(false);
  });

  it('does not treat inherited Object properties as scripts', () => {
    // `'constructor' in scripts` is true for a plain object literal, so a naive
    // existence test would run `bun run constructor`.
    manifest({ scripts: {} });
    expect(manifestDefinesScript(root, 'constructor')).toBe(false);
    expect(manifestDefinesScript(root, 'toString')).toBe(false);
  });
});

describe('readEntryManager', () => {
  it('reads an absent field as npm, which is what it meant when written', () => {
    expect(readEntryManager(undefined)).toBe('npm');
  });

  it('reads the two known managers', () => {
    expect(readEntryManager('npm')).toBe('npm');
    expect(readEntryManager('bun')).toBe('bun');
  });

  // `?? 'npm'` read an explicit null AS npm, so a bun-measured entry written by an
  // external caller with a null field could be served to an npm run.
  it('refuses an explicit null rather than reading it as npm', () => {
    expect(readEntryManager(null)).toBeUndefined();
  });

  it('refuses a manager it does not know, rather than guessing', () => {
    for (const junk of ['pnpm', 'yarn', '', 'NPM', 42, {}]) {
      expect(readEntryManager(junk)).toBeUndefined();
    }
  });
});

describe('command construction', () => {
  const npm: RunnerSelection = { manager: 'npm', reason: 'test' };
  const bun: RunnerSelection = { manager: 'bun', reason: 'test' };

  it('runs scripts through the selected manager', () => {
    expect(scriptCommand('type-check', npm)).toMatchObject({
      executable: 'npm',
      args: ['run', 'type-check'],
    });
    expect(scriptCommand('type-check', bun)).toMatchObject({
      executable: 'bun',
      args: ['run', 'type-check'],
    });
  });

  it('runs binaries through npx or bunx, not node_modules/.bin', () => {
    // The .bin shims start with `#!/usr/bin/env node`, so executing them directly
    // needs node on PATH -- which defeats the point on a bun-only machine.
    expect(binaryCommand('eslint', ['--format', 'json'], npm).executable).toBe('npx');
    expect(binaryCommand('eslint', ['--format', 'json'], bun).executable).toBe('bunx');
    expect(binaryCommand('eslint', ['--format', 'json'], bun).args).toEqual([
      'eslint',
      '--format',
      'json',
    ]);
  });

  it('keeps display exactly reproducible, with no detection reason appended', () => {
    // Regression guard. The reason WAS appended here, which quietly turned every
    // command in failure evidence into something that cannot be pasted into a
    // shell -- against the whole point of reporting a reproduction command.
    const verbose: RunnerSelection = { manager: 'npm', reason: 'package-lock.json present' };
    expect(scriptCommand('build', verbose).display).toBe('npm run build');
    expect(binaryCommand('eslint', ['src/'], verbose).display).toBe('npx eslint src/');
  });
});

describe('MISSING_SCRIPT_PATTERN', () => {
  // Both wordings captured from the real tools, npm 10 and bun 1.3.14. This only
  // ever LABELS a failure the exit code already established, so a reworded message
  // costs a label and never a verdict.
  it("matches npm's wording", () => {
    expect(MISSING_SCRIPT_PATTERN.test('npm error Missing script: "type-check"')).toBe(true);
  });

  it("matches bun's wording", () => {
    expect(MISSING_SCRIPT_PATTERN.test('error: Script not found "type-check"')).toBe(true);
  });

  it('does not match ordinary compiler output', () => {
    expect(MISSING_SCRIPT_PATTERN.test("src/a.ts(1,1): error TS2304: Cannot find name 'x'.")).toBe(
      false
    );
  });
});
