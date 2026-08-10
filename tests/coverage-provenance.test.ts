/**
 * Coverage report provenance
 * ==========================
 * REAL git repositories in mkdtemp, and `fs` is deliberately NOT mocked here --
 * unlike tests/metrics.test.ts and tests/cache.test.ts, which stub `fs` and
 * `child_process` module-wide and answer git by call sequence. Everything this module
 * decides is a fact about a working tree (what `git diff` says about a commit that
 * exists, what `git status` says about a file's visibility, whether a rewrite moved an
 * mtime), and a stubbed answer to those questions would only test the stub.
 *
 * The two directions are asserted with equal weight, because both have killed a design
 * for this feature: a FALSE PASS (a report vouched for over code it never saw) and a
 * FALSE FAIL (a valid report called stale after a README edit, a commit, a branch
 * switch or a chmod).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import { getConfig, resetConfig } from '../src/config.js';
import { codeStateDigest, getCacheKey } from '../src/cache.js';
import { evaluateRules } from '../src/rules.js';
import {
  describeUnmeasured,
  measureCoverage,
  extractAllMetricsAndCoverageProvenance,
} from '../src/metrics.js';
import {
  PROVENANCE_SIDECAR_FILE,
  coverageProvenanceFailures,
  coverageProvenanceUnevaluated,
  snapshotCoverageStateBeforeScripts,
  stampAllCoverageSummaries,
  stampCoverageSummariesRewrittenDuringRun,
  suitesWithNumbers,
  verifyCoverageProvenance,
} from '../src/coverage-provenance.js';
import type { Metrics, QualityRules } from '../src/types.js';

let root: string;
const savedEnv = { ...process.env };

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();

const write = (relative: string, body: string): void => {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
};

const SUMMARY = (pct: number): string =>
  JSON.stringify({
    total: {
      statements: { total: 100, covered: pct, skipped: 0, pct },
      branches: { total: 100, covered: pct, skipped: 0, pct },
      functions: { total: 100, covered: pct, skipped: 0, pct },
      lines: { total: 100, covered: pct, skipped: 0, pct },
    },
  });

/**
 * A repository with `src/`, a coverage report, and a choice about whether git can see
 * the coverage directory -- which is the axis the cache-key constraint lives on.
 */
function makeProject(options: {
  readonly ignoreCoverage: boolean;
  readonly report?: string;
  readonly existingCoverageGitignore?: string;
} = { ignoreCoverage: true }): void {
  root = mkdtempSync(path.join(tmpdir(), 'qg-prov-'));
  write('src/a.ts', 'export const a = 1;\n');
  write('tests/a.test.ts', 'export const t = 1;\n');
  write('package.json', '{"name":"subject","version":"1.0.0"}\n');
  write('.gitignore', options.ignoreCoverage ? 'node_modules/\ncoverage/\n' : 'node_modules/\n');
  if (options.report !== undefined) {
    write('coverage/coverage-summary.json', options.report);
  }
  if (options.existingCoverageGitignore !== undefined) {
    write('coverage/.gitignore', options.existingCoverageGitignore);
  }

  git('init', '-q');
  git('config', 'user.email', 'harness@example.com');
  git('config', 'user.name', 'Harness');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

  process.env.QUALITY_PROJECT_ROOT = root;
  process.env.QUALITY_COVERAGE_LAMBDA_DIR = 'coverage-lambda-absent';
  resetConfig();
}

const sidecarPath = (): string => path.join(root, 'coverage', PROVENANCE_SIDECAR_FILE);
const summaryPath = (): string => path.join(root, 'coverage', 'coverage-summary.json');

const readSidecarFile = (): Record<string, unknown> =>
  JSON.parse(readFileSync(sidecarPath(), 'utf-8')) as Record<string, unknown>;

/** Stamp as `run` would, having seen no report before the scripts ran. */
const stampAsRun = (): void => {
  const snapshot = snapshotCoverageStateBeforeScripts();
  // The report is REWRITTEN after the snapshot, which is what arms the stamp.
  writeFileSync(summaryPath(), readFileSync(summaryPath(), 'utf-8'));
  stampCoverageSummariesRewrittenDuringRun(snapshot, 'run');
};

const rulesWithFloor = (metricPath: string): QualityRules => ({
  version: '1.0.0',
  description: 'grades one coverage metric',
  rules: { floors: { [metricPath]: 5 }, requiredScripts: [] },
});

beforeEach(() => {
  process.env = { ...savedEnv };
});

afterEach(() => {
  process.env = { ...savedEnv };
  resetConfig();
  if (root !== undefined && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// The hard constraint: stamping must not move the cache key
// ===========================================================================

describe('stamping and the cache key', () => {
  /**
   * The brief's hard constraint, and it is not hypothetical. MEASURED against
   * dist/cache.js on a project whose `coverage/` is TRACKED and not gitignored, clean
   * tree: writing the sidecar alone moved the key from `209fcf90...` (isWIP false) to
   * `wip:209fcf90...` and `git status --porcelain` from '' to
   * '?? coverage/.quality-gate-provenance.json'. That is not a cosmetic regression --
   * a clean tree keys on the bare commit hash and `findBaselineEntry` resolves
   * baselines BY commit hash, so a permanently-WIP key costs every monotonic rule its
   * baseline.
   */
  it('does not move the cache key, in a project whose coverage directory git can see', () => {
    makeProject({ ignoreCoverage: false, report: SUMMARY(80) });

    const before = getCacheKey();
    expect(before.isWIP).toBe(false);

    stampAsRun();
    expect(existsSync(sidecarPath())).toBe(true);

    const after = getCacheKey();
    expect(after.key).toBe(before.key);
    expect(after.isWIP).toBe(false);
  });

  it('does not move the cache key when the coverage directory is gitignored', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });

    const before = getCacheKey();
    stampAsRun();
    const after = getCacheKey();

    expect(after.key).toBe(before.key);
    expect(after.isWIP).toBe(before.isWIP);
  });

  it('does not move the cache key on an already-dirty tree', () => {
    makeProject({ ignoreCoverage: false, report: SUMMARY(80) });
    write('src/a.ts', 'export const a = 2;\n');

    const before = getCacheKey();
    expect(before.isWIP).toBe(true);

    stampAsRun();

    expect(getCacheKey().key).toBe(before.key);
  });

  /**
   * The nested .gitignore has to hide the sidecar AND itself, without blinding git to
   * the project's own files. The second half is what makes it safe to write at all.
   */
  it('hides the sidecar from git while leaving tracked files visible', () => {
    makeProject({ ignoreCoverage: false, report: SUMMARY(80) });

    stampAsRun();
    expect(git('status', '--porcelain')).toBe('');

    writeFileSync(summaryPath(), SUMMARY(81));
    expect(git('status', '--porcelain')).toBe('M coverage/coverage-summary.json');
  });

  /**
   * A `.gitignore` the project wrote is never edited. The cost is stated rather than
   * papered over: the sidecar stays visible, the key goes WIP, and the VERDICT is
   * still correct -- which is the part that must not depend on the tree being clean.
   */
  it('never touches an existing coverage/.gitignore, and still verifies', () => {
    makeProject({
      ignoreCoverage: false,
      report: SUMMARY(80),
      existingCoverageGitignore: '# the project owns this file\ntmp/\n',
    });
    const original = readFileSync(path.join(root, 'coverage', '.gitignore'), 'utf-8');

    stampAsRun();

    expect(readFileSync(path.join(root, 'coverage', '.gitignore'), 'utf-8')).toBe(original);
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');
  });
});

// ===========================================================================
// STALE: the false-pass direction
// ===========================================================================

describe('a report stamped for a different generation of the code', () => {
  it('is stale, names the file, and fails every rule that grades the suite', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    stampAsRun();

    write('src/a.ts', 'export const a = 2;\nexport const b = 3;\n');

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(verdicts[0].kind).toBe('stale');

    const failures = coverageProvenanceFailures(verdicts);
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe('stale-report');
    expect(failures[0].dimension).toBe('coverage.unit');
    expect(failures[0].message).toContain('src/a.ts');

    const metrics: Metrics = {
      scripts: {},
      coverage: { unit: { statements: 80, branches: 80, functions: 80, lines: 80 } },
      measurementFailures: [...failures],
    };

    expect(evaluateRules(rulesWithFloor('coverage.unit.statements'), metrics).status).toBe('fail');
    expect(
      evaluateRules(rulesWithFloor('coverage.unit.statements'), metrics).failedRules.map((f) => f.rule)
    ).toContain('coverage.unit.measurement');

    // The derivation edge: a union floor grades the unit measurement too.
    const unionMetrics: Metrics = {
      ...metrics,
      coverage: { ...metrics.coverage, union: { statements: 80, branches: 80, functions: 80, lines: 80 } },
    };
    expect(evaluateRules(rulesWithFloor('coverage.union.statements'), unionMetrics).status).toBe('fail');
  });

  /**
   * The case a cache-key STRING comparison structurally cannot catch, and the reason
   * the sidecar records a commit plus a digest instead of the key. MEASURED against
   * dist/cache.js: stamping on a dirty tree records a `wip:` key, and one further edit
   * produces another `wip:` key -- unequal, but nothing about two unequal working-tree
   * digests says which of them is the newer state, so the honest answer under string
   * comparison is "unverifiable" and the gate passes.
   */
  it('is stale when the stamp itself was taken on a dirty tree', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    write('src/a.ts', 'export const a = 99;\n');
    expect(getCacheKey().isWIP).toBe(true);

    stampAsRun();
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');

    write('src/a.ts', 'export const a = 99;\nexport const later = 1;\n');

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(verdicts[0].kind).toBe('stale');
    expect(coverageProvenanceFailures(verdicts)[0].message).toContain('src/a.ts');
  });

  /**
   * `git diff` cannot see an untracked file, so this is the half of the comparison
   * that stops new source appearing beside a stamped report. MEASURED: with
   * `src/new.ts` untracked, `git diff --name-only <C> -- src/` is empty while
   * `git ls-files --others --exclude-standard -- src/` reports it.
   */
  it('is stale when new source appears untracked, and not when a non-code file does', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    stampAsRun();

    write('docs/notes.md', 'not code\n');
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');

    write('src/new.ts', 'export const n = 1;\n');
    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(verdicts[0].kind).toBe('stale');
    expect(coverageProvenanceFailures(verdicts)[0].message).toContain('src/new.ts');
  });
});

// ===========================================================================
// The false-fail direction
// ===========================================================================

describe('states that must NOT be reported stale', () => {
  /**
   * Every row here moves the CACHE KEY and leaves the code identical. Under bare key
   * inequality all of them print "your coverage report describes a different
   * generation of the code" -- which is the sentence design B was rejected for, and
   * the commit row fires on every commit for exactly the projects this feature is for.
   */
  it('survives a non-code edit, a commit, a revert to identical content and a branch switch', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    stampAsRun();
    const stampedKey = getCacheKey().key;

    write('README.md', 'documentation\n');
    expect(getCacheKey().key).not.toBe(stampedKey);
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');

    git('add', '-A');
    git('commit', '-q', '-m', 'docs');
    expect(getCacheKey().key).not.toBe(stampedKey);
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');

    write('src/a.ts', 'export const a = 2;\n');
    git('commit', '-qam', 'change');
    write('src/a.ts', 'export const a = 1;\n');
    git('commit', '-qam', 'revert');
    expect(getCacheKey().key).not.toBe(stampedKey);
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');

    git('checkout', '-q', '-b', 'other');
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');
  });

  /**
   * A committed permission change. MEASURED: `git diff --name-only <C> -- src/`
   * reports src/a.ts while `git diff --raw` reports identical blob shas
   * (`:100644 100755 cb0ff5c cb0ff5c M`), so nothing about the code changed --
   * `scripts/` is in the DEFAULT pathspecs, and failing a coverage rule over a chmod
   * from a Windows checkout would be design B's false message with a new trigger.
   */
  it('survives a mode-only committed change', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    stampAsRun();

    chmodSync(path.join(root, 'src/a.ts'), 0o755);
    git('commit', '-qam', 'chmod');

    // The premise, asserted so this cannot pass for the wrong reason: the naive
    // question DOES name the file, and only the blob shas say nothing changed.
    expect(git('diff', '--name-only', 'HEAD~1', '--', 'src/')).toBe('src/a.ts');
    const raw = git('diff', '--raw', 'HEAD~1', '--', 'src/');
    const [, , srcSha, dstSha] = raw.slice(1).split('\t')[0].split(' ');
    expect(srcSha).toBe(dstSha);
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');
    expect(coverageProvenanceFailures(verifyCoverageProvenance(['coverage.unit']))).toEqual([]);
  });
});

// ===========================================================================
// UNVERIFIABLE
// ===========================================================================

describe('a report whose provenance cannot be established', () => {
  it('is unverifiable rather than stale when no sidecar exists', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(verdicts[0]).toMatchObject({ kind: 'unverifiable', why: 'no-sidecar' });
  });

  /**
   * THE POLICY, and it reversed. An unverifiable reading used to satisfy a floor: the
   * advisory printed, `status` stayed `pass`, and the build shipped on a number nothing
   * tied to the code. The reasoning was that "nobody stamped this" is not evidence the
   * numbers are WRONG -- true, and beside the point once you notice the number being
   * defended is the one deciding whether to ship.
   *
   * Asserted through `evaluateRules` rather than only on the failure list, because the
   * failure existing is not the claim. The claim is that the GATE goes red, and the
   * route from one to the other runs through `evaluateMeasurements`, which is rule-
   * scoped: an unvouched-for `coverage.lambda` on a project that grades no coverage
   * must still pass. That second half is the next test.
   */
  it('fails a floor it cannot tie to the code, under the default policy', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    const failures = coverageProvenanceFailures(verdicts, [], true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: 'provenance-unverified',
      dimension: 'coverage.unit',
    });
    expect(failures[0].message).toContain('stamp-coverage');
    expect(failures[0].message).toContain('QUALITY_COVERAGE_PROVENANCE=optional');

    const metrics: Metrics = {
      scripts: {},
      coverage: { unit: { statements: 80, branches: 80, functions: 80, lines: 80 } },
      measurementFailures: failures,
    };
    expect(evaluateRules(rulesWithFloor('coverage.unit.statements'), metrics).status).toBe('fail');

    // And the advisory does NOT also fire: one finding, one register. Saying it twice
    // is how the loud channel stops being read.
    expect(
      coverageProvenanceUnevaluated(rulesWithFloor('coverage.unit.statements'), verdicts, true)
    ).toEqual([]);
  });

  /**
   * The escape hatch, which is the whole of the previous contract preserved verbatim:
   * advisory, gate green, and (elsewhere) the run still refused as a cacheable verdict.
   * It exists so a project mid-migration can opt out rather than be stuck.
   */
  it('advises and passes under QUALITY_COVERAGE_PROVENANCE=optional', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(coverageProvenanceFailures(verdicts, [], false)).toEqual([]);

    const metrics: Metrics = {
      scripts: {},
      coverage: { unit: { statements: 80, branches: 80, functions: 80, lines: 80 } },
    };
    expect(evaluateRules(rulesWithFloor('coverage.unit.statements'), metrics).status).toBe('pass');

    const unevaluated = coverageProvenanceUnevaluated(
      rulesWithFloor('coverage.unit.statements'),
      verdicts,
      false
    );
    expect(unevaluated).toHaveLength(1);
    expect(unevaluated[0].type).toBe('unverified-provenance');
    expect(unevaluated[0].message).toContain('requiredScripts');
    expect(unevaluated[0].message).toContain('stamp-coverage');
  });

  /**
   * THE GUARD THAT HAD NO TEST. Reached by stamping over uncommitted code and then
   * reverting it: `digestOfUnchangedCodeState()` no longer reproduces the digest in the
   * sidecar, while `contentChangedPaths` and `listUntrackedCodeFiles` are both EMPTY
   * because the tree is now identical to the recorded commit.
   *
   * Without the `digestOfUnchangedCodeState()` comparison the function falls through to
   * `verified` -- vouching for a generation of the code that exists nowhere in the tree
   * -- and before this test, deleting that comparison broke nothing. It has to be
   * `unverifiable` rather than `stale`: no content differs from the recorded commit, so
   * there is no file to name, and naming one anyway is what design B was rejected for.
   */
  it('is unverifiable when the stamped uncommitted state can no longer be reproduced', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });

    const committed = 'export const a = 1;\n';
    write('src/a.ts', 'export const a = 99;\n');
    stampAsRun();
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');

    // Revert to exactly the committed bytes. The report still describes a = 99.
    write('src/a.ts', committed);
    expect(git('status', '--porcelain', '--', 'src/')).toBe('');

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(verdicts[0]).toMatchObject({
      kind: 'unverifiable',
      why: 'stamp-state-not-reproducible',
    });
    expect(coverageProvenanceFailures(verdicts, [], true)[0]).toMatchObject({
      kind: 'provenance-unverified',
    });
  });

  /**
   * CODE MOVED WHILE THE SCRIPTS RAN, and why it must NOT fail the gate.
   *
   * The stamp positively detects that the code identity before `requiredScripts` and the
   * one after them disagree. That looks like grounds for a definite claim, and an earlier
   * revision made one -- a `code-changed-during-measurement` failure firing in both
   * provenance modes. It is not, because ONE snapshot is taken before ALL scripts and one
   * after ALL of them, so these two orderings are indistinguishable:
   *
   *   ['test:coverage', 'build']   coverage measured, THEN build rewrote src/. Bad.
   *   ['build', 'test:coverage']   build generated src/, THEN coverage measured the
   *                                final tree. Correct, common, and the shape the
   *                                promoted version hard-failed while advising the
   *                                adopter to do what they were already doing.
   *
   * So the suite gets the ADVISORY -- which carries the specific diagnostic -- and not a
   * failure, in either mode. Asserted in both directions because the false-fail half is
   * the one that killed two previous designs for this feature.
   */
  it('advises rather than fails when the code moved while the scripts ran', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });

    const snapshot = snapshotCoverageStateBeforeScripts();
    writeFileSync(summaryPath(), SUMMARY(81));
    // A `build` step that generates into src/. Whether it ran before or after the
    // coverage script is exactly what this evidence cannot say.
    write('src/generated.ts', 'export const generated = 1;\n');

    const outcomes = stampCoverageSummariesRewrittenDuringRun(snapshot, 'run');
    expect(outcomes.find((outcome) => outcome.suite === 'coverage.unit')).toMatchObject({
      kind: 'cannot-stamp',
      reason: 'code-changed-during-measurement',
    });

    // No sidecar survives, so verification on its own can only say "nobody stamped it".
    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(verdicts[0]).toMatchObject({ kind: 'unverifiable' });

    const graded = rulesWithFloor('coverage.unit.statements');
    for (const provenanceRequired of [true, false]) {
      expect(coverageProvenanceFailures(verdicts, outcomes, provenanceRequired)).toEqual([]);

      // And the advisory carries it in BOTH modes -- the exact complement. Without this
      // the strict-mode run would say nothing at all about an ungrounded number.
      const unevaluated = coverageProvenanceUnevaluated(
        graded,
        verdicts,
        provenanceRequired,
        outcomes
      );
      expect(unevaluated).toHaveLength(1);
      expect(unevaluated[0].type).toBe('unverified-provenance');
    }

    const metrics: Metrics = {
      scripts: {},
      coverage: { unit: { statements: 81, branches: 81, functions: 81, lines: 81 } },
    };
    expect(evaluateRules(graded, metrics).status).toBe('pass');
  });

  /**
   * The other `cannot-stamp` reasons are absences too -- git could not answer, or a
   * read-only artifact mount refused the write -- but unlike codegen they say nothing
   * about the code having moved, so strict mode DOES fail them: the report is simply
   * unvouched-for, and `stamp-coverage` from a writable step is a remedy that works.
   */
  it('still fails an unvouched-for report when the stamp failed for an unrelated reason', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    const cannotWrite = [
      {
        kind: 'cannot-stamp' as const,
        suite: 'coverage.unit' as const,
        summaryPath: summaryPath(),
        why: 'the sidecar could not be written (EROFS)',
        reason: 'code-state-unknown' as const,
      },
    ];

    expect(coverageProvenanceFailures(verdicts, cannotWrite, false)).toEqual([]);
    expect(coverageProvenanceFailures(verdicts, cannotWrite, true)[0]).toMatchObject({
      kind: 'provenance-unverified',
    });

    // Complement holds here too: where the failure fired, the advisory is silent.
    expect(
      coverageProvenanceUnevaluated(
        rulesWithFloor('coverage.unit.statements'),
        verdicts,
        true,
        cannotWrite
      )
    ).toEqual([]);
  });

  /**
   * `[]` and `undefined` are DIFFERENT rulesets, because every caller resolves scripts
   * as `requiredScripts || ['quality']` and `[]` is truthy. An empty array runs nothing;
   * an omitted key silently runs `quality`. The advisory used to tell both readers "the
   * gate never ran your coverage tool", which is false for the second and sends them
   * looking for a configuration problem that is not there.
   */
  it('does not tell a ruleset that omits requiredScripts that no script ran', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    const verdicts = verifyCoverageProvenance(['coverage.unit']);

    const withEmpty: QualityRules = {
      version: '1.0.0',
      description: 'empty array',
      rules: { floors: { 'coverage.unit.statements': 5 }, requiredScripts: [] },
    };
    const omitted: QualityRules = {
      version: '1.0.0',
      description: 'key absent',
      rules: { floors: { 'coverage.unit.statements': 5 } },
    };

    const emptyMessage = coverageProvenanceUnevaluated(withEmpty, verdicts, false)[0].message;
    expect(emptyMessage).toContain('`requiredScripts: []`');
    expect(emptyMessage).toContain('ran no scripts at all');

    const omittedMessage = coverageProvenanceUnevaluated(omitted, verdicts, false)[0].message;
    expect(omittedMessage).toContain('`requiredScripts` is absent');
    expect(omittedMessage).toContain('names no coverage script');
    // The false sentences, in each of their spellings. The third is subtler than the
    // other two: the advisory also fires when the script DID rewrite the report and the
    // stamp was then refused, so asserting anything about what the script wrote would be
    // false in that case. Only facts about the RULESET may be stated here.
    expect(omittedMessage).not.toContain('never ran your coverage tool');
    expect(omittedMessage).not.toContain('ran no scripts at all');
    expect(omittedMessage).not.toContain('did not write this report');
  });

  /**
   * The default is read from config, and the ONLY spelling that turns it off is
   * `optional`. A typo leaves enforcement on, which is the same asymmetry
   * `QUALITY_COVERAGE_REQUIRED` uses and for the same reason: reading a typo as "off"
   * silently restores the vacuous pass and gives the reader no sign of it.
   */
  it('requires provenance by default, and only the word `optional` disables it', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    expect(getConfig().coverage.provenanceRequired).toBe(true);

    for (const spelling of ['optional', 'OPTIONAL', ' optional ']) {
      process.env.QUALITY_COVERAGE_PROVENANCE = spelling;
      resetConfig();
      expect(getConfig().coverage.provenanceRequired).toBe(false);
    }

    for (const typo of ['false', '0', 'off', 'no', 'optionaI', '']) {
      process.env.QUALITY_COVERAGE_PROVENANCE = typo;
      resetConfig();
      expect(getConfig().coverage.provenanceRequired).toBe(true);
    }
  });

  /**
   * The advisory is RULE-SCOPED. Without this, every build-only project with a stray
   * `coverage/` directory would print a coverage advisory it has no rule for and would
   * stop caching verdicts.
   */
  it('says nothing when no rule reads the suite', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    const verdicts = verifyCoverageProvenance(['coverage.unit']);

    const buildOnly: QualityRules = {
      version: '1.0.0',
      description: 'gates the build, never asked for coverage',
      rules: { ceilings: { 'typescript.errors': 0 }, requiredScripts: [] },
    };

    expect(coverageProvenanceUnevaluated(buildOnly, verdicts)).toEqual([]);
  });

  /**
   * PARSE AT THE BOUNDARY. The sidecar is a file the tool did not necessarily write
   * and `codeCommit` is interpolated into a git command, so anything that is not a
   * 40-hex commit and a 64-hex digest has to be refused before a shell sees it.
   */
  it('refuses a sidecar it cannot trust, and never lets its contents reach a shell', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    const sentinel = path.join(root, 'INJECTED');
    const valid = { ...({} as Record<string, unknown>) };
    stampAsRun();
    Object.assign(valid, readSidecarFile());

    const rows: ReadonlyArray<{ readonly name: string; readonly body: string }> = [
      { name: 'empty object', body: '{}' },
      { name: 'future schema', body: JSON.stringify({ ...valid, schema: 2 }) },
      { name: 'another suite', body: JSON.stringify({ ...valid, suite: 'coverage.lambda' }) },
      { name: 'another summary file', body: JSON.stringify({ ...valid, summaryFile: 'other.json' }) },
      { name: 'null commit', body: JSON.stringify({ ...valid, codeCommit: null }) },
      {
        name: 'command substitution',
        body: JSON.stringify({ ...valid, codeCommit: `$(touch ${sentinel})` }),
      },
      {
        name: 'shell separator',
        body: JSON.stringify({ ...valid, codeCommit: `abc; touch ${sentinel}` }),
      },
      { name: 'short digest', body: JSON.stringify({ ...valid, codeStateDigest: 'abc' }) },
      { name: 'unknown stamper', body: JSON.stringify({ ...valid, stampedBy: 'somebody-else' }) },
      { name: 'not json', body: '{"schema": 1, ' },
    ];

    for (const row of rows) {
      writeFileSync(sidecarPath(), row.body);
      const verdict = verifyCoverageProvenance(['coverage.unit'])[0];
      expect(verdict.kind, row.name).toBe('unverifiable');
      if (verdict.kind === 'unverifiable') {
        expect(verdict.why, row.name).toBe('sidecar-unusable');
        expect(verdict.detail.length, row.name).toBeGreaterThan(0);
      }
      expect(existsSync(sentinel), row.name).toBe(false);
    }
  });

  /**
   * The same refusal one layer down, because `codeStateDigest` is EXPORTED and its
   * argument reaches a shell. Two independent guards rather than one: the sidecar
   * parser refuses the value, and this refuses it again without relying on the parser
   * having run.
   */
  it('refuses to ask git about anything that is not a commit-ish', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    const sentinel = path.join(root, 'INJECTED-VIA-DIGEST');

    for (const commitish of [`$(touch ${sentinel})`, `HEAD; touch ${sentinel}`, 'refs/heads/main']) {
      const result = codeStateDigest(commitish);
      expect(result.kind, commitish).toBe('git-failed');
      expect(existsSync(sentinel), commitish).toBe(false);
    }

    // And the two forms it does accept still work.
    expect(codeStateDigest('HEAD').kind).toBe('digest');
    expect(codeStateDigest(git('rev-parse', 'HEAD')).kind).toBe('digest');
  });

  /**
   * The laundering path this closes: stamp a report, then edit its numbers. The code
   * identity still matches, so without the recorded report digest the doctored file
   * would be vouched for.
   */
  it('is unverifiable when the report was rewritten after the stamp', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    stampAsRun();
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');

    writeFileSync(summaryPath(), SUMMARY(99));

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(verdicts[0]).toMatchObject({ kind: 'unverifiable', why: 'report-rewritten-since-stamp' });

    // UNVERIFIABLE, not stale, even though a doctored report is the likeliest way to
    // reach it: the sidecar describes some other file, so what this one measures is
    // unknown rather than known-wrong. Under the default policy that is still a
    // failure -- it just says the honest thing about why.
    expect(coverageProvenanceFailures(verdicts, [], false)).toEqual([]);
    expect(coverageProvenanceFailures(verdicts, [], true)[0]).toMatchObject({
      kind: 'provenance-unverified',
    });
  });

  /** A shallow clone, or a commit that was rebased away. Never a stale claim. */
  it('is unverifiable when the recorded commit is not in this repository', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    stampAsRun();

    const sidecar = readSidecarFile();
    writeFileSync(
      sidecarPath(),
      JSON.stringify({ ...sidecar, codeCommit: 'a'.repeat(40) })
    );

    expect(verifyCoverageProvenance(['coverage.unit'])[0]).toMatchObject({
      kind: 'unverifiable',
      why: 'recorded-commit-unknown',
    });
  });

  /**
   * D2's caveat: `getCurrentCommitHash` throws and `computeContentHash` refuses a
   * layout that tracks no code. Neither may become a new crash path.
   */
  it('cannot verify or stamp outside a git repository, and does not throw', () => {
    root = mkdtempSync(path.join(tmpdir(), 'qg-prov-nogit-'));
    write('coverage/coverage-summary.json', SUMMARY(80));
    process.env.QUALITY_PROJECT_ROOT = root;
    process.env.QUALITY_COVERAGE_LAMBDA_DIR = 'coverage-lambda-absent';
    resetConfig();
    writeFileSync(
      sidecarPath(),
      JSON.stringify({
        schema: 1,
        suite: 'coverage.unit',
        summaryFile: 'coverage-summary.json',
        codeCommit: 'b'.repeat(40),
        codeStateDigest: 'c'.repeat(64),
        summarySha256: 'd'.repeat(64),
        stampedAt: new Date().toISOString(),
        stampedBy: 'stamp-coverage',
      })
    );

    expect(() => verifyCoverageProvenance(['coverage.unit'])).not.toThrow();
    const verdict = verifyCoverageProvenance(['coverage.unit'])[0];
    expect(verdict.kind).toBe('unverifiable');

    expect(() => stampAllCoverageSummaries('stamp-coverage')).not.toThrow();
    expect(stampAllCoverageSummaries('stamp-coverage')[0].kind).toBe('cannot-stamp');
  });

  /**
   * THE STRICT-MODE EXCEPTION, and it is not a softening of the policy. Provenance is
   * built out of git, so where `resolveCodeIdentity` cannot answer -- no repository, a
   * Docker build context that excluded `.git`, an unpacked tarball -- NOBODY can write
   * a sidecar. Failing would print a red build naming two remedies (`requiredScripts`,
   * `stamp-coverage`) that both cannot work, which is the false-fail that killed
   * designs A and B, arriving through the guard meant to prevent the opposite error.
   *
   * Caught by verify-vacuous-pass.mjs and not by any unit test, because its subject is
   * an ordinary temp directory with no `git init` -- which is exactly the shape this
   * covers. The advisory MUST still fire, or refusing to false-fail becomes silence.
   */
  it('does not fail a project that cannot stamp at all, but still says the numbers are ungrounded', () => {
    root = mkdtempSync(path.join(tmpdir(), 'qg-prov-nogit-'));
    write('src/a.ts', 'export const a = 1;\n');
    write('coverage/coverage-summary.json', SUMMARY(80));
    process.env.QUALITY_PROJECT_ROOT = root;
    process.env.QUALITY_COVERAGE_LAMBDA_DIR = 'coverage-lambda-absent';
    resetConfig();

    const verdicts = verifyCoverageProvenance(['coverage.unit']);
    expect(verdicts[0].kind).toBe('unverifiable');

    // Strict, and still no failure -- there is no action the adopter could take.
    expect(coverageProvenanceFailures(verdicts, [], true)).toEqual([]);

    const metrics: Metrics = {
      scripts: {},
      coverage: { unit: { statements: 80, branches: 80, functions: 80, lines: 80 } },
    };
    expect(evaluateRules(rulesWithFloor('coverage.unit.statements'), metrics).status).toBe('pass');

    // But the advisory is the ONLY channel left, so it has to fire in strict mode here
    // even though it is suppressed in strict mode everywhere else.
    const unevaluated = coverageProvenanceUnevaluated(
      rulesWithFloor('coverage.unit.statements'),
      verdicts,
      true
    );
    expect(unevaluated).toHaveLength(1);
    expect(unevaluated[0].type).toBe('unverified-provenance');
  });

  /**
   * A repo that tracks nothing under `codePathspecs`. The refusal lives in cache.ts
   * and is NOT duplicated here; what is asserted is that it arrives as a verdict
   * rather than as an exception.
   */
  it('cannot verify when the pathspecs track no code', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    process.env.QUALITY_CODE_PATHSPECS = 'nowhere/';
    resetConfig();
    writeFileSync(
      sidecarPath(),
      JSON.stringify({
        schema: 1,
        suite: 'coverage.unit',
        summaryFile: 'coverage-summary.json',
        codeCommit: git('rev-parse', 'HEAD'),
        codeStateDigest: 'c'.repeat(64),
        summarySha256: createHash('sha256').update(readFileSync(summaryPath())).digest('hex'),
        stampedAt: new Date().toISOString(),
        stampedBy: 'stamp-coverage',
      })
    );

    const verdict = verifyCoverageProvenance(['coverage.unit'])[0];
    expect(verdict).toMatchObject({ kind: 'unverifiable', why: 'no-code-identity' });
  });

  /**
   * `QUALITY_COVERAGE_LAMBDA_DIR=coverage` is legal -- config.ts does no distinctness
   * check -- and one sidecar cannot describe two suites. Reported as the configuration
   * collision it is, not as a corrupt file.
   */
  it('refuses to answer when both suites are configured at one directory', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    process.env.QUALITY_COVERAGE_LAMBDA_DIR = 'coverage';
    resetConfig();

    for (const verdict of verifyCoverageProvenance(['coverage.unit', 'coverage.lambda'])) {
      expect(verdict).toMatchObject({ kind: 'unverifiable', why: 'suite-directories-collide' });
    }
  });
});

// ===========================================================================
// When a stamp is written at all
// ===========================================================================

describe('the arming condition', () => {
  it('stamps a report that appeared during the run', () => {
    makeProject({ ignoreCoverage: true });
    expect(existsSync(summaryPath())).toBe(false);

    const snapshot = snapshotCoverageStateBeforeScripts();
    write('coverage/coverage-summary.json', SUMMARY(80));
    const outcomes = stampCoverageSummariesRewrittenDuringRun(snapshot, 'run');

    expect(outcomes.find((o) => o.suite === 'coverage.unit')?.kind).toBe('stamped');
    expect(verifyCoverageProvenance(['coverage.unit'])[0].kind).toBe('verified');
  });

  /**
   * A suite the run did not rewrite is left completely alone -- this run neither
   * vouches for somebody else's stamp nor destroys it. The recorded commit here is
   * well-formed but bogus, so overwriting it would be visible.
   */
  it('leaves a report the run did not rewrite exactly as it was', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    const foreign = JSON.stringify({
      schema: 1,
      suite: 'coverage.unit',
      summaryFile: 'coverage-summary.json',
      codeCommit: 'e'.repeat(40),
      codeStateDigest: 'f'.repeat(64),
      summarySha256: '0'.repeat(64),
      stampedAt: '2020-01-01T00:00:00.000Z',
      stampedBy: 'stamp-coverage',
    });
    writeFileSync(sidecarPath(), foreign);

    const snapshot = snapshotCoverageStateBeforeScripts();
    const outcomes = stampCoverageSummariesRewrittenDuringRun(snapshot, 'run');

    expect(outcomes.find((o) => o.suite === 'coverage.unit')?.kind).toBe('not-rewritten');
    expect(readFileSync(sidecarPath(), 'utf-8')).toBe(foreign);
  });

  /**
   * Why mtime is OR'd with the content hash: a comment-only source edit regenerates a
   * byte-identical `coverage-summary.json`, and content alone would leave a correctly
   * regenerated report looking unstamped. The mtime is forced backwards first so the
   * rewrite is guaranteed to move it -- measured granularity here is 0.046 ms, so a
   * same-millisecond rewrite is not the case being modelled.
   */
  it('stamps a rewrite that produced byte-identical content', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    const old = new Date(Date.now() - 60_000);
    utimesSync(summaryPath(), old, old);

    const snapshot = snapshotCoverageStateBeforeScripts();
    writeFileSync(summaryPath(), SUMMARY(80));

    expect(statSync(summaryPath()).mtimeMs).toBeGreaterThan(old.getTime());
    const outcomes = stampCoverageSummariesRewrittenDuringRun(snapshot, 'run');

    expect(outcomes.find((o) => o.suite === 'coverage.unit')?.kind).toBe('stamped');
    expect(existsSync(sidecarPath())).toBe(true);
  });

  /**
   * The codegen-during-build false pass. `requiredScripts: ['test:coverage','build']`
   * where `build` writes into `src/generated` is the ordinary shape: the report
   * describes the tree the coverage tool saw, and the identity resolved afterwards
   * describes the tree the build left behind. Stamping the second over the first is a
   * false pass created by the vouching mechanism itself.
   */
  it('refuses to stamp when the run mutated its own code after writing the report', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });

    const snapshot = snapshotCoverageStateBeforeScripts();
    writeFileSync(summaryPath(), SUMMARY(81));
    // The "build" step, after the coverage step.
    write('src/generated.ts', 'export const generated = 1;\n');

    const outcomes = stampCoverageSummariesRewrittenDuringRun(snapshot, 'run');
    const unit = outcomes.find((o) => o.suite === 'coverage.unit');

    expect(unit?.kind).toBe('cannot-stamp');
    expect(existsSync(sidecarPath())).toBe(false);
    expect(verifyCoverageProvenance(['coverage.unit'])[0]).toMatchObject({
      kind: 'unverifiable',
    });
  });

  it('vouches only for a report it could read', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    const outcomes = stampAllCoverageSummaries('stamp-coverage');

    expect(outcomes.find((o) => o.suite === 'coverage.unit')?.kind).toBe('stamped');
    expect(outcomes.find((o) => o.suite === 'coverage.lambda')?.kind).toBe('no-report');
    expect(readSidecarFile().stampedBy).toBe('stamp-coverage');
  });
});

// ===========================================================================
// Which suites get asked
// ===========================================================================

describe('provenance is asked only about suites that produced a number', () => {
  it('skips a suite whose report could not be parsed, and reports that once', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    write('coverage-lambda/coverage-summary.json', '{"total":{"statements":{"total":16,"cov');
    process.env.QUALITY_COVERAGE_LAMBDA_DIR = 'coverage-lambda';
    resetConfig();

    const coverage = measureCoverage({ absentReportIsFailure: true });
    expect(suitesWithNumbers(coverage.metrics)).toEqual(['coverage.unit']);

    const { metrics, coverageProvenance } = extractAllMetricsAndCoverageProvenance({
      scriptsToRun: [],
      skipSonarQube: true,
      skipCustomDimensions: true,
      coverageAbsenceIsFailure: true,
    });

    expect(coverageProvenance).toHaveLength(1);
    expect(coverageProvenance[0].suite).toBe('coverage.unit');

    const lambdaFailures = (metrics.measurementFailures ?? []).filter(
      (f) => f.dimension === 'coverage.lambda'
    );
    expect(lambdaFailures).toHaveLength(1);
    expect(lambdaFailures[0].kind).toBe('unparseable-output');
  });

  /**
   * End to end through `extractAllMetrics`, because the failure has to reach
   * `metrics.measurementFailures` -- that is the channel `score`, `suggest` and the
   * three MCP handlers read, and a verdict wired only into the CLI would leave all
   * five silent.
   */
  it('carries a stale report out through extractAllMetrics', () => {
    makeProject({ ignoreCoverage: true, report: SUMMARY(80) });
    stampAsRun();
    write('src/a.ts', 'export const a = 3;\n');

    const { metrics } = extractAllMetricsAndCoverageProvenance({
      scriptsToRun: [],
      skipSonarQube: true,
      skipCustomDimensions: true,
      coverageAbsenceIsFailure: true,
    });

    const stale = (metrics.measurementFailures ?? []).filter((f) => f.kind === 'stale-report');
    expect(stale).toHaveLength(1);
    expect(stale[0].dimension).toBe('coverage.unit');
    // The number is still reported. Suppressing it would send `evaluateCeilings` and
    // `evaluateMonotonic` down their silent `continue`, which is a worse failure than
    // reporting a number with a failure attached.
    expect(metrics.coverage?.unit?.statements).toBe(80);

    // And the surfaces that RENDER the failure are told the number is there, so
    // `score` and `suggest` cannot print "missing from this score" over a dimension
    // whose percentage is in the same output.
    const rendered = describeUnmeasured(metrics) ?? [];
    expect(rendered.find((u) => u.kind === 'stale-report')?.numberReported).toBe(true);
    expect(rendered.filter((u) => u.numberReported)).toHaveLength(1);
  });
});
