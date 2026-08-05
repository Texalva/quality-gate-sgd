import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

import { createIstanbulCoverageProvider } from '../../src/providers/coverage.js';
import { isOk } from '../../src/providers/result.js';
import type { CoverageReading, MeasurementContext } from '../../src/providers/types.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

const CONTEXT: MeasurementContext = {
  projectRoot: '/p',
  timeoutMs: 60_000,
  maxBufferBytes: 1024,
};

const PATHS = {
  unitDir: 'coverage',
  lambdaDir: 'coverage-lambda',
  summaryFile: 'coverage-summary.json',
};

const UNIT_SUMMARY = '/p/coverage/coverage-summary.json';
const LAMBDA_SUMMARY = '/p/coverage-lambda/coverage-summary.json';
const UNIT_FINAL = '/p/coverage/coverage-final.json';
const LAMBDA_FINAL = '/p/coverage-lambda/coverage-final.json';

/**
 * Maps absolute paths to file contents. Anything not listed does not exist,
 * which is the ordinary case for a single-suite project.
 */
function mockFiles(files: Record<string, string>, stat: { mtimeMs: number; size: number } = { mtimeMs: 1_700_000_000_000, size: 4_096 }) {
  vi.mocked(fs.existsSync).mockImplementation((p) => String(p) in files);
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    const content = files[String(p)];
    if (content === undefined) {
      const error: NodeJS.ErrnoException = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return content;
  });
  vi.mocked(fs.statSync).mockReturnValue(stat as unknown as fs.Stats);
}

function measure(): CoverageReading {
  const result = createIstanbulCoverageProvider(PATHS).measure(CONTEXT);
  if (!isOk(result)) throw new Error('expected a reading');
  return result.value;
}

const summary = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    total: {
      statements: { total: 100, covered: 80, pct: 80 },
      branches: { total: 50, covered: 40, pct: 80 },
      functions: { total: 20, covered: 15, pct: 75 },
      lines: { total: 100, covered: 85, pct: 85 },
    },
    '/p/src/a.ts': {
      statements: { total: 100, covered: 80, pct: 80 },
      branches: { total: 50, covered: 40, pct: 80 },
      functions: { total: 20, covered: 15, pct: 75 },
      lines: { total: 100, covered: 85, pct: 85 },
    },
    ...over,
  });

// Verbatim shape from the committed synthetic subject's own
// coverage-final.json: `column: null` and an EMPTY start/end object for the
// implicit else. A validator demanding numeric line/column silently
// downgraded 12 located findings to 6 file-level ones here.
const FINAL_WITH_REAL_ISTANBUL_LOCATIONS = JSON.stringify({
  '/p/src/classify.ts': {
    path: '/p/src/classify.ts',
    statementMap: {},
    fnMap: {
      '0': {
        name: 'classify',
        decl: { start: { line: 6, column: 16 }, end: { line: 6, column: 25 } },
        loc: { start: { line: 6, column: 44 }, end: { line: 10, column: null } },
      },
    },
    branchMap: {
      '0': {
        type: 'if',
        loc: { start: { line: 7, column: 2 }, end: { line: 7, column: null } },
        locations: [
          { start: { line: 7, column: 2 }, end: { line: 7, column: null } },
          { start: {}, end: {} },
        ],
      },
    },
    s: {},
    f: { '0': 0 },
    b: { '0': [0, 0] },
  },
});

describe('istanbul coverage provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies itself', () => {
    const provider = createIstanbulCoverageProvider(PATHS);
    expect(provider.name).toBe('istanbul');
    expect(provider.dimension).toBe('coverage');
  });

  describe('metrics', () => {
    it('reads unit coverage from the summary total', () => {
      mockFiles({ [UNIT_SUMMARY]: summary() });

      const { metrics, failures } = measure();

      expect(failures).toEqual([]);
      expect(metrics.unit).toEqual({ statements: 80, branches: 80, functions: 75, lines: 85 });
      expect(metrics.lambda).toBeUndefined();
    });

    it('reads lambda coverage independently of unit', () => {
      mockFiles({ [LAMBDA_SUMMARY]: summary() });

      const { metrics } = measure();

      expect(metrics.lambda).toEqual({ statements: 80, branches: 80, functions: 75, lines: 85 });
      expect(metrics.unit).toBeUndefined();
    });

    // The other half of the case above, and the reason it is not enough on its own:
    // it never asserted on `failures`. A lambda-only layout points
    // QUALITY_COVERAGE_LAMBDA_DIR at the real report and leaves the unit directory at
    // its default, so the unit summary is absent -- and requiring it unconditionally
    // reported `report-missing` on `coverage.unit`, which gates every
    // `coverage.union.*` rule through the derivation edge. That is a red gate on a
    // project whose only real suite measured 80%. Found by adversarial review.
    it('does not fault the absent unit summary when a configured lambda suite read', () => {
      mockFiles({ [LAMBDA_SUMMARY]: summary() });

      const result = createIstanbulCoverageProvider({
        ...PATHS,
        lambdaDirConfigured: true,
      }).measure(CONTEXT);
      if (!isOk(result)) throw new Error('expected a reading');

      expect(result.value.failures).toEqual([]);
      expect(result.value.metrics.lambda).toBeDefined();
      expect(result.value.metrics.union).toBeDefined();
    });

    // A suite the project NAMED must produce a summary, even when the other one is
    // perfectly healthy. The first version hardcoded lambda as never-required, on the
    // grounds that `config.ts` invents it for everyone -- which is true of the
    // DEFAULT, and false of a directory the project asked for by name. Reproduced by
    // adversarial review: valid unit report, QUALITY_COVERAGE_LAMBDA_DIR set, no such
    // summary, an `up` ratchet on coverage.lambda.branches against a 90% baseline --
    // no metric, no failure, pass, cached.
    it('faults a configured lambda summary that does not exist, beside a healthy unit', () => {
      mockFiles({ [UNIT_SUMMARY]: summary() });

      const result = createIstanbulCoverageProvider({
        ...PATHS,
        lambdaDirConfigured: true,
      }).measure(CONTEXT);
      if (!isOk(result)) throw new Error('expected a reading');

      expect(result.value.metrics.unit).toBeDefined();
      expect(result.value.failures).toHaveLength(1);
      expect(result.value.failures[0]).toMatchObject({
        kind: 'report-missing',
        dimension: 'coverage.lambda',
      });
      expect(result.value.failures[0].message).toContain('QUALITY_COVERAGE_LAMBDA_DIR');
    });

    // And the default second suite stays silent, which is the false positive the
    // `configured` flag exists to avoid: almost no project has `coverage-lambda/`.
    it('stays silent about the DEFAULT lambda suite when unit read fine', () => {
      mockFiles({ [UNIT_SUMMARY]: summary() });

      expect(measure().failures).toEqual([]);
    });

    // union is NOT a rounded duplicate of unit: istanbul rounds total.pct to 2 dp
    // while this is recomputed from the per-file entries at full precision.
    it('recomputes union from per-file entries at full precision', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 3, covered: 1, pct: 33.33 },
            branches: { total: 3, covered: 1, pct: 33.33 },
            functions: { total: 3, covered: 1, pct: 33.33 },
            lines: { total: 3, covered: 1, pct: 33.33 },
          },
          '/p/src/a.ts': {
            statements: { total: 3, covered: 1, pct: 33.33 },
            branches: { total: 3, covered: 1, pct: 33.33 },
            functions: { total: 3, covered: 1, pct: 33.33 },
            lines: { total: 3, covered: 1, pct: 33.33 },
          },
        }),
      });

      const { metrics } = measure();

      expect(metrics.unit?.statements).toBe(33.33);
      expect(metrics.union?.statements).toBeCloseTo(33.333333333333336, 10);
      expect(metrics.union?.statements).not.toBe(33.33);
    });

    it('takes the max covered per file across overlapping suites', () => {
      const withCovered = (covered: number) =>
        JSON.stringify({
          '/p/src/a.ts': {
            statements: { total: 100, covered, pct: covered },
            branches: { total: 100, covered, pct: covered },
            functions: { total: 100, covered, pct: covered },
            lines: { total: 100, covered, pct: covered },
          },
        });
      mockFiles({ [UNIT_SUMMARY]: withCovered(80), [LAMBDA_SUMMARY]: withCovered(60) });

      expect(measure().metrics.union?.statements).toBe(80);
    });

    it('sums non-overlapping files across suites', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          '/p/src/unit.ts': {
            statements: { total: 50, covered: 30, pct: 60 },
            branches: { total: 50, covered: 30, pct: 60 },
            functions: { total: 50, covered: 30, pct: 60 },
            lines: { total: 50, covered: 30, pct: 60 },
          },
        }),
        [LAMBDA_SUMMARY]: JSON.stringify({
          '/p/src/lambda.ts': {
            statements: { total: 50, covered: 40, pct: 80 },
            branches: { total: 50, covered: 40, pct: 80 },
            functions: { total: 50, covered: 40, pct: 80 },
            lines: { total: 50, covered: 40, pct: 80 },
          },
        }),
      });

      expect(measure().metrics.union?.statements).toBe(70);
    });

    it('skips null file entries', () => {
      mockFiles({ [UNIT_SUMMARY]: summary({ '/p/src/null.ts': null }) });

      expect(measure().metrics.union).toBeDefined();
    });

    it('keeps the key order the refactor harness compares byte-for-byte', () => {
      mockFiles({ [UNIT_SUMMARY]: summary() });

      expect(Object.keys(measure().metrics)).toEqual(['lambda', 'unit', 'union']);
    });

    // The union survives and the SUITE is what failed: `total` is the only source
    // of `coverage.unit.*`, while the union is summed from the per-file entries.
    // The failure is the point -- with no `total` and no failure, a ceiling or a
    // monotonic rule on coverage.unit.* has nothing to compare and skips.
    it('reports a summary with no total as a failed suite, keeping the union', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          '/p/src/a.ts': {
            statements: { total: 10, covered: 5, pct: 50 },
            branches: { total: 10, covered: 5, pct: 50 },
            functions: { total: 10, covered: 5, pct: 50 },
            lines: { total: 10, covered: 5, pct: 50 },
          },
        }),
      });

      const { metrics, failures } = measure();

      expect(metrics.unit).toBeUndefined();
      expect(metrics.union).toBeDefined();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        kind: 'unparseable-output',
        dimension: 'coverage.unit',
      });
      expect(failures[0].message).toContain('no `total` object');
    });
  });

  describe('zero denominators', () => {
    it('refuses an all-zero total instead of reporting istanbul\'s 100%', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 0, covered: 0, pct: 100 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 0, covered: 0, pct: 100 },
            lines: { total: 0, covered: 0, pct: 100 },
          },
          '/p/src/types-only.ts': {
            statements: { total: 0, covered: 0, pct: 100 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 0, covered: 0, pct: 100 },
            lines: { total: 0, covered: 0, pct: 100 },
          },
        }),
      });

      const { metrics, failures } = measure();

      expect(metrics.unit).toBeUndefined();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ kind: 'measured-nothing', dimension: 'coverage.unit' });
    });

    // The vacuous-100 rule is only safe while a zero denominator really means
    // "this dimension does not exist here". `{total: 0, covered: 5}` is not a
    // branchless codebase, it is a report contradicting itself -- and beside any
    // positive denominator it walks straight past the all-zero clause above, so
    // without this it would satisfy a floor at 100% with no failure recorded.
    it('refuses a total of zero that claims covered entries', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 10, covered: 3, pct: 30 },
            branches: { total: 0, covered: 5, pct: 100 },
            functions: { total: 2, covered: 1, pct: 50 },
            lines: { total: 10, covered: 3, pct: 30 },
          },
        }),
      });

      const { metrics, failures } = measure();

      expect(metrics.unit).toBeUndefined();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        kind: 'unparseable-output',
        dimension: 'coverage.unit',
      });
      expect(failures[0].message).toContain('more covered than total');
    });

    it('refuses a fractional or negative count', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 10, covered: -1, pct: 30 },
            branches: { total: 4.5, covered: 1, pct: 25 },
            functions: { total: 2, covered: 1, pct: 50 },
            lines: { total: 10, covered: 3, pct: 30 },
          },
        }),
      });

      const { failures } = measure();

      expect(failures[0]).toMatchObject({ kind: 'unparseable-output' });
      expect(failures[0].message).toContain('whole non-negative count');
    });

    // The control. An implementation rejecting every zero denominator would pass
    // the case above and fail every project without conditionals.
    it('keeps a branchless project, reporting the branch dimension as vacuously covered', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 3, covered: 0, pct: 0 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 2, covered: 0, pct: 0 },
            lines: { total: 3, covered: 0, pct: 0 },
          },
        }),
      });

      const { metrics, failures } = measure();

      expect(failures).toEqual([]);
      expect(metrics.unit?.statements).toBe(0);
      expect(metrics.unit?.branches).toBe(100);
      // Key order is compared byte-for-byte against the frozen apollo baseline,
      // and a zero denominator must not reshuffle it.
      expect(Object.keys(metrics.unit ?? {})).toEqual([
        'statements',
        'branches',
        'functions',
        'lines',
      ]);
    });

    // `union` is recomputed from the per-file entries rather than copied from
    // `total`, so it needed the same rule -- and it matters more:
    // normalizeMetrics prefers union, so this is the number the quality score
    // and the trajectory read.
    it('reports a branchless union as vacuously covered rather than as 0%', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 3, covered: 3, pct: 100 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 2, covered: 2, pct: 100 },
            lines: { total: 3, covered: 3, pct: 100 },
          },
          '/p/src/branchless.ts': {
            statements: { total: 3, covered: 3, pct: 100 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 2, covered: 2, pct: 100 },
            lines: { total: 3, covered: 3, pct: 100 },
          },
        }),
      });

      const { metrics, failures } = measure();

      expect(failures).toEqual([]);
      expect(metrics.union?.branches).toBe(100);
      expect(metrics.union?.statements).toBe(100);
    });

    // The one shape where a fabricated 100 would be the original defect
    // verbatim. There is no failure channel on the union path, so it reports
    // nothing at all; the suite's own `measured-nothing` is the loud part.
    it('reports no union when every merged denominator is zero', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 0, covered: 0, pct: 100 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 0, covered: 0, pct: 100 },
            lines: { total: 0, covered: 0, pct: 100 },
          },
          '/p/src/types-only.ts': {
            statements: { total: 0, covered: 0, pct: 100 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 0, covered: 0, pct: 100 },
            lines: { total: 0, covered: 0, pct: 100 },
          },
        }),
      });

      const { metrics, failures } = measure();

      expect(metrics.union).toBeUndefined();
      expect(failures[0]).toMatchObject({ kind: 'measured-nothing' });
    });
  });

  // The union arithmetic reads all four dimensions of every FILE entry, and
  // `CoverageEntry` declaring those as required numbers is an assumption about a
  // file this tool did not write. MEASURED against the shipped dist: a summary
  // with a valid `total` and one file entry lacking `statements` threw
  // `TypeError: Cannot read properties of undefined (reading 'total')` out of
  // measure(), out of extractCoverageIssues, and out of extractLocatedIssues --
  // where the identical input returned 2 findings cleanly before the extraction.
  describe('a file entry the union cannot add up', () => {
    const MISSING_STATEMENTS = JSON.stringify({
      total: {
        statements: { total: 100, covered: 80, pct: 80 },
        branches: { total: 50, covered: 40, pct: 80 },
        functions: { total: 20, covered: 15, pct: 75 },
        lines: { total: 100, covered: 85, pct: 85 },
      },
      '/p/src/a.ts': {
        branches: { total: 10, covered: 2, pct: 20 },
        functions: { total: 4, covered: 1, pct: 25 },
        lines: { total: 10, covered: 2, pct: 20 },
      },
    });

    it('does not throw, and still returns the findings the entry supports', () => {
      mockFiles({ [UNIT_SUMMARY]: MISSING_STATEMENTS });

      // The regression guard proper: this call used to throw.
      const { issues } = measure();

      expect(issues.map((i) => i.code)).toEqual([
        'uncovered-branches',
        'uncovered-functions',
      ]);
    });

    // The suite's own numbers come from `total`, which extractFromTotal validates
    // on its own, so refusing the whole reading would discard two good numbers
    // over one bad entry.
    it('keeps the suite total and refuses only the union', () => {
      mockFiles({ [UNIT_SUMMARY]: MISSING_STATEMENTS });

      const { metrics } = measure();

      expect(metrics.unit).toEqual({ statements: 80, branches: 80, functions: 75, lines: 85 });
      expect(metrics.union).toBeUndefined();
    });

    // Refused rather than merged around: dropping the entry would quietly lower
    // every denominator in the union and hand back a number that reads as a
    // measurement of the whole project.
    it('reports the refusal against coverage.union, naming the entry', () => {
      mockFiles({ [UNIT_SUMMARY]: MISSING_STATEMENTS });

      const { failures } = measure();

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        kind: 'unparseable-output',
        dimension: 'coverage.union',
      });
      expect(failures[0].message).toContain('/p/src/a.ts');
      expect(failures[0].message).toContain(UNIT_SUMMARY);
      expect(failures[0].message).toContain('QUALITY_COVERAGE_UNIT_DIR');
    });

    // A non-numeric count is the same defect wearing istanbul's "Unknown", and a
    // null measure object is the same again. MEASURED that both throw out of the
    // merge: `entry.statements.total` on `total: 'Unknown'` yields a string that
    // corrupts the sum silently, and `entry.lines.total` on `lines: null` throws
    // "Cannot read properties of null (reading 'total')".
    it('catches a non-numeric count and a null measure object alike', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 100, covered: 80, pct: 80 },
            branches: { total: 50, covered: 40, pct: 80 },
            functions: { total: 20, covered: 15, pct: 75 },
            lines: { total: 100, covered: 85, pct: 85 },
          },
          '/p/src/unknown.ts': {
            statements: { total: 'Unknown', covered: 0, pct: 0 },
            branches: { total: 1, covered: 0, pct: 0 },
            functions: { total: 1, covered: 0, pct: 0 },
            lines: { total: 1, covered: 0, pct: 0 },
          },
          '/p/src/null-lines.ts': {
            statements: { total: 1, covered: 0, pct: 0 },
            branches: { total: 1, covered: 0, pct: 0 },
            functions: { total: 1, covered: 0, pct: 0 },
            lines: null,
          },
        }),
      });

      const { metrics, failures } = measure();

      expect(metrics.union).toBeUndefined();
      expect(failures[0].message).toContain('2 file entries');
      expect(failures[0].message).toContain('/p/src/unknown.ts');
      expect(failures[0].message).toContain('/p/src/null-lines.ts');
    });

    // A null ENTRY is skipped by the merge (`if (file === 'total' || !entry)`)
    // before any dimension is touched, so it is not this function's complaint.
    // The validator matches the merge exactly, which is the contract -- anything
    // else and it would either miss a throw or invent a failure.
    it('ignores an entry the merge itself skips', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 1, covered: 1, pct: 100 },
            branches: { total: 1, covered: 1, pct: 100 },
            functions: { total: 1, covered: 1, pct: 100 },
            lines: { total: 1, covered: 1, pct: 100 },
          },
          '/p/src/a.ts': {
            statements: { total: 1, covered: 1, pct: 100 },
            branches: { total: 1, covered: 1, pct: 100 },
            functions: { total: 1, covered: 1, pct: 100 },
            lines: { total: 1, covered: 1, pct: 100 },
          },
          '/p/src/nulled.ts': null,
        }),
      });

      const { metrics, failures } = measure();

      expect(failures).toEqual([]);
      expect(metrics.union).toEqual({
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      });
    });

    // `total` is skipped by the merge before its dimensions are read, so a
    // malformed `total` is extractFromTotal's complaint and not this one.
    it('leaves a malformed total to extractFromTotal', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: { branches: { total: 1, covered: 0, pct: 0 } },
          '/p/src/a.ts': {
            statements: { total: 1, covered: 0, pct: 0 },
            branches: { total: 1, covered: 0, pct: 0 },
            functions: { total: 1, covered: 0, pct: 0 },
            lines: { total: 1, covered: 0, pct: 0 },
          },
        }),
      });

      const { failures } = measure();

      expect(failures).toHaveLength(1);
      expect(failures[0].dimension).toBe('coverage.unit');
      // Names the offending entry, not just "unparseable": the whole point of the
      // kind is that the adopter can go look at the field.
      expect(failures[0].message).toContain('total.statements');
    });
  });

  describe('issues', () => {
    it('extracts located branch and function findings from the detail report', () => {
      mockFiles({ [UNIT_FINAL]: FINAL_WITH_REAL_ISTANBUL_LOCATIONS });

      const { issues } = measure();

      const branches = issues.filter((i) => i.code === 'branch-if');
      const functions = issues.filter((i) => i.code === 'uncovered-function');
      expect(branches).toHaveLength(2);
      expect(functions).toHaveLength(1);
      expect(functions[0].symbol).toBe('classify');
    });

    // #36. Every finding from the DETAIL report was labelled `coverage.unit.*`
    // regardless of which report it came from, so fix advice for a lambda-suite
    // finding claimed that covering it would move the UNIT dimension -- and
    // `impact.dimension` is what the optimizer and `prioritize` read to decide what
    // to work on. Untested until now, which is why the mislabelling survived the
    // extraction: the frozen apollo baseline cannot see it either, because apollo
    // ships no coverage-final.json and all of its findings come from the summary
    // path, which has always been suite-aware.
    //
    // Both fields are asserted. `dimension` is the label a human reads and
    // `impact.dimension` is the one the machinery reads; they were hardcoded
    // separately, so fixing one and not the other is a live possibility.
    it('labels detail-report findings with the suite the report came from', () => {
      mockFiles({ [LAMBDA_FINAL]: FINAL_WITH_REAL_ISTANBUL_LOCATIONS });

      const { issues } = measure();

      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.dimension.startsWith('coverage.lambda.'))).toBe(true);
      expect(issues.every((i) => i.impact.dimension.startsWith('coverage.lambda.'))).toBe(true);
      // The suffix still identifies WHAT was uncovered.
      expect(issues.filter((i) => i.code === 'branch-if')[0].dimension).toBe(
        'coverage.lambda.branches'
      );
      expect(issues.filter((i) => i.code === 'uncovered-function')[0].dimension).toBe(
        'coverage.lambda.functions'
      );
    });

    // The control: the unit suite must be unchanged, or the case above is satisfiable
    // by labelling everything `coverage.lambda.*`.
    it('still labels unit-report findings with the unit suite', () => {
      mockFiles({ [UNIT_FINAL]: FINAL_WITH_REAL_ISTANBUL_LOCATIONS });

      const { issues } = measure();

      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.dimension.startsWith('coverage.unit.'))).toBe(true);
      expect(issues.every((i) => i.impact.dimension.startsWith('coverage.unit.'))).toBe(true);
    });

    // The regression guard for the mistake above.
    it('tolerates istanbul\'s null columns and empty implicit-else locations', () => {
      mockFiles({ [UNIT_FINAL]: FINAL_WITH_REAL_ISTANBUL_LOCATIONS });

      const { issues, reads } = measure();

      expect(reads.find((r) => r.kind === 'final' && r.attempt.existed)?.shape).toBe('expected');
      const implicitElse = issues.filter((i) => i.code === 'branch-if')[1];
      expect(implicitElse.line).toBeUndefined();
      const explicit = issues.filter((i) => i.code === 'branch-if')[0];
      expect(explicit.line).toBe(7);
      expect(explicit.endColumn).toBeNull();
    });

    it('names an anonymous function by its map id', () => {
      mockFiles({
        [UNIT_FINAL]: JSON.stringify({
          '/p/src/a.ts': {
            path: '/p/src/a.ts',
            statementMap: {},
            fnMap: {
              '7': {
                name: '',
                decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
                loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
              },
            },
            branchMap: {},
            s: {},
            f: { '7': 0 },
            b: {},
          },
        }),
      });

      expect(measure().issues[0].symbol).toBe('anonymous_7');
    });

    it('skips node_modules, test and spec files', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          '/p/node_modules/x/index.ts': {
            statements: { total: 10, covered: 1, pct: 10 },
            branches: { total: 10, covered: 1, pct: 10 },
            functions: { total: 10, covered: 1, pct: 10 },
            lines: { total: 10, covered: 1, pct: 10 },
          },
          '/p/src/a.test.ts': {
            statements: { total: 10, covered: 1, pct: 10 },
            branches: { total: 10, covered: 1, pct: 10 },
            functions: { total: 10, covered: 1, pct: 10 },
            lines: { total: 10, covered: 1, pct: 10 },
          },
          '/p/src/a.spec.ts': {
            statements: { total: 10, covered: 1, pct: 10 },
            branches: { total: 10, covered: 1, pct: 10 },
            functions: { total: 10, covered: 1, pct: 10 },
            lines: { total: 10, covered: 1, pct: 10 },
          },
        }),
      });

      expect(measure().issues).toEqual([]);
    });

    // The apollo-client shape, and the reason the frozen baseline's 279 findings
    // exist at all. A check that fires here rejects the golden.
    it('falls back to the summary when the detail report is ABSENT, with no failure', () => {
      mockFiles({
        [UNIT_SUMMARY]: JSON.stringify({
          total: {
            statements: { total: 100, covered: 24, pct: 23.86 },
            branches: { total: 100, covered: 2, pct: 2.18 },
            functions: { total: 100, covered: 8, pct: 7.78 },
            lines: { total: 100, covered: 23, pct: 23.04 },
          },
          '/p/src/a.ts': {
            statements: { total: 10, covered: 2, pct: 20 },
            branches: { total: 10, covered: 2, pct: 20 },
            functions: { total: 10, covered: 2, pct: 20 },
            lines: { total: 10, covered: 2, pct: 20 },
          },
        }),
      });

      const { issues, failures, metrics } = measure();

      expect(failures).toEqual([]);
      expect(metrics.unit?.statements).toBe(23.86);
      expect(issues).toHaveLength(2);
      expect(issues[0]).toMatchObject({
        code: 'uncovered-branches',
        message: 'Low branch coverage (20.0%)',
        context: '8/10 branches uncovered',
      });
      expect(issues[1]).toMatchObject({ code: 'uncovered-functions' });
      // File-level, so no location -- that is the cost of the fallback.
      expect(issues[0].line).toBeUndefined();
    });

    // Pinned by an existing test in tests/targets: the fallback fires on
    // `issues.length === 0`, which includes a detail report that parsed fine and
    // simply had nothing uncovered.
    it('falls back when the detail report parsed but found nothing uncovered', () => {
      mockFiles({
        [UNIT_FINAL]: JSON.stringify({
          '/p/src/a.ts': {
            path: '/p/src/a.ts',
            statementMap: {},
            fnMap: {},
            branchMap: {
              '0': {
                type: 'if',
                loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
                locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }],
              },
            },
            s: {},
            f: {},
            b: { '0': [1] },
          },
        }),
        [UNIT_SUMMARY]: JSON.stringify({
          '/p/src/other.ts': {
            statements: { total: 10, covered: 8, pct: 80 },
            branches: { total: 10, covered: 5, pct: 50 },
            functions: { total: 2, covered: 2, pct: 100 },
            lines: { total: 10, covered: 8, pct: 80 },
          },
        }),
      });

      expect(measure().issues.some((i) => i.file.includes('other.ts'))).toBe(true);
    });

    // Rejecting the whole detail report for one bad entry emptied `issues`, and
    // because the summary fallback fires on `issues.length === 0` it then
    // substituted coarse file-level findings for precise located ones -- the
    // silent downgrade the isReadableLocation note above exists to prevent,
    // reappearing one level up. MEASURED: 3 located findings became 2 unlocated
    // ones.
    describe('one malformed entry beside a good one', () => {
      const ONE_GOOD_ONE_BAD = JSON.stringify({
        '/p/src/good.ts': JSON.parse(FINAL_WITH_REAL_ISTANBUL_LOCATIONS)['/p/src/classify.ts'],
        // No branchMap at all: `Object.values(undefined)` is the throw that made
        // validation necessary in the first place.
        '/p/src/bad.ts': { path: '/p/src/bad.ts', statementMap: {}, fnMap: {}, s: {}, f: {}, b: {} },
      });

      it('keeps the good entry\'s located findings', () => {
        mockFiles({ [UNIT_FINAL]: ONE_GOOD_ONE_BAD, [UNIT_SUMMARY]: summary() });

        const { issues } = measure();

        expect(issues).toHaveLength(3);
        expect(issues.filter((i) => i.code === 'branch-if')).toHaveLength(2);
        expect(issues.filter((i) => i.code === 'uncovered-function')).toHaveLength(1);
        expect(issues.every((i) => i.file === '/p/src/good.ts')).toBe(true);
      });

      // The fallback is the downgrade. It must not fire when located findings
      // exist, and it fired only because rejection emptied the array.
      it('does not fall back to file-level summary findings', () => {
        mockFiles({ [UNIT_FINAL]: ONE_GOOD_ONE_BAD, [UNIT_SUMMARY]: summary() });

        const { issues } = measure();

        expect(issues.some((i) => i.code === 'uncovered-branches')).toBe(false);
        expect(issues.every((i) => i.line !== undefined || i.code === 'branch-if')).toBe(true);
      });

      // Kept is not the same as unnoticed: the report is still flagged, which is
      // what makes targets/extract.ts warn about it.
      it('still records the report as an unexpected shape', () => {
        mockFiles({ [UNIT_FINAL]: ONE_GOOD_ONE_BAD, [UNIT_SUMMARY]: summary() });

        const { reads, failures } = measure();

        expect(reads.find((r) => r.kind === 'final' && r.suite === 'coverage.unit')?.shape).toBe(
          'unexpected'
        );
        // A degraded DETAIL report costs findings, not the verdict.
        expect(failures).toEqual([]);
      });
    });
  });

  // The metrics path discards issues, and building them is not free: the detail
  // report is the largest artifact the tool reads. MEASURED on Node 26.5.1 against
  // a generated 96 MB coverage-final.json (480 000 findings): collecting took
  // 2170ms and 612 MB RSS, skipping took 2ms and 51 MB. Before the extraction the
  // metrics path never opened that file at all.
  describe('metrics without issues', () => {
    const skipping = () => {
      const result = createIstanbulCoverageProvider(PATHS, { issues: 'skip' }).measure(CONTEXT);
      if (!isOk(result)) throw new Error('expected a reading');
      return result.value;
    };

    it('returns the same metrics as a full reading', () => {
      mockFiles({ [UNIT_SUMMARY]: summary() });

      expect(skipping().metrics).toEqual(measure().metrics);
    });

    it('collects no issues', () => {
      mockFiles({ [UNIT_FINAL]: FINAL_WITH_REAL_ISTANBUL_LOCATIONS, [UNIT_SUMMARY]: summary() });

      expect(measure().issues.length).toBeGreaterThan(0);
      expect(skipping().issues).toEqual([]);
    });

    // Never opened, not opened-and-ignored: an attempt recorded for a path this
    // run deliberately did not read would be evidence about nothing.
    it('does not touch the detail report at all', () => {
      mockFiles({ [UNIT_FINAL]: FINAL_WITH_REAL_ISTANBUL_LOCATIONS, [UNIT_SUMMARY]: summary() });

      const { reads } = skipping();

      expect(reads.map((r) => r.kind)).toEqual(['summary', 'summary']);
      const touched = vi.mocked(fs.readFileSync).mock.calls.map((c) => String(c[0]));
      expect(touched).not.toContain(UNIT_FINAL);
      expect(vi.mocked(fs.existsSync).mock.calls.map((c) => String(c[0]))).not.toContain(
        UNIT_FINAL
      );
    });

    // The failure channel is about the summaries, so it is unaffected.
    it('still reports a corrupt summary', () => {
      mockFiles({ [UNIT_SUMMARY]: 'not json' });

      expect(skipping().failures.map((f) => f.kind)).toEqual(['unparseable-output']);
    });

    // The default is unchanged, so no existing caller silently loses its findings.
    it('collects issues by default', () => {
      mockFiles({ [UNIT_FINAL]: FINAL_WITH_REAL_ISTANBUL_LOCATIONS });

      const result = createIstanbulCoverageProvider(PATHS).measure(CONTEXT);
      if (!isOk(result)) throw new Error('expected a reading');

      expect(result.value.issues.length).toBe(3);
    });
  });

  describe('failure classification', () => {
    // The absent unit summary is the whole of #43: it produced no metric AND no
    // failure, and only `evaluateFloors` reports a missing metric -- a ceiling or a
    // monotonic rule `continue`s on an undefined value. So a coverage ratchet
    // stopped ratcheting the moment the report stopped being written, silently, and
    // the run still cached its pass.
    it('reports an absent unit summary as report-missing', () => {
      mockFiles({});

      const { metrics, failures, reads } = measure();

      expect(metrics.unit).toBeUndefined();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        kind: 'report-missing',
        dimension: 'coverage.unit',
      });
      // Names the file, the setting that produced the path, and the opt-out.
      expect(failures[0].message).toContain(UNIT_SUMMARY);
      expect(failures[0].message).toContain('QUALITY_COVERAGE_UNIT_DIR');
      expect(failures[0].message).toContain('QUALITY_COVERAGE_REQUIRED=false');

      // The lambda summary is absent too and is NOT reported, because `lambdaDir`
      // is populated unconditionally from a default nearly no project has -- see
      // suitesOf and #38.
      expect(failures.every((f) => f.dimension !== 'coverage.lambda')).toBe(true);

      expect(reads.every((r) => r.attempt.outcome === 'absent')).toBe(true);
      expect(reads.map((r) => r.attempt.path)).toEqual([
        UNIT_FINAL,
        LAMBDA_FINAL,
        UNIT_SUMMARY,
        LAMBDA_SUMMARY,
      ]);
    });

    // The explicit opt-out for a project that has no coverage and never will.
    // Without one, option (c) of #43 charges an advisory on every run -- and the
    // loss of the cache, since any measurement failure suppresses the write -- to a
    // project that gates only its type-checker and its linter.
    it('stays silent about an absent summary when absentReport is ignore', () => {
      mockFiles({});

      const result = createIstanbulCoverageProvider(PATHS, {
        absentReport: 'ignore',
      }).measure(CONTEXT);
      if (!isOk(result)) throw new Error('expected a reading');

      expect(result.value.failures).toEqual([]);
      expect(result.value.metrics.unit).toBeUndefined();
    });

    // The opt-out is about ABSENCE only. A report that exists and cannot be read is
    // still a failed measurement, because the project plainly does have coverage
    // and the tool cannot say what it is.
    it('still reports a corrupt summary when absentReport is ignore', () => {
      mockFiles({ [UNIT_SUMMARY]: 'this is not json' });

      const result = createIstanbulCoverageProvider(PATHS, {
        absentReport: 'ignore',
      }).measure(CONTEXT);
      if (!isOk(result)) throw new Error('expected a reading');

      expect(result.value.failures).toHaveLength(1);
      expect(result.value.failures[0]).toMatchObject({
        kind: 'unparseable-output',
        dimension: 'coverage.unit',
      });
    });

    it('reports a corrupt summary as unparseable, naming the file and the setting', () => {
      mockFiles({ [UNIT_SUMMARY]: 'this is not json' });

      const { failures } = measure();

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        kind: 'unparseable-output',
        dimension: 'coverage.unit',
      });
      expect(failures[0].message).toContain(UNIT_SUMMARY);
      expect(failures[0].message).toContain('QUALITY_COVERAGE_UNIT_DIR');

      const evidence = failures[0].evidence;
      if (evidence.via !== 'report') throw new Error('expected report evidence');
      expect(evidence.attempts[0]).toMatchObject({ outcome: 'invalid-json', existed: true });
      expect(evidence.attempts[0].bytesRead).toBe(16);
      expect(evidence.attempts[0].modifiedMs).toBe(1_700_000_000_000);
    });

    it('reports valid JSON that is an array as the wrong shape', () => {
      mockFiles({ [UNIT_SUMMARY]: '[]' });

      const { failures } = measure();

      expect(failures[0]).toMatchObject({ kind: 'unparseable-output' });
      const evidence = failures[0].evidence;
      if (evidence.via !== 'report') throw new Error('expected report evidence');
      expect(evidence.attempts[0].outcome).toBe('wrong-shape');
    });

    it('keeps a good unit report when the lambda one is corrupt', () => {
      mockFiles({ [UNIT_SUMMARY]: summary(), [LAMBDA_SUMMARY]: 'not json' });

      const { metrics, failures } = measure();

      // Partial success is the whole reason the reading carries failures rather
      // than being a Result of one or the other.
      expect(metrics.unit).toEqual({ statements: 80, branches: 80, functions: 75, lines: 85 });
      expect(failures).toHaveLength(1);
      expect(failures[0].dimension).toBe('coverage.lambda');
    });

    // A corrupt DETAIL report costs the located findings, not the verdict: the
    // graded numbers come from the summary. Promoting it to a gate failure would
    // be a behaviour change the extraction has no business making.
    it('does not fail the gate for a corrupt detail report, but records it', () => {
      mockFiles({ [UNIT_FINAL]: 'not json', [UNIT_SUMMARY]: summary() });

      const { metrics, failures, reads } = measure();

      expect(failures).toEqual([]);
      expect(metrics.unit).toBeDefined();
      expect(reads.find((r) => r.kind === 'final' && r.suite === 'coverage.unit')?.attempt.outcome).toBe(
        'invalid-json'
      );
    });

    it('marks a summary found at the detail report path as an unexpected shape', () => {
      mockFiles({ [UNIT_FINAL]: summary(), [UNIT_SUMMARY]: summary() });

      const { reads, failures } = measure();

      // It parsed, so it is not an unreadable report -- but it is not a detail
      // report either, and walking it threw before this was validated.
      expect(reads.find((r) => r.kind === 'final' && r.suite === 'coverage.unit')?.shape).toBe(
        'unexpected'
      );
      expect(failures).toEqual([]);
    });
  });

  describe('report reads', () => {
    it('records every candidate path exactly once, detail reports first', () => {
      mockFiles({ [UNIT_SUMMARY]: summary() });

      const { reads } = measure();

      expect(reads).toHaveLength(4);
      expect(reads.map((r) => `${r.kind}:${r.suite}`)).toEqual([
        'final:coverage.unit',
        'final:coverage.lambda',
        'summary:coverage.unit',
        'summary:coverage.lambda',
      ]);
    });

    it('omits the lambda suite entirely when no lambda directory is configured', () => {
      mockFiles({ [UNIT_SUMMARY]: summary() });

      const result = createIstanbulCoverageProvider({
        unitDir: 'coverage',
        summaryFile: 'coverage-summary.json',
      }).measure(CONTEXT);
      if (!isOk(result)) throw new Error('expected a reading');

      expect(result.value.reads.map((r) => r.suite)).toEqual([
        'coverage.unit',
        'coverage.unit',
      ]);
    });

    // RECORDED, never judged -- by this provider or by any caller. Nothing in
    // the tool compares mtime against anything (see ReportAttempt.modifiedMs and
    // backlog #39); it is evidence a human reads out of gate output.
    it('records mtime and bytes read as evidence about the report it opened', () => {
      mockFiles({ [UNIT_SUMMARY]: summary() }, { mtimeMs: 42_000, size: 999 });

      const read = measure().reads.find((r) => r.kind === 'summary' && r.attempt.existed);

      expect(read?.attempt.modifiedMs).toBe(42_000);
      expect(read?.attempt.bytesRead).toBeGreaterThan(0);
    });
  });
});
