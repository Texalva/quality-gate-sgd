/**
 * MCP handler tests
 * =================
 * One invariant, and it is the one that was broken: EVERY handler that reports a
 * number derived from the metrics must also report which dimensions are missing
 * from it.
 *
 * `computeFitness` skips an undefined dimension and renormalises by the weight of
 * the ones that remain, so removing a failed dimension RAISES the score. `run`
 * was the one response pairing that number with a pass/fail verdict, and it was
 * also the one omitting `describeUnmeasured` -- an inflated score beside a verdict,
 * with nothing naming what was dropped. `score` and `suggest` already reported it.
 *
 * Written as a loop over the handlers rather than three separate assertions,
 * because the defect is "a handler forgot" and a per-handler test is exactly the
 * shape that lets the next one forget too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Metrics } from '../../src/types.js';

const metricsWithAFailedDimension: Metrics = {
  scripts: {},
  sloc: 1_000,
  // eslint is ABSENT, and the failure below is why. computeFitness renormalises
  // over the dimensions it can read, so the score is computed as if eslint were
  // not part of this project's quality space.
  typescript: { errors: 0, warnings: 0 },
  coverage: { unit: { statements: 90, branches: 90, functions: 90, lines: 90 } },
  measurementFailures: [
    {
      kind: 'crashed',
      dimension: 'eslint',
      message: '`npx eslint` exited 2, which this tool uses to report a failed run.',
      evidence: {
        via: 'process',
        command: 'npx eslint',
        exitCode: 2,
        signal: null,
        elapsedMs: 12,
        stdoutBytes: 0,
        stderrBytes: 40,
      },
    },
  ],
};

/**
 * BOTH extraction entry points are stubbed, and the second one is not optional.
 *
 * `handleRun` takes `extractAllMetricsAsyncAndCoverageProvenance` because it is the
 * only surface here that produces a VERDICT and therefore needs to know which coverage
 * reports the run can stand behind. Stubbing only the Metrics-only variant left
 * `handleRun` running the real extraction against THIS repository -- it reported a
 * missing `type-check` script and a 404 from SonarQube, which is a perfectly good
 * measurement of the wrong subject, and the assertion below failed for a reason that
 * had nothing to do with what it was testing.
 */
const provenanceOf = vi.fn(() => [] as unknown[]);

vi.mock('../../src/metrics.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/metrics.js')>(
    '../../src/metrics.js'
  );
  return {
    ...actual,
    extractAllMetricsAsync: vi.fn(async () => metricsWithAFailedDimension),
    extractAllMetricsAsyncAndCoverageProvenance: vi.fn(async () => ({
      metrics: metricsWithAFailedDimension,
      coverageProvenance: provenanceOf(),
    })),
  };
});

vi.mock('../../src/rules.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/rules.js')>('../../src/rules.js');
  return {
    ...actual,
    loadRules: vi.fn(() => ({
      version: '1.0.0',
      description: 'test',
      rules: { ceilings: { 'eslint.errors': 0 } },
    })),
  };
});

vi.mock('../../src/cache.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/cache.js')>('../../src/cache.js');
  return {
    ...actual,
    loadCache: vi.fn(() => ({ schemaVersion: 4, entries: {} })),
    getCacheKey: vi.fn(() => ({ key: 'wip:abc', isWIP: true })),
    findBaselineEntry: vi.fn(() => undefined),
  };
});

const { handleRun, handleScore, handleSuggest } = await import('../../src/mcp/tools.js');

/** The response body every handler serialises into its single text block. */
const responseOf = async (
  handler: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>
): Promise<Record<string, unknown>> => {
  const result = await handler();
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
};

describe('mcp handlers report what they could not measure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const handlers = [
    { name: 'run', call: () => handleRun({}) },
    { name: 'score', call: () => handleScore({}) },
    // 'dimension' granularity, so the case does not need located-issue extraction.
    { name: 'suggest', call: () => handleSuggest({ granularity: 'dimension' as const }) },
  ];

  for (const { name, call } of handlers) {
    it(`${name} names the dimension it could not measure`, async () => {
      const response = await responseOf(call);

      expect(response.unmeasured).toEqual([
        {
          dimension: 'eslint',
          kind: 'crashed',
          why: expect.stringContaining('exited 2'),
          // Asserted rather than loosened away: `unmeasured` now carries one kind
          // (`stale-report`) that DOES have a number in the same response, and an
          // agent reading this list as "these are absent" would be wrong about it.
          // A crashed linter has no number, so this is false here.
          numberReported: false,
        },
      ]);
    });
  }

  // The reason it matters on `run` specifically: that response is the only one
  // pairing the score with a verdict, so a number inflated by the removal of a
  // dimension reads as an endorsement.
  it('run pairs the verdict, the score and the omission in one response', async () => {
    const response = await responseOf(() => handleRun({}));

    expect(response.status).toBeDefined();
    expect(typeof response.fitnessScore).toBe('number');
    expect(response.unmeasured).toBeDefined();
  });

  /**
   * The MCP half of coverage provenance, wired at the handler and asserted here
   * because nothing else can see it: `evaluateRules` does not produce these entries
   * (they cannot travel inside `Metrics`), so a handler that forgot to append them
   * would serialise `unevaluatedRules: []` over a coverage floor graded against a
   * report nothing ties to the code -- a clean bill of health for a check that proved
   * nothing. The mocked ruleset grades `eslint.errors` only, so the entry also has to
   * be absent when no rule reads coverage.
   */
  it('run reports a coverage report it cannot tie to the code', async () => {
    provenanceOf.mockReturnValue([
      {
        kind: 'unverifiable',
        suite: 'coverage.unit',
        summaryPath: '/p/coverage/coverage-summary.json',
        sidecarPath: '/p/coverage/.quality-gate-provenance.json',
        why: 'no-sidecar',
        detail: 'no .quality-gate-provenance.json beside the report',
      },
    ]);

    const gradesCoverage = await responseOf(() => handleRun({}));
    expect(gradesCoverage.unevaluatedRules).toEqual([]);

    // `vi.clearAllMocks()` clears CALLS and not implementations, so both stubs are put
    // back by hand rather than left to leak into whatever runs next.
    const { loadRules } = await import('../../src/rules.js');
    const gradesEslintOnly = vi.mocked(loadRules).getMockImplementation();
    vi.mocked(loadRules).mockReturnValue({
      version: '1.0.0',
      description: 'test',
      rules: { floors: { 'coverage.unit.statements': 50 } },
    });

    try {
      const response = await responseOf(() => handleRun({}));
      expect(response.unevaluatedRules).toEqual([
        {
          type: 'unverified-provenance',
          rule: 'coverage.unit.provenance',
          reason: 'provenance-unverifiable',
          message: expect.stringContaining('coverage.unit.statements'),
        },
      ]);
    } finally {
      if (gradesEslintOnly) vi.mocked(loadRules).mockImplementation(gradesEslintOnly);
      provenanceOf.mockReturnValue([]);
    }
  });
});
