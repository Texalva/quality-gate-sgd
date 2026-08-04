import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { evaluateRules } from '../src/rules.js'
import type { Metrics } from '../src/types.js'
import {
  measureCoverage,
  extractAllCoverageMetrics,
  extractCoverageMetrics,
  extractSloc,
  runScript,
  runScripts,
  extractTypescriptMetrics,
  extractEslintMetrics,
  extractSonarqubeMetrics,
  isSonarqubeAvailable,
  getTopSonarIssues,
  runSonarqubeScan,
  extractAllMetrics,
  extractAllMetricsAsync,
} from '../src/metrics.js'

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  }
})

// Mock child_process
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  execSync: vi.fn(),
}))

// Mock config
vi.mock('../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    projectRoot: '/test/project',
    coverage: {
      unitDir: 'coverage',
      lambdaDir: 'coverage-lambda',
      summaryFile: 'coverage-summary.json',
    },
    sonarqube: {
      url: 'http://localhost:9000',
      projectKey: 'test-project',
    },
    defaultScriptTimeout: 60000,
    scriptTimeouts: {},
  })),
  getSonarCurlAuth: vi.fn(() => ''),
}))

describe('Coverage Metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('extractAllCoverageMetrics', () => {
    it('returns empty coverage when no files exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = extractAllCoverageMetrics()

      expect(result.unit).toBeUndefined()
      expect(result.lambda).toBeUndefined()
      expect(result.union).toBeUndefined()
    })

    it('extracts unit coverage when file exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes('coverage/coverage-summary.json')
      })

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        total: {
          statements: { total: 100, covered: 80, pct: 80 },
          branches: { total: 50, covered: 40, pct: 80 },
          functions: { total: 20, covered: 15, pct: 75 },
          lines: { total: 100, covered: 85, pct: 85 },
        },
        '/test/file.ts': {
          statements: { total: 100, covered: 80, pct: 80 },
          branches: { total: 50, covered: 40, pct: 80 },
          functions: { total: 20, covered: 15, pct: 75 },
          lines: { total: 100, covered: 85, pct: 85 },
        },
      }))

      const result = extractAllCoverageMetrics()

      expect(result.unit).toBeDefined()
      expect(result.unit?.branches).toBe(80)
      expect(result.unit?.statements).toBe(80)
    })

    it('merges overlapping coverage from unit and lambda tests', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes('coverage-lambda')) {
          return JSON.stringify({
            total: {
              statements: { total: 100, covered: 60, pct: 60 },
              branches: { total: 50, covered: 30, pct: 60 },
              functions: { total: 20, covered: 10, pct: 50 },
              lines: { total: 100, covered: 60, pct: 60 },
            },
            '/test/file.ts': {
              statements: { total: 100, covered: 60, pct: 60 },
              branches: { total: 50, covered: 30, pct: 60 },
              functions: { total: 20, covered: 10, pct: 50 },
              lines: { total: 100, covered: 60, pct: 60 },
            },
          })
        }
        return JSON.stringify({
          total: {
            statements: { total: 100, covered: 80, pct: 80 },
            branches: { total: 50, covered: 40, pct: 80 },
            functions: { total: 20, covered: 15, pct: 75 },
            lines: { total: 100, covered: 85, pct: 85 },
          },
          '/test/file.ts': {
            statements: { total: 100, covered: 80, pct: 80 },
            branches: { total: 50, covered: 40, pct: 80 },
            functions: { total: 20, covered: 15, pct: 75 },
            lines: { total: 100, covered: 85, pct: 85 },
          },
        })
      })

      const result = extractAllCoverageMetrics()

      // Union should take max of overlapping files
      expect(result.union).toBeDefined()
      expect(result.union?.branches).toBe(80) // max of 80 and 60
      expect(result.union?.statements).toBe(80)
    })

    it('handles invalid JSON gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('invalid json')

      const result = extractAllCoverageMetrics()

      expect(result.unit).toBeUndefined()
      expect(result.lambda).toBeUndefined()
    })

    it('merges non-overlapping files from unit and lambda', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes('coverage-lambda')) {
          return JSON.stringify({
            total: {
              statements: { total: 50, covered: 40, pct: 80 },
              branches: { total: 25, covered: 20, pct: 80 },
              functions: { total: 10, covered: 8, pct: 80 },
              lines: { total: 50, covered: 40, pct: 80 },
            },
            '/test/lambda-file.ts': {
              statements: { total: 50, covered: 40, pct: 80 },
              branches: { total: 25, covered: 20, pct: 80 },
              functions: { total: 10, covered: 8, pct: 80 },
              lines: { total: 50, covered: 40, pct: 80 },
            },
          })
        }
        return JSON.stringify({
          total: {
            statements: { total: 50, covered: 30, pct: 60 },
            branches: { total: 25, covered: 15, pct: 60 },
            functions: { total: 10, covered: 6, pct: 60 },
            lines: { total: 50, covered: 30, pct: 60 },
          },
          '/test/unit-file.ts': {
            statements: { total: 50, covered: 30, pct: 60 },
            branches: { total: 25, covered: 15, pct: 60 },
            functions: { total: 10, covered: 6, pct: 60 },
            lines: { total: 50, covered: 30, pct: 60 },
          },
        })
      })

      const result = extractAllCoverageMetrics()

      // Union should combine both files: 70/100 statements = 70%
      expect(result.union).toBeDefined()
      expect(result.union?.statements).toBe(70) // (40 + 30) / 100 * 100
      expect(result.union?.branches).toBe(70)   // (20 + 15) / 50 * 100
    })

    it('extracts lambda coverage independently', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes('coverage-lambda')
      })

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        total: {
          statements: { total: 100, covered: 70, pct: 70 },
          branches: { total: 50, covered: 35, pct: 70 },
          functions: { total: 20, covered: 14, pct: 70 },
          lines: { total: 100, covered: 70, pct: 70 },
        },
        '/test/file.ts': {
          statements: { total: 100, covered: 70, pct: 70 },
          branches: { total: 50, covered: 35, pct: 70 },
          functions: { total: 20, covered: 14, pct: 70 },
          lines: { total: 100, covered: 70, pct: 70 },
        },
      }))

      const result = extractAllCoverageMetrics()

      expect(result.lambda).toBeDefined()
      expect(result.lambda?.branches).toBe(70)
      expect(result.unit).toBeUndefined()
    })

    it('handles coverage data with null entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        total: {
          statements: { total: 100, covered: 80, pct: 80 },
          branches: { total: 50, covered: 40, pct: 80 },
          functions: { total: 20, covered: 15, pct: 75 },
          lines: { total: 100, covered: 85, pct: 85 },
        },
        '/test/file.ts': null,
        '/test/other.ts': {
          statements: { total: 100, covered: 80, pct: 80 },
          branches: { total: 50, covered: 40, pct: 80 },
          functions: { total: 20, covered: 15, pct: 75 },
          lines: { total: 100, covered: 85, pct: 85 },
        },
      }))

      const result = extractAllCoverageMetrics()

      // Should skip null entries
      expect(result.union).toBeDefined()
    })

    // Fixture kept from the original 'calculates percentages correctly with zero
    // totals'; what it asserts is inverted, because the rule changed. A report in
    // which NOTHING was instrumented yields no numbers at all -- not the 0 this
    // used to check for and not istanbul's 100. `union` is the one that moved:
    // normalizeMetrics prefers it, so a fabricated number here reaches the
    // quality score and the trajectory.
    it('reports no numbers at all when every denominator is zero', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        total: {
          statements: { total: 0, covered: 0, pct: 0 },
          branches: { total: 0, covered: 0, pct: 0 },
          functions: { total: 0, covered: 0, pct: 0 },
          lines: { total: 0, covered: 0, pct: 0 },
        },
        '/test/empty.ts': {
          statements: { total: 0, covered: 0, pct: 0 },
          branches: { total: 0, covered: 0, pct: 0 },
          functions: { total: 0, covered: 0, pct: 0 },
          lines: { total: 0, covered: 0, pct: 0 },
        },
      }))

      const result = extractAllCoverageMetrics()

      // Not NaN, and not 0 either: there is nothing to report a percentage of.
      expect(result.union).toBeUndefined()
      expect(result.unit).toBeUndefined()
    })

    it('handles coverage data without total property', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        '/test/file.ts': {
          statements: { total: 100, covered: 80, pct: 80 },
          branches: { total: 50, covered: 40, pct: 80 },
          functions: { total: 20, covered: 15, pct: 75 },
          lines: { total: 100, covered: 85, pct: 85 },
        },
      }))

      const result = extractAllCoverageMetrics()

      // extractFromTotal returns undefined when no total
      expect(result.unit).toBeUndefined()
      // But union should still work from file entries
      expect(result.union).toBeDefined()
    })
  })

  // =========================================================================
  // Zero denominators
  // =========================================================================
  //
  // istanbul computes every pct as `percent(covered, total)`, which returns
  // 100.0 when total is 0 (istanbul-lib-coverage/lib/percent.js). Every fixture
  // in this block is a transcript of a REAL vitest 4 + @vitest/coverage-v8 run
  // rather than a hand-written summary, because the whole question is what the
  // tool actually emits.
  describe('zero-denominator coverage', () => {
    const mockUnitSummary = (summary: unknown) => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        String(p).includes('coverage/coverage-summary.json')
      )
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(summary))
    }

    // Verbatim from `vitest run --coverage` with `include: ['src/types-only.ts']`,
    // a file containing only an interface and a type alias.
    const MEASURED_NOTHING = {
      total: {
        lines: { total: 0, covered: 0, skipped: 0, pct: 100 },
        statements: { total: 0, covered: 0, skipped: 0, pct: 100 },
        functions: { total: 0, covered: 0, skipped: 0, pct: 100 },
        branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
        branchesTrue: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
      },
      '/p/src/types-only.ts': {
        lines: { total: 0, covered: 0, skipped: 0, pct: 100 },
        functions: { total: 0, covered: 0, skipped: 0, pct: 100 },
        statements: { total: 0, covered: 0, skipped: 0, pct: 100 },
        branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
      },
    }

    // Verbatim from the same setup with `include: ['src/branchless.ts']`: two
    // functions, no conditionals anywhere. A legitimate project.
    const BRANCHLESS = {
      total: {
        lines: { total: 3, covered: 0, skipped: 0, pct: 0 },
        statements: { total: 3, covered: 0, skipped: 0, pct: 0 },
        functions: { total: 2, covered: 0, skipped: 0, pct: 0 },
        branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
        branchesTrue: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
      },
    }

    it('reports a coverage report that measured nothing as a failure, not as 100%', () => {
      mockUnitSummary(MEASURED_NOTHING)

      const reading = measureCoverage()

      expect(reading.metrics.unit).toBeUndefined()
      expect(reading.failures).toHaveLength(1)
      expect(reading.failures[0]).toMatchObject({
        kind: 'measured-nothing',
        dimension: 'coverage.unit',
      })
    })

    it('names the setting the adopter has to fix', () => {
      mockUnitSummary(MEASURED_NOTHING)

      const message = measureCoverage().failures[0].message

      // A failure the reader cannot act on is half a fix.
      expect(message).toContain('include')
      expect(message).toContain('reportsDirectory')
      expect(message).toContain('QUALITY_COVERAGE_UNIT_DIR')
      // And it explains WHY the report looked fine.
      expect(message).toContain('100%')
    })

    it('carries report evidence rather than a fabricated exit code', () => {
      mockUnitSummary(MEASURED_NOTHING)

      const evidence = measureCoverage().failures[0].evidence

      // There was no child process, so claiming `exitCode: 0` would be a lie.
      expect(evidence.via).toBe('report')
      if (evidence.via !== 'report') throw new Error('expected report evidence')
      expect(evidence.attempts).toHaveLength(1)
      expect(evidence.attempts[0]).toMatchObject({
        existed: true,
        outcome: 'read',
      })
      expect(evidence.attempts[0].bytesRead).toBeGreaterThan(0)
    })

    // The load-bearing negative control. Without it, an implementation that
    // rejected EVERY zero denominator would score perfectly on the case above
    // while failing every project that happens not to use conditionals.
    it('does NOT report a legitimately branchless project as broken', () => {
      mockUnitSummary(BRANCHLESS)

      const reading = measureCoverage()

      expect(reading.failures).toEqual([])
      expect(reading.metrics.unit).toBeDefined()
      expect(reading.metrics.unit?.statements).toBe(0)
      expect(reading.metrics.unit?.functions).toBe(0)
      expect(reading.metrics.unit?.lines).toBe(0)
      // 100, not absent: 0 of 0 branches missed IS complete coverage of the
      // branches this codebase has. Safe here only because the all-zero report
      // above is refused before this line can be reached.
      expect(reading.metrics.unit?.branches).toBe(100)
    })

    // The dimension has to keep being ENFORCED, which is what dropping it
    // silently undid: evaluateFloors reports an absent metric, but
    // evaluateCeilings and evaluateMonotonic both `continue` past one.
    it('lets a branchless project satisfy every rule type on the dimension it lacks', () => {
      mockUnitSummary(BRANCHLESS)
      const reading = measureCoverage()
      const metrics: Metrics = {
        coverage: reading.metrics,
        scripts: {},
        measurementFailures: reading.failures,
      }

      expect(
        evaluateRules(
          { version: '1.0.0', description: '', rules: { floors: { 'coverage.unit.statements': 0 } } },
          metrics
        ).status
      ).toBe('pass')

      // Previously a FAILURE reading `Metric '...' not available`, which init
      // then wrote a floor for -- permanently unsatisfiable on a codebase with
      // no conditionals in it.
      const floored = evaluateRules(
        { version: '1.0.0', description: '', rules: { floors: { 'coverage.unit.branches': 50 } } },
        metrics
      )
      expect(floored.status).toBe('pass')

      // And a rule type that used to be SKIPPED on an absent value is enforced
      // against the same 100. This is the half of the defect the floors fix
      // missed: a dropped dimension passed every ceiling and every monotonic
      // rule written against it, silently, for want of a value to compare.
      const ceilinged = evaluateRules(
        { version: '1.0.0', description: '', rules: { ceilings: { 'coverage.unit.branches': 50 } } },
        metrics
      )
      expect(ceilinged.status).toBe('fail')
      expect(ceilinged.failedRules[0]).toMatchObject({ type: 'ceiling', current: 100 })
    })

    // istanbul's blankSummary emits the STRING "Unknown" for a report with no
    // file entries, which the old code wrote straight into a `number` field.
    it('treats a summary with no file entries as measuring nothing, not as "Unknown"', () => {
      mockUnitSummary({
        total: {
          lines: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
          statements: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
          functions: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
          branches: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
        },
      })

      const reading = measureCoverage()

      expect(reading.metrics.unit).toBeUndefined()
      expect(reading.failures[0]).toMatchObject({ kind: 'measured-nothing' })
    })

    it('rejects a non-numeric denominator as unparseable rather than guessing', () => {
      mockUnitSummary({
        total: {
          lines: { total: 10, covered: 5, pct: 50 },
          statements: { total: 10, covered: 5, pct: 50 },
          functions: { total: 2, covered: 1, pct: 50 },
          branches: { total: 'lots', covered: 0, pct: 100 },
        },
      })

      const reading = measureCoverage()

      expect(reading.metrics.unit).toBeUndefined()
      expect(reading.failures[0]).toMatchObject({
        kind: 'unparseable-output',
        dimension: 'coverage.unit',
      })
      expect(reading.failures[0].message).toContain('total.branches')
    })

    it('rejects a non-numeric pct over a real denominator', () => {
      mockUnitSummary({
        total: {
          lines: { total: 10, covered: 5, pct: 50 },
          statements: { total: 10, covered: 5, pct: 'fifty' },
          functions: { total: 2, covered: 1, pct: 50 },
          branches: { total: 4, covered: 2, pct: 50 },
        },
      })

      const reading = measureCoverage()

      expect(reading.metrics.unit).toBeUndefined()
      expect(reading.failures[0]).toMatchObject({ kind: 'unparseable-output' })
      expect(reading.failures[0].message).toContain('total.statements.pct')
    })

    // A report that exists but cannot be parsed used to be indistinguishable
    // from an unmeasured project: `catch { // Skip if invalid }`.
    it('reports a corrupt report as a failure, so a coverage floor fails instead of skipping', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        String(p).includes('coverage/coverage-summary.json')
      )
      vi.mocked(fs.readFileSync).mockReturnValue('this is not json')

      const reading = measureCoverage()

      expect(reading.metrics.unit).toBeUndefined()
      expect(reading.failures[0]).toMatchObject({
        kind: 'unparseable-output',
        dimension: 'coverage.unit',
      })
      const evidence = reading.failures[0].evidence
      if (evidence.via !== 'report') throw new Error('expected report evidence')
      expect(evidence.attempts[0]).toMatchObject({ outcome: 'invalid-json', existed: true })
      expect(evidence.attempts[0].bytesRead).not.toBeNull()

      // The whole point: green over a dimension that was never measured. A
      // corrupt report leaves `coverage.unit.branches` absent, and a FLOOR on an
      // absent metric is the one rule type that already complained -- so the
      // assertion is that the verdict names the measurement rather than the
      // absence, which is the difference between "the report is not JSON" and
      // "Metric '...' not available".
      const verdict = evaluateRules(
        {
          version: '1.0.0',
          description: '',
          rules: {
            ceilings: { 'eslint.errors': 0 },
            floors: { 'coverage.unit.branches': 50 },
          },
        },
        { coverage: reading.metrics, scripts: {}, measurementFailures: reading.failures }
      )
      expect(verdict.status).toBe('fail')
      expect(verdict.failedRules[0].rule).toBe('coverage.unit.measurement')

      // And with no coverage rule at all it does not gate -- the scoping rule
      // from evaluateMeasurements. Still recorded, still rendered by
      // describeUnmeasured; just not a verdict about a dimension nobody grades.
      const ungated = evaluateRules(
        { version: '1.0.0', description: '', rules: { ceilings: { 'eslint.errors': 0 } } },
        { coverage: reading.metrics, scripts: {}, eslint: { errors: 0, warnings: 0 }, measurementFailures: reading.failures }
      )
      expect(ungated.status).toBe('pass')
    })

    it('reports valid JSON that is not an object as the wrong shape', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        String(p).includes('coverage/coverage-summary.json')
      )
      vi.mocked(fs.readFileSync).mockReturnValue('[1, 2, 3]')

      const reading = measureCoverage()

      const evidence = reading.failures[0].evidence
      if (evidence.via !== 'report') throw new Error('expected report evidence')
      expect(evidence.attempts[0].outcome).toBe('wrong-shape')
    })

    // A missing report stays silent. `lambdaDir` defaults to `coverage-lambda`,
    // which almost no project has, so failing on absence would fail everyone.
    it('stays silent when no report exists at all', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const reading = measureCoverage()

      expect(reading.failures).toEqual([])
      expect(reading.metrics.unit).toBeUndefined()
      expect(reading.metrics.lambda).toBeUndefined()
    })

    // The healthy control: a normal report must be untouched by all of the above.
    it('leaves a healthy report exactly as it was', () => {
      mockUnitSummary({
        total: {
          statements: { total: 16, covered: 4, pct: 25 },
          branches: { total: 10, covered: 4, pct: 40 },
          functions: { total: 7, covered: 1, pct: 14.28 },
          lines: { total: 14, covered: 3, pct: 21.42 },
        },
      })

      const reading = measureCoverage()

      expect(reading.failures).toEqual([])
      expect(reading.metrics.unit).toEqual({
        statements: 25,
        branches: 40,
        functions: 14.28,
        lines: 21.42,
      })
    })

    it('keeps the metrics key order the refactor harness compares byte-for-byte', () => {
      mockUnitSummary({
        total: {
          statements: { total: 16, covered: 4, pct: 25 },
          branches: { total: 10, covered: 4, pct: 40 },
          functions: { total: 7, covered: 1, pct: 14.28 },
          lines: { total: 14, covered: 3, pct: 21.42 },
        },
      })

      // accept-refactor.mjs compares sections with raw JSON.stringify and does
      // NOT sort keys, so `{unit, union}` and `{union, unit}` are a rejection
      // with no numeric change at all.
      expect(Object.keys(measureCoverage().metrics)).toEqual(['lambda', 'unit', 'union'])
    })
  })

  describe('extractCoverageMetrics', () => {
    it('returns undefined when no coverage data', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = extractCoverageMetrics()

      expect(result).toBeUndefined()
    })

    it('returns merged coverage when both exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes('coverage-lambda')) {
          return JSON.stringify({
            total: {
              statements: { total: 100, covered: 50, pct: 50 },
              branches: { total: 50, covered: 25, pct: 50 },
              functions: { total: 20, covered: 10, pct: 50 },
              lines: { total: 100, covered: 50, pct: 50 },
            },
            '/test/file.ts': {
              statements: { total: 100, covered: 50, pct: 50 },
              branches: { total: 50, covered: 25, pct: 50 },
              functions: { total: 20, covered: 10, pct: 50 },
              lines: { total: 100, covered: 50, pct: 50 },
            },
          })
        }
        return JSON.stringify({
          total: {
            statements: { total: 100, covered: 80, pct: 80 },
            branches: { total: 50, covered: 40, pct: 80 },
            functions: { total: 20, covered: 15, pct: 75 },
            lines: { total: 100, covered: 85, pct: 85 },
          },
          '/test/file.ts': {
            statements: { total: 100, covered: 80, pct: 80 },
            branches: { total: 50, covered: 40, pct: 80 },
            functions: { total: 20, covered: 15, pct: 75 },
            lines: { total: 100, covered: 85, pct: 85 },
          },
        })
      })

      const result = extractCoverageMetrics()

      // Should return union coverage
      expect(result).toBeDefined()
      expect(result?.branches).toBe(80) // max of 80 and 50
    })
  })
})

describe('SLOC Extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 0 when directory does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = extractSloc('/nonexistent')

    expect(result).toBe(0)
  })

  it('counts lines in TypeScript files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'file.ts', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(`
function foo() {
  return 1
}
`)

    const result = extractSloc('/test/src')

    expect(result).toBeGreaterThan(0)
  })

  it('skips test files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'file.test.ts', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('skips declaration files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'types.d.ts', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('skips node_modules directory', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'node_modules', isDirectory: () => true, isFile: () => false } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('handles block comments correctly', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'file.ts', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(`
/*
 * Multi-line comment
 * should not be counted
 */
const x = 1
// Single line comment
const y = 2
`)

    const result = extractSloc('/test/src')

    // Should only count 'const x = 1' and 'const y = 2'
    expect(result).toBe(2)
  })

  it('handles single-line block comments', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'file.ts', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(`/* comment */
const x = 1`)

    const result = extractSloc('/test/src')

    // Single-line block comment doesn't set inBlockComment flag
    expect(result).toBe(1)
  })

  it('recursively walks subdirectories', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)

    let readdirCallCount = 0
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      readdirCallCount++
      if (readdirCallCount === 1) {
        return [
          { name: 'subdir', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        ]
      }
      return [
        { name: 'file.ts', isDirectory: () => false, isFile: () => true } as fs.Dirent,
      ]
    })
    vi.mocked(fs.readFileSync).mockReturnValue('const x = 1')

    const result = extractSloc('/test/src')

    expect(result).toBe(1)
    expect(readdirCallCount).toBe(2) // Root + subdir
  })

  it('skips dist directory', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'dist', isDirectory: () => true, isFile: () => false } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('skips coverage directory', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'coverage', isDirectory: () => true, isFile: () => false } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('skips .git directory', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: '.git', isDirectory: () => true, isFile: () => false } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('skips .next directory', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: '.next', isDirectory: () => true, isFile: () => false } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('skips build directory', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'build', isDirectory: () => true, isFile: () => false } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('counts .tsx files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'component.tsx', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])
    vi.mocked(fs.readFileSync).mockReturnValue('export const Component = () => <div>Hello</div>')

    const result = extractSloc('/test/src')

    expect(result).toBe(1)
  })

  it('counts .js files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'script.js', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])
    vi.mocked(fs.readFileSync).mockReturnValue('console.log("hello")')

    const result = extractSloc('/test/src')

    expect(result).toBe(1)
  })

  it('counts .jsx files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'component.jsx', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])
    vi.mocked(fs.readFileSync).mockReturnValue('export const App = () => <div/>')

    const result = extractSloc('/test/src')

    expect(result).toBe(1)
  })

  it('skips .spec.ts files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'file.spec.ts', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('skips non-matching extensions', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'readme.md', isDirectory: () => false, isFile: () => true } as fs.Dirent,
      { name: 'config.json', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('handles file read errors gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'file.ts', isDirectory: () => false, isFile: () => true } as fs.Dirent,
    ])
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Permission denied')
    })

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('handles directory read errors gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error('Permission denied')
    })

    const result = extractSloc('/test/src')

    expect(result).toBe(0)
  })

  it('uses default src directory when not specified', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([])

    extractSloc() // No argument

    expect(fs.existsSync).toHaveBeenCalledWith('/test/project/src')
  })
})

describe('Script Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('runScript', () => {
    it('returns pass when script exits with 0', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })

      const result = runScript('test')

      expect(result).toBe('pass')
    })

    it('returns fail when script exits with non-zero', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'error',
        pid: 123,
        signal: null,
        output: [],
      })

      const result = runScript('test')

      expect(result).toBe('fail')
    })
  })

  describe('runScripts', () => {
    it('runs multiple scripts and returns results', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          status: 0,
          stdout: '',
          stderr: '',
          pid: 123,
          signal: null,
          output: [],
        })
        .mockReturnValueOnce({
          status: 1,
          stdout: '',
          stderr: '',
          pid: 124,
          signal: null,
          output: [],
        })

      const result = runScripts(['test', 'lint'])

      expect(result).toEqual({
        test: 'pass',
        lint: 'fail',
      })
    })
  })
})

describe('TypeScript Metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 0 errors when type-check passes', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractTypescriptMetrics()

    expect(result.errors).toBe(0)
    expect(result.warnings).toBe(0)
  })

  it('counts TypeScript errors from output', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: `src/file.ts(10,5): error TS2345: Argument of type 'string' is not assignable.
src/file.ts(15,3): error TS2339: Property 'foo' does not exist.`,
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractTypescriptMetrics()

    expect(result.errors).toBe(2)
  })

  it('counts root causes (unique file+code combinations)', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: `src/file.ts(10,5): error TS2345: First error.
src/file.ts(15,3): error TS2345: Same error code, same file.
src/other.ts(5,1): error TS2345: Same error code, different file.`,
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractTypescriptMetrics()

    expect(result.errors).toBe(3)
    // Root causes: src/file.ts:TS2345, src/other.ts:TS2345 = 2
    expect(result.rootCauses).toBe(2)
  })

  it('counts errors from stderr as well as stdout', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: `src/file.ts(10,5): error TS2345: Error in stdout.`,
      stderr: `src/other.ts(5,1): error TS2339: Error in stderr.`,
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractTypescriptMetrics()

    expect(result.errors).toBe(2) // Both stdout and stderr are combined
  })

  it('uses regex fallback count when parsing fails', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: `error TS2345: Some weird format
error TS2339: Another weird format`,
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractTypescriptMetrics()

    // Regex fallback should find 2 errors
    expect(result.errors).toBe(2)
  })

  it('uses max of parsed and regex counts', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: `src/file.ts(10,5): error TS2345: Parseable error.
error TS2339: Unparseable error.
error TS1234: Another unparseable error.`,
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractTypescriptMetrics()

    // 1 parsed + 3 regex matches = max(1, 3) = 3
    expect(result.errors).toBe(3)
  })

  // This previously asserted `errors === 0`. A non-zero exit with no output at
  // all is a type-check that died -- a crash, a kill, a missing script -- and
  // scoring it zero satisfied a `typescript.errors: 0` ceiling. Absence is now
  // the answer, and extractAllMetrics records the reason beside it so the gate
  // fails rather than skipping the rule.
  it('reports no metrics at all when the type-check produced nothing', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    expect(extractTypescriptMetrics()).toBeUndefined()
  })

  it('reports no metrics when the type-check produced no streams', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: null as unknown as string,
      stderr: null as unknown as string,
      pid: 123,
      signal: null,
      output: [],
    })

    expect(extractTypescriptMetrics()).toBeUndefined()
  })
})

describe('ESLint Metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 0 errors when eslint passes', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractEslintMetrics()

    expect(result.errors).toBe(0)
    expect(result.warnings).toBe(0)
  })

  it('counts ESLint errors and warnings', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: JSON.stringify([
        {
          filePath: '/test/file.ts',
          errorCount: 2,
          warningCount: 3,
          messages: [
            { ruleId: 'no-unused-vars', severity: 2, message: 'error', line: 1, column: 1 },
            { ruleId: 'no-unused-vars', severity: 2, message: 'error', line: 2, column: 1 },
            { ruleId: 'no-console', severity: 1, message: 'warning', line: 3, column: 1 },
            { ruleId: 'no-console', severity: 1, message: 'warning', line: 4, column: 1 },
            { ruleId: 'prefer-const', severity: 1, message: 'warning', line: 5, column: 1 },
          ],
        },
      ]),
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractEslintMetrics()

    expect(result.errors).toBe(2)
    expect(result.warnings).toBe(3)
  })

  it('counts root causes (unique file+rule combinations)', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: JSON.stringify([
        {
          filePath: '/test/file.ts',
          errorCount: 3,
          warningCount: 0,
          messages: [
            { ruleId: 'no-unused-vars', severity: 2, message: 'error', line: 1, column: 1 },
            { ruleId: 'no-unused-vars', severity: 2, message: 'error', line: 2, column: 1 },
            { ruleId: 'no-explicit-any', severity: 2, message: 'error', line: 3, column: 1 },
          ],
        },
        {
          filePath: '/test/other.ts',
          errorCount: 1,
          warningCount: 0,
          messages: [
            { ruleId: 'no-unused-vars', severity: 2, message: 'error', line: 1, column: 1 },
          ],
        },
      ]),
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractEslintMetrics()

    expect(result.errors).toBe(4)
    // Root causes: file.ts:no-unused-vars, file.ts:no-explicit-any, other.ts:no-unused-vars = 3
    expect(result.rootCauses).toBe(3)
  })

  // This previously asserted `errors === 1`, "falls back to exit code". It
  // failed the ceiling, so it looked safe, but it reported a linter that could
  // not run as one ordinary lint error -- sending whoever read it hunting for a
  // code problem that does not exist.
  it('reports no metrics when eslint emitted something other than a report', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: 'not valid json',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    expect(extractEslintMetrics()).toBeUndefined()
  })

  // The dangerous half of the pair, and the one that used to pass the gate:
  // this previously asserted `errors === 0` with the comment "Exit code 0 = no
  // errors". Exit 0 says the PROCESS was fine, not that its output was a
  // findings report -- and unparseable output means nothing was counted.
  it('does not read a clean exit with garbage output as a clean project', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'not valid json',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    expect(extractEslintMetrics()).toBeUndefined()
  })

  it('ignores warnings when counting root causes', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          filePath: '/test/file.ts',
          errorCount: 0,
          warningCount: 2,
          messages: [
            { ruleId: 'no-console', severity: 1, message: 'warning', line: 1, column: 1 },
            { ruleId: 'no-console', severity: 1, message: 'warning', line: 2, column: 1 },
          ],
        },
      ]),
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractEslintMetrics()

    expect(result.errors).toBe(0)
    expect(result.warnings).toBe(2)
    expect(result.rootCauses).toBe(0) // Only errors count as root causes
  })

  it('handles messages without ruleId', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: JSON.stringify([
        {
          filePath: '/test/file.ts',
          errorCount: 1,
          warningCount: 0,
          messages: [
            { ruleId: null, severity: 2, message: 'error', line: 1, column: 1 },
          ],
        },
      ]),
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractEslintMetrics()

    expect(result.errors).toBe(1)
    expect(result.rootCauses).toBe(0) // null ruleId not counted as root cause
  })
})

describe('SonarQube Metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('extractSonarqubeMetrics', () => {
    it('returns metrics when API responds successfully', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        component: {
          measures: [
            { metric: 'bugs', value: '5' },
            { metric: 'vulnerabilities', value: '2' },
            { metric: 'code_smells', value: '10' },
            { metric: 'coverage', value: '75.5' },
            { metric: 'duplicated_lines_density', value: '3.2' },
            { metric: 'blocker_violations', value: '1' },
            { metric: 'critical_violations', value: '2' },
            { metric: 'major_violations', value: '5' },
            { metric: 'minor_violations', value: '8' },
            { metric: 'info_violations', value: '3' },
          ],
        },
      }))

      const result = extractSonarqubeMetrics()

      expect(result).toBeDefined()
      expect(result?.bugs).toBe(5)
      expect(result?.vulnerabilities).toBe(2)
      expect(result?.codeSmells).toBe(10)
      expect(result?.coverage).toBe(75.5)
      expect(result?.duplications).toBe(3.2)
      expect(result?.blocker).toBe(1)
      expect(result?.critical).toBe(2)
      expect(result?.major).toBe(5)
      expect(result?.minor).toBe(8)
      expect(result?.info).toBe(3)
    })

    it('returns undefined when API fails', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Connection refused')
      })

      const result = extractSonarqubeMetrics()

      expect(result).toBeUndefined()
    })

    it('returns undefined when response has no measures', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        component: {},
      }))

      const result = extractSonarqubeMetrics()

      expect(result).toBeUndefined()
    })

    it('returns undefined when response has empty measures', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        component: {
          measures: [],
        },
      }))

      const result = extractSonarqubeMetrics()

      expect(result).toBeUndefined()
    })

    it('returns 0 for missing metrics', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        component: {
          measures: [
            { metric: 'bugs', value: '3' },
          ],
        },
      }))

      const result = extractSonarqubeMetrics()

      expect(result).toBeDefined()
      expect(result?.bugs).toBe(3)
      expect(result?.vulnerabilities).toBe(0) // Missing metric
      expect(result?.codeSmells).toBe(0)
    })
  })

  describe('isSonarqubeAvailable', () => {
    it('returns true when SonarQube responds', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue('200')

      const result = isSonarqubeAvailable()

      expect(result).toBe(true)
    })

    it('returns false when SonarQube is unreachable', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Connection refused')
      })

      const result = isSonarqubeAvailable()

      expect(result).toBe(false)
    })
  })

  describe('getTopSonarIssues', () => {
    it('returns issues from API', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        issues: [
          {
            severity: 'MAJOR',
            type: 'CODE_SMELL',
            message: 'Refactor this function.',
            component: 'test-project:src/file.ts',
            line: 10,
            rule: 'typescript:S1234',
          },
          {
            severity: 'CRITICAL',
            type: 'BUG',
            message: 'Fix this bug.',
            component: 'test-project:src/other.ts',
            rule: 'typescript:S5678',
          },
        ],
        total: 2,
      }))

      const result = getTopSonarIssues(10)

      expect(result).toHaveLength(2)
      expect(result[0].severity).toBe('MAJOR')
      expect(result[0].component).toBe('src/file.ts') // Project key stripped
      expect(result[0].line).toBe(10)
      expect(result[1].severity).toBe('CRITICAL')
      expect(result[1].component).toBe('src/other.ts')
      expect(result[1].line).toBeUndefined()
    })

    it('returns empty array when API fails', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Timeout')
      })

      const result = getTopSonarIssues()

      expect(result).toEqual([])
    })

    it('returns empty array when no issues in response', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        total: 0,
      }))

      const result = getTopSonarIssues()

      expect(result).toEqual([])
    })
  })

  describe('runSonarqubeScan', () => {
    it('returns success when scan completes', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: 'Scan completed',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })
      vi.mocked(fs.existsSync).mockReturnValue(false) // No task ID file

      const result = runSonarqubeScan()

      expect(result.success).toBe(true)
    })

    it('returns failure when scan fails', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'Analysis failed',
        pid: 123,
        signal: null,
        output: [],
      })

      const result = runSonarqubeScan()

      expect(result.success).toBe(false)
      expect(result.error).toContain('Analysis failed')
    })

    it('waits for task when task ID is found', async () => {
      const { spawnSync, execSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task123\nserverUrl=http://localhost:9000')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        task: { id: 'task123', status: 'SUCCESS' },
      }))

      const result = runSonarqubeScan()

      expect(result.success).toBe(true)
    })

    it('returns failure when task fails', async () => {
      const { spawnSync, execSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task123')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        task: { id: 'task123', status: 'FAILED', errorMessage: 'Analysis error' },
      }))

      const result = runSonarqubeScan()

      expect(result.success).toBe(false)
      expect(result.error).toContain('Analysis error')
    })

    it('returns failure when task is canceled', async () => {
      const { spawnSync, execSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task123')
      vi.mocked(execSync).mockReturnValue(JSON.stringify({
        task: { id: 'task123', status: 'CANCELED' },
      }))

      const result = runSonarqubeScan()

      expect(result.success).toBe(false)
      expect(result.error).toContain('canceled')
    })

    it('retries on transient WebSocket error', async () => {
      const { spawnSync } = await import('child_process')
      let npmCallCount = 0
      vi.mocked(spawnSync).mockImplementation((cmd) => {
        if (cmd === 'sleep') {
          return { status: 0, stdout: '', stderr: '', pid: 0, signal: null, output: [] }
        }
        npmCallCount++
        if (npmCallCount === 1) {
          return {
            status: 1,
            stdout: '',
            stderr: 'WebSocket connection error',
            pid: 123,
            signal: null,
            output: [],
          }
        }
        // Second npm call succeeds
        return {
          status: 0,
          stdout: 'OK',
          stderr: '',
          pid: 124,
          signal: null,
          output: [],
        }
      })
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = runSonarqubeScan()

      expect(result.success).toBe(true)
      expect(npmCallCount).toBe(2) // Retried once
    })

    it('retries on Connection reset error', async () => {
      const { spawnSync } = await import('child_process')
      let callCount = 0
      vi.mocked(spawnSync).mockImplementation(() => {
        callCount++
        if (callCount <= 2) { // First npm run + first sleep
          if (callCount === 1) {
            return {
              status: 1,
              stdout: 'Connection reset',
              stderr: '',
              pid: 123,
              signal: null,
              output: [],
            }
          }
          // Sleep call
          return { status: 0, stdout: '', stderr: '', pid: 0, signal: null, output: [] }
        }
        // Second npm run succeeds
        return {
          status: 0,
          stdout: 'OK',
          stderr: '',
          pid: 124,
          signal: null,
          output: [],
        }
      })
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = runSonarqubeScan()

      expect(result.success).toBe(true)
    })

    it('fails after max retries on transient errors', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockImplementation((cmd) => {
        if (cmd === 'sleep') {
          return { status: 0, stdout: '', stderr: '', pid: 0, signal: null, output: [] }
        }
        return {
          status: 1,
          stdout: '',
          stderr: 'WebSocket connection error',
          pid: 123,
          signal: null,
          output: [],
        }
      })
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = runSonarqubeScan()

      expect(result.success).toBe(false)
    })

    it('handles report-task.txt read error', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Permission denied')
      })

      const result = runSonarqubeScan()

      // Should succeed because no task ID found
      expect(result.success).toBe(true)
    })

    it('handles report-task.txt without ceTaskId', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('serverUrl=http://localhost:9000\nprojectKey=myproject')

      const result = runSonarqubeScan()

      // Should succeed because no task ID found
      expect(result.success).toBe(true)
    })
  })
})

// ===========================================================================
// Coverage report ordering
// ===========================================================================
//
// extractAllMetrics built its result as ONE object literal, and JS evaluates
// literal properties top-to-bottom -- so `coverage:` read the report before
// `scripts:` ran the npm scripts that rewrite it. Reproduced end to end against
// the synthetic subject: with a 10%-statements report planted and scriptsToRun
// ['test:coverage'], the gate reported 10 while the file on disk afterwards said
// 25.
//
// What the ordering does NOT establish is that a report no script the gate ran
// rewrote describes the code being graded. A freshness rule for that was built
// (report mtime vs. the newest source file) and removed -- inert without a
// literal top-level `src/`, false-positive on mtime-preserving restores, branch
// switches and clock skew -- so its tests are gone with it. Backlog #39.
describe('coverage report ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The cheap fast regression for the ordering itself. NOT the proof -- with fs
  // mocked nothing actually writes coverage, so only the harness case can show
  // the numbers moving. This pins the call order so a later reshuffle of the
  // return literal fails here first.
  it('runs the project scripts BEFORE reading the coverage report', async () => {
    const { spawnSync, execSync } = await import('child_process')
    const sequence: string[] = []

    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).includes('coverage/coverage-summary.json')
    )
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).includes('coverage-summary.json')) sequence.push('read-coverage-report')
      return JSON.stringify({
        total: {
          statements: { total: 10, covered: 5, pct: 50 },
          branches: { total: 10, covered: 5, pct: 50 },
          functions: { total: 10, covered: 5, pct: 50 },
          lines: { total: 10, covered: 5, pct: 50 },
        },
      })
    })
    vi.mocked(spawnSync).mockImplementation(((cmd: string, args?: readonly string[]) => {
      if (cmd === 'npm' && args?.[0] === 'run' && args?.[1] === 'test:coverage') {
        sequence.push('run-test:coverage')
      }
      return { status: 0, stdout: '[]', stderr: '', pid: 1, signal: null, output: [] }
    }) as unknown as typeof spawnSync)
    vi.mocked(execSync).mockReturnValue('')

    extractAllMetrics({
      scriptsToRun: ['test:coverage'],
      skipSonarQube: true,
      skipCustomDimensions: true,
    })

    expect(sequence.indexOf('run-test:coverage')).toBeGreaterThanOrEqual(0)
    expect(sequence.indexOf('read-coverage-report')).toBeGreaterThanOrEqual(0)
    expect(sequence.indexOf('run-test:coverage')).toBeLessThan(
      sequence.indexOf('read-coverage-report')
    )
  })
})

describe('extractAllMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts all metrics with default options', async () => {
    const { spawnSync, execSync } = await import('child_process')

    // Coverage files don't exist
    vi.mocked(fs.existsSync).mockReturnValue(false)

    // TypeScript/ESLint/scripts pass
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    // SonarQube returns metrics
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      component: {
        measures: [
          { metric: 'bugs', value: '0' },
        ],
      },
    }))

    const result = extractAllMetrics()

    expect(result.coverage).toBeDefined()
    expect(result.typescript).toBeDefined()
    expect(result.eslint).toBeDefined()
    expect(result.sonarqube).toBeDefined()
    expect(result.scripts).toBeDefined()
    expect(result.sloc).toBe(0)
  })

  it('accepts array of scripts for backward compatibility', async () => {
    const { spawnSync, execSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ component: { measures: [] } }))

    const result = extractAllMetrics(['test', 'lint'])

    expect(result.scripts).toEqual({
      test: 'pass',
      lint: 'pass',
    })
  })

  it('skips SonarQube when skipSonarQube is true', async () => {
    const { spawnSync, execSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })

    const result = extractAllMetrics({ skipSonarQube: true })

    expect(result.sonarqube).toBeUndefined()
    expect(execSync).not.toHaveBeenCalled()
  })

  it('extracts custom metrics when dimensions provided', async () => {
    const { spawnSync, execSync } = await import('child_process')

    // Mock file existence - return false for coverage files
    vi.mocked(fs.existsSync).mockReturnValue(false)
    // Custom extractors go through spawnSync now, alongside eslint and tsc, so
    // the stub has to answer per command rather than uniformly.
    vi.mocked(spawnSync).mockImplementation((cmd) => ({
      status: 0,
      stdout: String(cmd).includes('custom-output.json')
        ? JSON.stringify({ customValue: 42 })
        : '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    }) as ReturnType<typeof spawnSync>)
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ component: { measures: [] } }))

    const result = extractAllMetrics({
      customDimensions: [
        {
          path: 'custom.test_dim',
          displayName: 'Test Dimension',
          direction: 'lower-better',
          extractor: {
            type: 'script',
            command: 'cat /test/project/custom-output.json',
            parseOutput: 'json',
            jsonPath: 'customValue',
          },
        },
      ],
    })

    expect(result.custom).toBeDefined()
    expect(result.custom?.['test_dim']).toBe(42)
    expect(result.measurementFailures).toBeUndefined()
  })

  it('reports a broken custom extractor as a measurement failure, not as zero', async () => {
    // The dangerous case: `custom.*` is gated by ceilings alone and a
    // lower-better dimension is best at zero, so a broken extractor used to
    // report a perfect score for a dimension nobody measured.
    const { spawnSync, execSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockImplementation((cmd) => ({
      // Non-zero only for the custom extractor; eslint and tsc stay healthy so
      // the failure below cannot be theirs.
      status: String(cmd).includes('complexity-tool') ? 127 : 0,
      stdout: '[]',
      stderr: String(cmd).includes('complexity-tool') ? 'command not found\n' : '',
      pid: 123,
      signal: null,
      output: [],
    }) as ReturnType<typeof spawnSync>)
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ component: { measures: [] } }))

    const result = extractAllMetrics({
      customDimensions: [
        {
          path: 'custom.complexity',
          displayName: 'Complexity',
          direction: 'lower-better',
          extractor: { type: 'script', command: 'complexity-tool --score' },
        },
      ],
    })

    expect(result.custom?.['complexity']).toBeUndefined()
    expect(result.measurementFailures).toHaveLength(1)
    expect(result.measurementFailures?.[0]).toMatchObject({
      kind: 'crashed',
      dimension: 'custom.complexity',
    })
  })

  it('skips custom metrics when skipCustomDimensions is true', async () => {
    const { spawnSync, execSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ component: { measures: [] } }))

    const result = extractAllMetrics({
      skipCustomDimensions: true,
      customDimensions: [
        {
          path: 'custom.test_dim',
          displayName: 'Test Dimension',
          direction: 'lower-is-better',
          extractor: {
            type: 'json',
            filePath: '/test/project/test.json',
            jsonPath: 'value',
          },
        },
      ],
    })

    expect(result.custom).toBeUndefined()
  })

  it('skips custom metrics when no dimensions provided', async () => {
    const { spawnSync, execSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ component: { measures: [] } }))

    const result = extractAllMetrics({
      customDimensions: [],
    })

    expect(result.custom).toBeUndefined()
  })
})

describe('extractAllMetricsAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads custom dimensions automatically', async () => {
    const { spawnSync, execSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ component: { measures: [] } }))

    const result = await extractAllMetricsAsync()

    expect(result.coverage).toBeDefined()
    expect(result.typescript).toBeDefined()
    expect(result.eslint).toBeDefined()
  })

  it('uses provided custom dimensions instead of loading', async () => {
    const { spawnSync, execSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ component: { measures: [] } }))

    const result = await extractAllMetricsAsync({
      customDimensions: [],
    })

    expect(result.custom).toBeUndefined()
  })

  it('skips custom dimension loading when skipCustomDimensions is true', async () => {
    const { spawnSync, execSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ component: { measures: [] } }))

    const result = await extractAllMetricsAsync({
      skipCustomDimensions: true,
    })

    expect(result.custom).toBeUndefined()
  })
})
