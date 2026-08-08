import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { spawnSync } from 'child_process'
import { evaluateRules } from '../src/rules.js'
import { binaryInvocation } from '../src/runner.js'
import type { RunnerSelection } from '../src/runner.js'
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
  readSonarqubeMetrics,
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

/**
 * Two runner functions are stubbed, both only because `fs` is mocked above -- the runner
 * settles existence through the same `existsSync`/`readFileSync` these tests aim at
 * coverage reports.
 *
 * `manifestDefinesScript`: without it every script reads as undefined and `runScript`
 * short-circuits to `fail` before spawning anything.
 *
 * `binaryInvocation`: without it `node_modules/.bin/eslint` reads as absent, so every
 * lint measurement below refuses with `tool-missing` before spawning. Both are stubbed
 * to "it is there", which is the premise of these tests -- "the tool exists, here is what
 * running it does". The COMMAND still comes from the real builder, so the `--no-install`
 * flag is not mocked away.
 *
 * Stubbing `resolveProjectBinary` instead would NOT work, and it is worth knowing why:
 * `binaryInvocation` calls it through a module-internal reference, which a partial ESM
 * mock of the module's exports does not intercept.
 *
 * The real behaviour of both is covered against real files in tests/runner.test.ts and
 * tests/providers/eslint.test.ts -- including the bun `.bin` script fall-through, and the
 * refusal one describe below overrides this stub to reach.
 */
vi.mock('../src/runner.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runner.js')>('../src/runner.js')
  return {
    ...actual,
    manifestDefinesScript: vi.fn(() => true),
    binaryInvocation: vi.fn(
      (binary: string, args: readonly string[], selection: RunnerSelection) => ({
        kind: 'runnable' as const,
        command: actual.binaryCommand(binary, args, selection),
        shimPath: `/test/project/node_modules/.bin/${binary}`,
      })
    ),
  }
})

// Mock config
vi.mock('../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    projectRoot: '/test/project',
    // Every spawn-based measurement reads this; a mock without it makes the
    // providers throw rather than measure.
    packageManager: { manager: 'npm', reason: 'test fixture' },
    typecheckScript: { script: 'type-check', reason: 'test fixture', definedInManifest: true },
    coverage: {
      unitDir: 'coverage',
      lambdaDir: 'coverage-lambda',
      summaryFile: 'coverage-summary.json',
      // Matches the real defaults. `required` is no longer read on this path -- the
      // caller resolves the opt-out, because it depends on the rules -- but it stays
      // here so the mock keeps describing a real config object.
      required: true,
      // Both false, which is what an unset QUALITY_COVERAGE_*_DIR gives. That makes
      // this mock the ordinary single-suite project: the unit summary is required
      // because nothing else was read, and the phantom lambda suite is not.
      unitDirConfigured: false,
      lambdaDirConfigured: false,
    },
    sonarqube: {
      url: 'http://localhost:9000',
      projectKey: 'test-project',
    },
    defaultScriptTimeout: 60000,
    scriptTimeouts: {},
  })),
  getSonarCurlAuth: vi.fn(() => ''),
  sonarAuthArgs: vi.fn(() => []),
  redactUrlCredentials: vi.fn((url: string) => url),
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

    // #43. The GATE path requires the unit report to exist, because an absent one
    // produced no metric and no failure, and a ceiling or monotonic coverage rule
    // reads an undefined value as nothing to check. The lambda report stays
    // unrequired: `lambdaDir` defaults to `coverage-lambda`, which almost no
    // project has, so failing on ITS absence would fail everyone (#38).
    it('reports a missing unit report and stays silent about lambda', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const reading = measureCoverage()

      expect(reading.failures).toHaveLength(1)
      expect(reading.failures[0]).toMatchObject({
        kind: 'report-missing',
        dimension: 'coverage.unit',
      })
      expect(reading.metrics.unit).toBeUndefined()
      expect(reading.metrics.lambda).toBeUndefined()
    })

    // The opt-out is the CALLER's to pass, not this module's to read from config.
    // `QUALITY_COVERAGE_REQUIRED=false` alone must not suppress the failure, because
    // whether it applies depends on the rules -- see `coverageAbsenceIsFailure` in
    // cli.ts. Two adversarial reviews reproduced the hole in the version that read
    // the flag here: the flag plus a coverage ratchet plus no report gave a silent
    // pass, cached.
    it('suppresses the missing report only when the caller asks it to', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const reading = measureCoverage({ absentReportIsFailure: false })

      expect(reading.failures).toEqual([])
      expect(reading.metrics.unit).toBeUndefined()
    })

    // The default is the loud one, so a caller that says nothing cannot lose the
    // diagnosis by omission.
    it('requires the report when the caller says nothing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      expect(measureCoverage().failures).toHaveLength(1)
      expect(measureCoverage({}).failures).toHaveLength(1)
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
    /**
     * The bun fall-through on the requiredScripts path.
     *
     * `bun run <name>` for a script package.json does not define executes a same-named
     * `node_modules/.bin` binary and can exit 0 -- so a required script the project
     * does not have would report `pass`, where npm exits 1 and reports `fail`.
     * Reproduced against bun 1.3.14.
     *
     * `manifestDefinesScript` is stubbed true for the whole file (see the mock at the
     * top, needed because `fs` is mocked), so this case has to override it explicitly.
     * Without this test the guard has NO coverage: deleting it left all 96 tests in
     * this file green, which is how a guard rots.
     */
    it('fails a script the manifest does not define, without spawning it', async () => {
      const { spawnSync } = await import('child_process')
      const { manifestDefinesScript } = await import('../src/runner.js')
      vi.mocked(manifestDefinesScript).mockReturnValueOnce(false)

      expect(runScript('type-check')).toBe('fail')
      expect(vi.mocked(spawnSync)).not.toHaveBeenCalled()
    })

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

/**
 * A SonarQube API response as `sonarGet` actually receives it: the body, then the
 * HTTP status on its own last line.
 *
 * The status line is not decoration. `curl -s` exits 0 for a 401 exactly as for a
 * 200, so the old reader saw a short unparseable string and returned `undefined` --
 * the dimension vanished with no failure recorded, and every `sonarqube.*` ceiling
 * was skipped in silence while the run was graded as a complete reading. Appending
 * `%{http_code}` is what makes refused, absent and empty three different answers.
 */
function withStatus(status: number, body: unknown): string {
  return `${typeof body === 'string' ? body : JSON.stringify(body)}\n${status}`
}

type SpawnResult = ReturnType<typeof spawnSyncShape>

function spawnSyncShape(stdout: string, status = 0) {
  return { status, stdout, stderr: '', pid: 1, signal: null, output: [] as string[] }
}

/**
 * Every measure `readSonarqubeMetrics` asks for, so a test can drop exactly one and
 * be testing that omission rather than nine others at the same time.
 */
function allMeasures(): { metric: string; value: string }[] {
  return [
    { metric: 'bugs', value: '3' },
    { metric: 'vulnerabilities', value: '2' },
    { metric: 'code_smells', value: '10' },
    { metric: 'coverage', value: '75.5' },
    { metric: 'duplicated_lines_density', value: '3.2' },
    { metric: 'blocker_violations', value: '1' },
    { metric: 'critical_violations', value: '2' },
    { metric: 'major_violations', value: '5' },
    { metric: 'minor_violations', value: '8' },
    { metric: 'info_violations', value: '3' },
  ]
}

/** A curl answer carrying this HTTP status and body, in the shape `sonarGet` reads. */
function curlSays(status: number, body: unknown): SpawnResult {
  return spawnSyncShape(withStatus(status, body))
}

/**
 * Answer curl with this response, leaving any other `spawnSync` mock in place.
 *
 * Dispatching on the command rather than replacing the mock outright, because the
 * scan tests need BOTH: a scanner invocation with its own scripted exit codes, and a
 * task poll over HTTP. A blanket `mockReturnValue` gives the poll the scanner's empty
 * stdout, which reads as "no HTTP response", which spins `waitForSonarTask` for its
 * full two minutes -- a 120-second hang rather than a failed assertion.
 *
 * These used to mock `execSync`. `sonarGet` spawns curl as argv with no shell now,
 * because interpolating `-u user:password` into a command line leaked any password
 * containing a space past the redaction regex and let one containing `;` change what
 * ran. A mock still answering `execSync` would be exercising a transport the code no
 * longer has.
 */
function answerCurl(response: SpawnResult): void {
  const existing = vi.mocked(spawnSync).getMockImplementation()
  vi.mocked(spawnSync).mockImplementation(((cmd: string, ...rest: unknown[]) =>
    cmd === 'curl'
      ? response
      : ((existing as ((...a: unknown[]) => SpawnResult) | undefined)?.(
          cmd,
          ...rest
        ) ?? spawnSyncShape(''))) as never)
}

/**
 * Answer curl per URL, because the provenance check makes two or three calls.
 *
 * `answerCurl` above answers EVERY curl invocation with one canned response, which is
 * exactly right for a test aimed at a single endpoint and useless once a code path asks
 * two questions -- the measures response would be handed to the analysis-list parser as
 * well. Dispatch is on the LAST argv element, which is always the URL in `sonarGet`'s
 * argv.
 *
 * `answerCurl` is deliberately left as it is: every existing sonar test relies on it, and
 * the default `not-scanned` provenance makes exactly one call, so none of them changes.
 */
function answerCurlByUrl(reply: (url: string) => SpawnResult): void {
  const existing = vi.mocked(spawnSync).getMockImplementation()
  vi.mocked(spawnSync).mockImplementation(((cmd: string, ...rest: unknown[]) => {
    if (cmd !== 'curl') {
      return (
        (existing as ((...a: unknown[]) => SpawnResult) | undefined)?.(cmd, ...rest) ??
        spawnSyncShape('')
      )
    }
    const argv = rest[0] as string[]
    return reply(argv[argv.length - 1])
  }) as never)
}

describe('SonarQube Metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('extractSonarqubeMetrics', () => {
    it('returns metrics when API responds successfully', async () => {
      answerCurl(curlSays(200, {
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

    // #42, the channel itself. Four ways to lose the dimension, four kinds, because
    // each sends the adopter somewhere different: fix the URL, rotate the token,
    // check the project key, or find out why the analysis published nothing. Before
    // this they were one `undefined` with no failure attached, and `extractAllMetrics`
    // never looked at sonarqube when building `measurementFailures` at all.
    describe('the failure channel', () => {
      const failureFor = async (mock: () => void) => {
        mock()
        const reading = readSonarqubeMetrics()
        expect(reading.metrics).toBeUndefined()
        const { failure } = reading
        if (!failure) throw new Error('expected a measurement failure')
        return failure
      }

      // The unreachable message is built from the thrown error, and the thrown error
      // is the whole command line -- which carries `-u <token>:`. This string reaches
      // gate output, the `unmeasured` JSON and CI logs.
      it('does not leak the sonar credential into the failure it reports', async () => {
        const { sonarAuthArgs } = await import('../src/config.js')
        vi.mocked(sonarAuthArgs).mockReturnValue([
          '-u',
          'squ_deadbeefsecrettoken:',
        ])

        const failure = await failureFor(() => {
          answerCurl({
            ...spawnSyncShape('', null as unknown as number),
            // Node builds this from the file, not the argv, so a real one would not
            // carry the token. Planted here anyway: the redaction must not depend on
            // an error format nobody in this repo controls.
            error: new Error(
              'spawnSync curl ENOENT squ_deadbeefsecrettoken'
            ) as unknown as undefined,
          })
        })

        expect(failure.message).not.toContain('squ_deadbeefsecrettoken')
        expect(failure.evidence.command).not.toContain('squ_deadbeefsecrettoken')
      })

      // The shape-dependence the value-based scrub exists to remove. `-u <redacted>`
      // consumed exactly one whitespace-free token, so this password reported
      // `-u <redacted> second` and published half of itself.
      it('redacts a credential containing a space', async () => {
        const { sonarAuthArgs } = await import('../src/config.js')
        vi.mocked(sonarAuthArgs).mockReturnValue(['-u', 'admin:first second'])

        const failure = await failureFor(() => {
          answerCurl({
            ...spawnSyncShape('', null as unknown as number),
            error: new Error(
              'spawnSync failed: -u admin:first second'
            ) as unknown as undefined,
          })
        })

        expect(failure.message).not.toContain('first second')
        expect(failure.message).not.toContain('second')
      })

      // The structural half of the same guarantee. A credential cannot be scrubbed
      // out of a message reliably -- `-u <redacted>` consumed one whitespace-free
      // token, so a password of `first second` reported `-u <redacted> second` -- so
      // the fix is that no string containing it is ever built. curl is spawned as
      // argv with no shell, which also stops a password containing `;` or a backtick
      // from changing what runs.
      it('spawns curl as argv with no shell, so the credential is never a string', () => {
        answerCurl(curlSays(200, { component: { measures: [] } }))

        readSonarqubeMetrics()

        const call = vi.mocked(spawnSync).mock.calls.find(([cmd]) => cmd === 'curl')
        if (!call) throw new Error('expected curl to be spawned')
        const [, args, options] = call as unknown as [
          string,
          string[],
          { shell?: boolean },
        ]

        expect(options.shell).toBe(false)
        expect(Array.isArray(args)).toBe(true)
        // The URL is its own argv word, not interpolated into a quoted string.
        expect(args.some((a) => a.includes('/api/measures/component'))).toBe(true)
      })

      it('reports an unreachable server as tool-missing', async () => {
        const failure = await failureFor(() => {
          answerCurl({
            ...spawnSyncShape('', null as unknown as number),
            error: new Error('connect ECONNREFUSED') as unknown as undefined,
          })
        })

        expect(failure.kind).toBe('tool-missing')
        expect(failure.dimension).toBe('sonarqube')
        expect(failure.message).toMatch(/did not answer/)
      })

      // curl exiting nonzero with no HTTP status is the same refusal as a thrown
      // spawn: `000` is what it writes when it never got a response, and reading that
      // as an answer of zero is how a dead server used to look like a clean project.
      it('reports a curl exit with no HTTP status as tool-missing', async () => {
        const failure = await failureFor(() => {
          answerCurl(spawnSyncShape('\n000', 7))
        })

        expect(failure.kind).toBe('tool-missing')
        expect(failure.message).toMatch(/did not answer/)
      })

      // The likeliest failure in practice: a rotated SONARQUBE_TOKEN needs no other
      // change to arrive, and the server stays up -- which is exactly why
      // `isSonarqubeAvailable` said yes and the gate carried on.
      it('reports a 401 as access-denied, not as an absent server', async () => {
        const failure = await failureFor(() => {
          answerCurl(curlSays(401, { errors: [{ msg: 'Insufficient privileges' }] }))
        })

        expect(failure.kind).toBe('access-denied')
        expect(failure.message).toContain('SONARQUBE_TOKEN')
      })

      it('reports an unprovisioned project key as report-missing', async () => {
        const failure = await failureFor(() => {
          answerCurl(curlSays(404, { errors: [{ msg: 'Component key not found' }] }))
        })

        expect(failure.kind).toBe('report-missing')
        expect(failure.message).toContain('404')
      })

      // A login page or proxy error in front of the API. The old reader handed this
      // straight to JSON.parse and returned undefined from the catch.
      it('reports a non-JSON 200 as unparseable-output', async () => {
        const failure = await failureFor(() => {
          answerCurl(curlSays(200, '<html>login</html>'))
        })

        expect(failure.kind).toBe('unparseable-output')
      })

      it('reports an empty measures array as measured-nothing', async () => {
        const failure = await failureFor(() => {
          answerCurl(curlSays(200, { component: { measures: [] } }))
        })

        expect(failure.kind).toBe('measured-nothing')
      })

      // The control. Without it, "always report a failure" satisfies every case above
      // and every sonarqube run would fail the gate.
      it('reports no failure when the measures arrive', () => {
        answerCurl(curlSays(200, { component: { measures: allMeasures() } }))

        const reading = readSonarqubeMetrics()

        expect(reading.failure).toBeUndefined()
        expect(reading.metrics?.bugs).toBe(3)
      })

      // A PARTIAL response used to be a complete reading: every measure the server
      // did not send became 0, so a body carrying only `bugs` reported
      // `vulnerabilities: 0` and `blocker: 0` and satisfied every ceiling on them.
      // The gate called the code clean on measures it had never been given.
      it('refuses a response that omits measures every analysis computes', () => {
        answerCurl(curlSays(200, {
          component: { measures: [{ metric: 'bugs', value: '3' }] },
        }))

        const reading = readSonarqubeMetrics()

        expect(reading.metrics).toBeUndefined()
        expect(reading.failure?.kind).toBe('measured-nothing')
        expect(reading.failure?.message).toContain('vulnerabilities')
      })

      // NaN passes every ceiling, because `NaN > 0` is false. A truncated or
      // malformed measure therefore read as a clean project rather than as a
      // response nobody could grade.
      it('refuses a measure that is not a number rather than reading it as NaN', () => {
        answerCurl(curlSays(200, {
          component: {
            measures: allMeasures().map((m) =>
              m.metric === 'bugs' ? { metric: 'bugs', value: 'NaN' } : m
            ),
          },
        }))

        const reading = readSonarqubeMetrics()

        expect(reading.metrics).toBeUndefined()
        expect(reading.failure?.kind).toBe('unparseable-output')
        expect(reading.failure?.message).toContain('bugs')
      })

      // The two conditional measures. A project that imports no coverage report into
      // its scan is not a project with 0% coverage, so these stay ABSENT -- which a
      // floor reports as "not available" instead of grading a substituted zero.
      it('leaves coverage absent rather than zero when SonarQube omits it', () => {
        answerCurl(curlSays(200, {
          component: {
            measures: allMeasures().filter(
              (m) => m.metric !== 'coverage' && m.metric !== 'duplicated_lines_density'
            ),
          },
        }))

        const reading = readSonarqubeMetrics()

        expect(reading.failure).toBeUndefined()
        expect(reading.metrics?.bugs).toBe(3)
        expect(reading.metrics?.coverage).toBeUndefined()
        expect(reading.metrics?.duplications).toBeUndefined()
      })

      // Without `--location` a 3xx body is not the API's answer -- it is an SSO login
      // page or a proxy bounce. `status < 400` accepted one of the right shape as
      // measures.
      it('refuses a redirect carrying a body of the right shape', () => {
        answerCurl(curlSays(302, { component: { measures: allMeasures() } }))

        const reading = readSonarqubeMetrics()

        expect(reading.metrics).toBeUndefined()
        expect(reading.failure?.kind).toBe('crashed')
        expect(reading.failure?.message).toMatch(/redirect/)
      })
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
      answerCurl(curlSays(200, {
        component: {},
      }))

      const result = extractSonarqubeMetrics()

      expect(result).toBeUndefined()
    })

    it('returns undefined when response has empty measures', async () => {
      answerCurl(curlSays(200, {
        component: {
          measures: [],
        },
      }))

      const result = extractSonarqubeMetrics()

      expect(result).toBeUndefined()
    })

    // Was `returns 0 for missing metrics`, asserting the defect: a response carrying
    // only `bugs` reported every other measure as a measured zero. Nothing is
    // returned now, and the reason is on the reading.
    it('returns nothing for a response missing measures every analysis computes', () => {
      answerCurl(curlSays(200, {
        component: {
          measures: [
            { metric: 'bugs', value: '3' },
          ],
        },
      }))

      expect(extractSonarqubeMetrics()).toBeUndefined()
    })
  })

  describe('isSonarqubeAvailable', () => {
    it('returns true when SonarQube responds', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue('200')

      const result = isSonarqubeAvailable()

      expect(result).toBe(true)
    })

    it('returns false when SonarQube is unreachable', () => {
      answerCurl({
        ...spawnSyncShape('', null as unknown as number),
        error: new Error('connect ECONNREFUSED') as unknown as undefined,
      })

      const result = isSonarqubeAvailable()

      expect(result).toBe(false)
    })
  })

  describe('getTopSonarIssues', () => {
    it('returns issues from API', async () => {
      answerCurl(curlSays(200, {
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

    it('returns empty array when API fails', () => {
      answerCurl({
        ...spawnSyncShape('', null as unknown as number),
        error: new Error('timed out') as unknown as undefined,
      })

      const result = getTopSonarIssues()

      expect(result).toEqual([])
    })

    it('returns empty array when no issues in response', async () => {
      answerCurl(curlSays(200, {
        total: 0,
      }))

      const result = getTopSonarIssues()

      expect(result).toEqual([])
    })
  })

  describe('runSonarqubeScan', () => {
    // #23. The scanner exiting 0 is not the same as "this commit was analysed", and
    // this test used to assert that it was. Without `.scannerwork/report-task.txt`
    // there is no task to wait for and no way to know the server ever received one --
    // so the run reported success and `readSonarqubeMetrics` then read whatever the
    // server already held, which is the PREVIOUS commit's analysis. A
    // `sonarqube.blocker: 0` ceiling satisfied by a scan of different code.
    it('refuses to call a scan successful when it cannot confirm the analysis ran', async () => {
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

      expect(result.success).toBe(false)
      // The remedy has to be named: a scanner writing .scannerwork elsewhere lands
      // here while working perfectly, and "refused" with no next step is unactionable.
      expect(result.error).toContain('report-task.txt')
      expect(result.error).toMatch(/previous commit|--coverage-only/)
    })

    // The same hole through a different door, found by adversarial review after the
    // check above landed. `.scannerwork` is not cleaned between runs, so a scanner
    // that exits 0 without submitting an analysis leaves the PREVIOUS run's file in
    // place -- and that task id is already SUCCESS on the server, so waiting on it
    // confirms instantly and this commit is graded against the last one's numbers.
    it('refuses when the scanner left the task id unchanged', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: 'Scan completed',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })
      // Present before AND after, holding the same id: nothing new was submitted.
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=leftover-from-last-run')
      // And the server confirms it instantly, because it finished on the previous
      // run. That is what makes this dangerous rather than merely wrong: without the
      // refusal the scan reports SUCCESS in one poll and the gate grades this commit
      // against the last one's measures.
      answerCurl(
        curlSays(200, { task: { id: 'leftover-from-last-run', status: 'SUCCESS' } })
      )

      const result = runSonarqubeScan()

      expect(result.success).toBe(false)
      expect(result.error).toContain('leftover-from-last-run')
      expect(result.error).toMatch(/unchanged|no new analysis/)
      expect(result.error).toMatch(/previous commit|--coverage-only/)
    })

    // A response about a DIFFERENT task is not confirmation of this one. A proxy
    // serving a cached body, or a server that answers an unknown id with its most
    // recent task, both land here -- and both would otherwise report SUCCESS for an
    // analysis that was never submitted.
    it('refuses a task response that is about another task', async () => {
      const { spawnSync } = await import('child_process')
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: 'Scan completed',
        stderr: '',
        pid: 123,
        signal: null,
        output: [],
      })
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValueOnce('ceTaskId=previous-run')
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task-we-submitted')
      answerCurl(
        curlSays(200, { task: { id: 'somebody-elses-task', status: 'SUCCESS' } })
      )

      const result = runSonarqubeScan()

      expect(result.success).toBe(false)
      expect(result.error).toContain('task-we-submitted')
      expect(result.error).toContain('somebody-elses-task')
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
      // Two reads: `runSonarqubeScan` samples report-task.txt BEFORE the scanner
      // runs, so an unchanged id can be told from a new one. A leftover file from an
      // earlier run, overwritten by this scan.
      vi.mocked(fs.readFileSync).mockReturnValueOnce('ceTaskId=previous-run')
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task123\nserverUrl=http://localhost:9000')
      answerCurl(curlSays(200, {
        task: { id: 'task123', status: 'SUCCESS' },
      }))

      const result = runSonarqubeScan()

      expect(result.success).toBe(true)
    })

    it('returns failure when task fails', async () => {
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
      // Two reads: `runSonarqubeScan` samples report-task.txt BEFORE the scanner
      // runs, so an unchanged id can be told from a new one. A leftover file from an
      // earlier run, overwritten by this scan.
      vi.mocked(fs.readFileSync).mockReturnValueOnce('ceTaskId=previous-run')
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task123')
      answerCurl(curlSays(200, {
        task: { id: 'task123', status: 'FAILED', errorMessage: 'Analysis error' },
      }))

      const result = runSonarqubeScan()

      expect(result.success).toBe(false)
      expect(result.error).toContain('Analysis error')
    })

    it('returns failure when task is canceled', async () => {
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
      // Two reads: `runSonarqubeScan` samples report-task.txt BEFORE the scanner
      // runs, so an unchanged id can be told from a new one. A leftover file from an
      // earlier run, overwritten by this scan.
      vi.mocked(fs.readFileSync).mockReturnValueOnce('ceTaskId=previous-run')
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task123')
      answerCurl(curlSays(200, {
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
      // A confirmable analysis, so this tests the RETRY and not the task-id refusal
      // (#23) that the no-report-task.txt path now takes.
      vi.mocked(fs.existsSync).mockReturnValue(true)
      // Two reads: `runSonarqubeScan` samples report-task.txt BEFORE the scanner
      // runs, so an unchanged id can be told from a new one. A leftover file from an
      // earlier run, overwritten by this scan.
      vi.mocked(fs.readFileSync).mockReturnValueOnce('ceTaskId=previous-run')
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task123')
      answerCurl(curlSays(200, {
        task: { id: 'task123', status: 'SUCCESS' },
      }))

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
      // A confirmable analysis, so this tests the RETRY and not the task-id refusal
      // (#23) that the no-report-task.txt path now takes.
      vi.mocked(fs.existsSync).mockReturnValue(true)
      // Two reads: `runSonarqubeScan` samples report-task.txt BEFORE the scanner
      // runs, so an unchanged id can be told from a new one. A leftover file from an
      // earlier run, overwritten by this scan.
      vi.mocked(fs.readFileSync).mockReturnValueOnce('ceTaskId=previous-run')
      vi.mocked(fs.readFileSync).mockReturnValue('ceTaskId=task123')
      answerCurl(curlSays(200, {
        task: { id: 'task123', status: 'SUCCESS' },
      }))

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

      // Unreadable is the same answer as absent: the analysis cannot be confirmed.
      expect(result.success).toBe(false)
      expect(result.error).toContain('report-task.txt')
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

      // Unreadable is the same answer as absent: the analysis cannot be confirmed.
      expect(result.success).toBe(false)
      expect(result.error).toContain('report-task.txt')
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
// switches and clock skew -- so its tests are gone with it. What answers it now is
// the provenance sidecar (tests/coverage-provenance.test.ts), which records a commit
// and a code digest rather than comparing ages.
//
// That sidecar also adds a SECOND read of coverage-summary.json, before the scripts
// run, to hash it for the "did this run rewrite it" question. So the assertion below
// is about the LAST read -- the one the numbers come from -- and not the first.
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
    expect(sequence.lastIndexOf('read-coverage-report')).toBeGreaterThanOrEqual(0)
    expect(sequence.indexOf('run-test:coverage')).toBeLessThan(
      sequence.lastIndexOf('read-coverage-report')
    )
  })
})

/**
 * The custom-dimension failures only.
 *
 * These fixtures mock every file absent, which makes the coverage summary missing
 * too -- a real measurement failure about a different dimension (#43). Asserting
 * on the total count would couple a test about custom extractors to every other
 * dimension's health and read an unrelated failure as this one.
 */
const customFailuresOf = (result: Metrics) =>
  (result.measurementFailures ?? []).filter((f) => f.dimension.startsWith('custom'))

describe('sonarqube reaches the verdict', () => {
  // The whole point of #42, asserted where it actually matters. REPRODUCED before
  // this: a server answering 200 on `/` and 401 on `/api/measures/component` gave
  // `✓ Quality gate PASSED`, exit 0, three configured sonarqube ceilings never
  // evaluated, and nothing said about any of them; the next run served it from cache.
  it('fails the gate when the dimension is lost and a rule grades it', async () => {
    answerCurl(curlSays(401, { errors: [{ msg: 'no' }] }))

    const metrics = extractAllMetrics({ scriptsToRun: [] })

    const failure = (metrics.measurementFailures ?? []).find(
      (f) => f.dimension === 'sonarqube'
    )
    expect(failure?.kind).toBe('access-denied')

    const result = evaluateRules(
      { version: '1.0.0', rules: { ceilings: { 'sonarqube.blocker': 0 } } },
      metrics
    )

    expect(result.status).toBe('fail')
    expect(result.failedRules.map((f) => f.rule)).toContain('sonarqube.measurement')
  })

  // `--coverage-only` asked for the dimension to be skipped. A skipped dimension is
  // not a lost one, and reporting it would put noise in the loud channel on the path
  // most adopters use.
  it('reports no sonarqube failure when the dimension was skipped', async () => {
    answerCurl(curlSays(401, { errors: [{ msg: 'no' }] }))

    const metrics = extractAllMetrics({ scriptsToRun: [], skipSonarQube: true })

    expect(
      (metrics.measurementFailures ?? []).some((f) => f.dimension === 'sonarqube')
    ).toBe(false)
  })
})

describe('extractAllMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts all metrics with default options', async () => {
    const { spawnSync } = await import('child_process')

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

    // SonarQube returns metrics. A COMPLETE set of them -- a response carrying only
    // `bugs` is a partial reading now, and refused rather than zero-filled.
    answerCurl(curlSays(200, { component: { measures: allMeasures() } }))

    const result = extractAllMetrics()

    expect(result.coverage).toBeDefined()
    expect(result.typescript).toBeDefined()
    expect(result.eslint).toBeDefined()
    expect(result.sonarqube).toBeDefined()
    expect(result.scripts).toBeDefined()
    expect(result.sloc).toBe(0)
  })

  it('accepts array of scripts for backward compatibility', async () => {
    const { spawnSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    answerCurl(curlSays(200, { component: { measures: [] } }))

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
    // Narrowed from `not.toHaveBeenCalled()`, because the claim it was making is no
    // longer the claim it was written for. `extractAllMetrics` defaults to
    // `scriptsToRun: ['quality']`, so a coverage report can be rewritten during the
    // run, so the provenance snapshot asks git which state of the code it is looking
    // at -- one `git rev-parse HEAD`. What `--coverage-only` promises is that nothing
    // talks to SonarQube, and that is what is asserted.
    const commands = vi.mocked(execSync).mock.calls.map((call) => String(call[0]))
    expect(commands.filter((command) => command.includes('curl'))).toEqual([])
  })

  it('extracts custom metrics when dimensions provided', async () => {
    const { spawnSync } = await import('child_process')

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
    answerCurl(curlSays(200, { component: { measures: [] } }))

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
    // Scoped to the dimension under test rather than asserted on the total. This
    // fixture mocks every file absent, so the coverage summary is missing too and
    // the gate now says so (#43) -- a real failure about a different dimension,
    // which a count assertion would dress up as a broken custom extractor.
    expect(customFailuresOf(result)).toEqual([])
  })

  it('reports a broken custom extractor as a measurement failure, not as zero', async () => {
    // The dangerous case: `custom.*` is gated by ceilings alone and a
    // lower-better dimension is best at zero, so a broken extractor used to
    // report a perfect score for a dimension nobody measured.
    const { spawnSync } = await import('child_process')

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
    answerCurl(curlSays(200, { component: { measures: [] } }))

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
    const failures = customFailuresOf(result)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      kind: 'crashed',
      dimension: 'custom.complexity',
    })
  })

  it('skips custom metrics when skipCustomDimensions is true', async () => {
    const { spawnSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    answerCurl(curlSays(200, { component: { measures: [] } }))

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
    const { spawnSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    answerCurl(curlSays(200, { component: { measures: [] } }))

    const result = extractAllMetrics({
      customDimensions: [],
    })

    expect(result.custom).toBeUndefined()
  })

  /**
   * The one place the #47 refusal is observed ABOVE the provider boundary.
   *
   * The module-level stub says the shim is there, because that is the premise of every
   * other test in this file. Overriding it for this one case is what proves the refusal
   * reaches `measurementFailures` -- which is the only thing that turns a lost dimension
   * into a failed RULE and suppresses the cache write. Loud, not green, is the whole
   * point, and without this nothing outside providers/eslint.test.ts pins the loudness.
   */
  it('carries a refused eslint pre-flight into measurementFailures', async () => {
    const { spawnSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      // A complete, clean report -- exactly what the launcher's cached eslint serves for
      // a project that has none. It must not be read.
      stdout: JSON.stringify([
        { filePath: '/test/project/src/a.js', messages: [], errorCount: 0, warningCount: 0 },
      ]),
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    answerCurl(curlSays(200, { component: { measures: [] } }))

    vi.mocked(binaryInvocation).mockReturnValueOnce({
      kind: 'absent',
      command: { executable: 'npx', args: [], display: 'npx --no-install eslint' },
      searched: ['/test/project/node_modules/.bin/eslint'],
    })

    const result = extractAllMetrics({ skipSonarQube: true })

    expect(result.eslint).toBeUndefined()
    expect(result.measurementFailures).toBeDefined()
    expect(
      result.measurementFailures?.some((f) => f.dimension === 'eslint' && f.kind === 'tool-missing')
    ).toBe(true)

    // And a rule grading eslint fails on it, rather than the absent metric being skipped
    // -- `evaluateCeilings` takes a silent `continue` on a missing metric, so the failure
    // is the only thing that makes this loud.
    const verdict = evaluateRules(
      { version: '1.0.0', rules: { ceilings: { 'eslint.errors': 0 } } },
      result
    )
    expect(verdict.status).toBe('fail')
    expect(verdict.failedRules.map((f) => f.rule)).toContain('eslint.measurement')
  })
})

describe('extractAllMetricsAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads custom dimensions automatically', async () => {
    const { spawnSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    answerCurl(curlSays(200, { component: { measures: [] } }))

    // `submittedAnalysis` is REQUIRED on this signature, which is the point of it: a
    // verdict path that scanned has to hand over the analysis it submitted, and one that
    // did not has to say so out loud.
    const result = await extractAllMetricsAsync({ submittedAnalysis: { kind: 'not-scanned' } })

    expect(result.coverage).toBeDefined()
    expect(result.typescript).toBeDefined()
    expect(result.eslint).toBeDefined()
  })

  it('uses provided custom dimensions instead of loading', async () => {
    const { spawnSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    answerCurl(curlSays(200, { component: { measures: [] } }))

    const result = await extractAllMetricsAsync({
      customDimensions: [],
      submittedAnalysis: { kind: 'not-scanned' },
    })

    expect(result.custom).toBeUndefined()
  })

  it('skips custom dimension loading when skipCustomDimensions is true', async () => {
    const { spawnSync } = await import('child_process')

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '[]',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    })
    answerCurl(curlSays(200, { component: { measures: [] } }))

    const result = await extractAllMetricsAsync({
      skipCustomDimensions: true,
      submittedAnalysis: { kind: 'not-scanned' },
    })

    expect(result.custom).toBeUndefined()
  })
})

/**
 * #48 -- binding the confirmed analysis task to the metrics actually graded.
 *
 * `waitForSonarTask` reduced the CE task to a boolean, and
 * `/api/measures/component?component=<key>&metricKeys=...` has no analysis, task or
 * revision parameter: its only parameters are `component`, `metricKeys`, `branch` and
 * `pullRequest`, so it answers with the LIVE measures -- whatever the most recently
 * PROCESSED analysis of that key left in the table. A second publisher for the same key
 * between SUCCESS and the read replaces them, and nothing in the response says which
 * analysis it described. The gate confirmed analysis A and graded analysis B.
 */
describe('binding a sonarqube reading to the analysis that produced it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** The scanner exited 0 and wrote a task id that is not last run's. */
  const aScanThatSubmitted = (taskId: string): void => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Scan completed',
      stderr: '',
      pid: 123,
      signal: null,
      output: [],
    } as never)
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValueOnce('ceTaskId=previous-run')
    vi.mocked(fs.readFileSync).mockReturnValue(`ceTaskId=${taskId}`)
  }

  const measuresOk = (): SpawnResult =>
    curlSays(200, { component: { measures: allMeasures() } })

  describe('carrying the identity out of the task payload', () => {
    // D1: the identity exists in exactly one response and used to be thrown away.
    it('carries the analysis id out of a confirmed task', () => {
      aScanThatSubmitted('task-mine')
      answerCurl(
        curlSays(200, { task: { id: 'task-mine', status: 'SUCCESS', analysisId: 'AN-1' } })
      )

      const result = runSonarqubeScan()

      expect(result.success).toBe(true)
      expect(result.success && result.submitted).toEqual({
        kind: 'named',
        taskId: 'task-mine',
        analysisId: 'AN-1',
        branch: undefined,
        pullRequest: undefined,
      })
    })

    // D3's first half: an edition that omits the field must not break the scan.
    it('treats a SUCCESS with no analysisId as unnamed, not as a scan failure', () => {
      aScanThatSubmitted('task-mine')
      answerCurl(curlSays(200, { task: { id: 'task-mine', status: 'SUCCESS' } }))

      const result = runSonarqubeScan()

      expect(result.success).toBe(true)
      expect(result.success && result.submitted.kind).toBe('unnamed')
    })

    // Some protobuf-to-JSON renderings emit "" for an unset optional. Comparing "" to a
    // real analysis key would refuse a perfectly healthy run.
    it('does not treat an empty-string analysisId as an identity', () => {
      aScanThatSubmitted('task-mine')
      answerCurl(
        curlSays(200, { task: { id: 'task-mine', status: 'SUCCESS', analysisId: '' } })
      )

      const result = runSonarqubeScan()

      expect(result.success && result.submitted.kind).toBe('unnamed')
    })
  })

  describe('verifying it against the analysis SonarQube considers current', () => {
    // D2, happy path.
    it('confirms the reading when the current analysis is the one submitted', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, {
              paging: { pageIndex: 1, pageSize: 1, total: 7 },
              analyses: [{ key: 'AN-1', date: '2026-08-08T10:00:00+0000' }],
            })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure).toBeUndefined()
      expect(reading.metrics?.bugs).toBe(3)
      expect(reading.provenance).toEqual({ kind: 'confirmed', analysisId: 'AN-1' })
    })

    // The whole of #48: a definite contradiction from the server, corroborated.
    it('refuses the reading when SonarQube names a different current analysis', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, {
              analyses: [
                {
                  key: 'AN-OTHER',
                  date: '2026-08-08T10:00:00+0000',
                  revision: 'deadbeefcafe',
                },
              ],
            })
          : url.includes('/api/qualitygates/project_status')
            ? curlSays(200, { projectStatus: { status: 'OK' } })
            : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.metrics).toBeUndefined()
      expect(reading.failure?.kind).toBe('wrong-subject')
      expect(reading.failure?.dimension).toBe('sonarqube')
      expect(reading.failure?.message).toContain('AN-1')
      expect(reading.failure?.message).toContain('AN-OTHER')
      expect(reading.failure?.message).toContain('deadbeefcafe')
      expect(reading.failure?.message).toMatch(/Serialise|--coverage-only/)
    })

    // Diagnosable for the branch/PR CI shape rather than reading as a mystery race --
    // and the remedy clause has to be the one that can actually work there, which
    // "serialise the scans" is not.
    it('names the pull request when the confirmed analysis was of one', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-MAIN' }] })
          : url.includes('/api/qualitygates/project_status')
            ? curlSays(200, { projectStatus: { status: 'OK' } })
            : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-PR',
        pullRequest: '601',
      })

      expect(reading.failure?.kind).toBe('wrong-subject')
      expect(reading.failure?.message).toContain('pull request 601')
      expect(reading.failure?.message).toContain('default branch')
      expect(reading.failure?.message).not.toContain('Serialise the scans')
    })

    // THE false-fail closer. If ce/task's analysisId and project_analyses' key were ever
    // different identifier spaces, every run would mismatch -- and failing there is a
    // refusal the adopter cannot resolve, which is what killed two earlier designs.
    it('does not refuse when the server does not recognise the id it just gave us', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-OTHER' }] })
          : url.includes('/api/qualitygates/project_status')
            ? curlSays(404, { errors: [{ msg: "Analysis with id 'AN-1' is not found" }] })
            : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure).toBeUndefined()
      expect(reading.metrics?.bugs).toBe(3)
      expect(reading.provenance?.kind).toBe('unconfirmed')
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('not naming the same thing')
    })

    // `JSON.parse('null')` SUCCEEDS, so the parse guard above this does not catch a body
    // of `null` -- and `parsed.analyses?.[0]` guarded the array, not the object it hangs
    // off. A proxy normalising an empty response threw a TypeError out of a measurement
    // path whose contract is errors-as-values, taking the CLI and the MCP request down
    // instead of producing this advisory.
    it('treats a 200 carrying the literal null as an unanswerable question, not a crash', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, null)
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure).toBeUndefined()
      expect(reading.metrics?.bugs).toBe(3)
      expect(reading.provenance?.kind).toBe('unconfirmed')
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('named no current analysis')
    })

    // A corroborator that could not answer does not turn the mismatch into an advisory
    // -- both platforms that exist were measured to share the id space and to answer
    // this probe -- but the message must not claim the id WAS recognised.
    it('still refuses when the corroborating probe cannot answer, and says so', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-OTHER' }] })
          : url.includes('/api/qualitygates/project_status')
            ? curlSays(503, { errors: [{ msg: 'busy' }] })
            : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure?.kind).toBe('wrong-subject')
      expect(reading.failure?.message).toContain('HTTP 503')
      expect(reading.failure?.message).toContain('uncorroborated')
    })
  })

  describe('when the verification call itself fails', () => {
    // D4: it is not acceptable to grade numbers whose provenance the server refused to
    // discuss -- and the remedy has to be nameable, because this DOES break a token that
    // holds "Execute Analysis" and not "Browse".
    it('is a failed measurement naming Browse when the call is refused', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(401, { errors: [{ msg: 'Insufficient privileges' }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.metrics).toBeUndefined()
      expect(reading.failure?.kind).toBe('access-denied')
      expect(reading.failure?.message).toContain('Browse')
      expect(reading.failure?.message).toContain('Execute Analysis')
    })

    it('is a failed measurement when the endpoint is unreachable', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? spawnSyncShape('\n000', 7)
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure?.kind).toBe('tool-missing')
      expect(reading.failure?.message).toContain('did not answer when asked which analysis')
    })

    // Symmetry with the measures read's redirect refusal: a 3xx body is not an answer
    // about provenance even when it happens to be JSON of the right shape.
    it('is a failed measurement when the endpoint answers a redirect', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(302, { analyses: [{ key: 'AN-1' }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure?.kind).toBe('crashed')
      expect(reading.failure?.message).toContain('redirect')
    })

    // The evidence has to reproduce the call that FAILED. A command built from the
    // measures query would print a reproduction of a call that succeeded.
    it('reproduces the call that actually failed, not the measures call', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(401, { errors: [{ msg: 'no' }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure?.evidence.command).toContain('/api/project_analyses/search')
      expect(reading.failure?.evidence.command).not.toContain('metricKeys')
    })

    // D4's second half: an endpoint that does not exist in this edition is a "cannot
    // tell", not a refusal.
    it('is an advisory when the endpoint does not exist', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(404, {
              errors: [{ msg: 'Unknown url : /api/project_analyses/search' }],
            })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure).toBeUndefined()
      expect(reading.metrics?.bugs).toBe(3)
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('does not exist on this server')
    })

    // The 404 ambiguity is resolved in the MESSAGE and never in the verdict, so the
    // brittle match on the server's English literal cannot change a gate result.
    it('says the component instead when the 404 is about the key, still advisory', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(404, { errors: [{ msg: "Component key 'test-project' not found" }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure).toBeUndefined()
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('module, directory or file')
    })

    // An empty list, or a shape with no key, must not be compared against `undefined`
    // and read as a mismatch.
    it('is an advisory when the analysis list names nothing', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { paging: { pageIndex: 1, pageSize: 1, total: 0 }, analyses: [] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure).toBeUndefined()
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('named no current analysis')
    })

    // A key that is not a string -- a proxy rewriting the body, a shape change -- is the
    // same "cannot tell" and must not be compared as if it were an identifier.
    it('is an advisory when the analysis key is not a string', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 12345 }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure).toBeUndefined()
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('named no current analysis')
    })

    // The host has already proved it speaks JSON by answering the measures call, so an
    // unparseable body from this ONE endpoint is a "cannot tell" rather than a second
    // refusal.
    it('is an advisory when the analysis list is not JSON', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, '<html>login</html>')
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure).toBeUndefined()
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('not JSON')
    })
  })

  describe('the credential never reaches a provenance message', () => {
    // The hard constraint, on the one new path where a SERVER-supplied string reaches a
    // message. Both channels are tested: the failure and the advisory. The advisory
    // travels as far as the failure does -- into an UnevaluatedRule.message, which the
    // CLI prints and the MCP server serialises.
    const withToken = async (): Promise<void> => {
      const { sonarAuthArgs } = await import('../src/config.js')
      vi.mocked(sonarAuthArgs).mockReturnValue(['-u', 'squ_secrettoken:'])
    }

    it('scrubs it out of a wrong-subject failure', async () => {
      await withToken()
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'squ_secrettoken' }] })
          : url.includes('/api/qualitygates/project_status')
            ? curlSays(200, { projectStatus: { status: 'OK' } })
            : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      expect(reading.failure?.message).not.toContain('squ_secrettoken')
      expect(reading.failure?.message).toContain('<redacted>')
    })

    it('scrubs it out of an advisory too', async () => {
      await withToken()
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'squ_secrettoken' }] })
          : url.includes('/api/qualitygates/project_status')
            ? curlSays(404, { errors: [{ msg: 'not found' }] })
            : measuresOk()
      )

      const reading = readSonarqubeMetrics({
        kind: 'named',
        taskId: 't1',
        analysisId: 'AN-1',
      })

      const why = reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      expect(why).not.toContain('squ_secrettoken')
      expect(why).toContain('<redacted>')
    })
  })

  describe('when the server never named the analysis', () => {
    // D3's second half: the advisory. The false-pass a hurried implementer writes here is
    // `provenance: {kind:'confirmed', analysisId: taskId}` -- a task id is not an
    // analysis id, and nothing was checked.
    it('is an advisory naming the missing field', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-CURRENT' }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({ kind: 'unnamed', taskId: 't1' })

      expect(reading.failure).toBeUndefined()
      expect(reading.metrics?.bugs).toBe(3)
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('analysisId')
    })

    // What that population gets INSTEAD of an id comparison. Without it the branch the
    // design justifies at greatest length verifies nothing at all -- the same
    // structurally-inert shape as the mtime rule that was built and removed.
    it('refuses when the current analysis is of another commit', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(
        'a'.repeat(40) + '\n' as never
      )
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-CURRENT', revision: 'b'.repeat(40) }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({ kind: 'unnamed', taskId: 't1' })

      expect(reading.failure?.kind).toBe('wrong-subject')
      expect(reading.failure?.message).toContain('b'.repeat(40))
      expect(reading.failure?.message).toContain('a'.repeat(40))
    })

    // A revision match is NOT confirmation: it cannot distinguish two concurrent scans of
    // the same commit, which is what the id comparison is for.
    it('stays an advisory when the revision matches', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(('c'.repeat(40) + '\n') as never)
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-CURRENT', revision: 'c'.repeat(40) }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({ kind: 'unnamed', taskId: 't1' })

      expect(reading.failure).toBeUndefined()
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('IS the commit being graded')
    })

    // SCM detection off (`sonar.scm.disabled`) leaves no revision, and a value that is
    // not a git sha is not compared as if it were one.
    it('stays an advisory when there is no revision to compare', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-CURRENT' }] })
          : measuresOk()
      )

      const reading = readSonarqubeMetrics({ kind: 'unnamed', taskId: 't1' })

      expect(reading.failure).toBeUndefined()
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('names no revision')
    })
  })

  describe('what a caller that scanned nothing pays for this', () => {
    // `score`, `suggest` and the MCP handlers pay NOTHING -- and, load-bearingly, no
    // existing test's single-response mock is consumed twice.
    it('makes no second call when nothing was scanned', () => {
      answerCurl(measuresOk())

      const reading = readSonarqubeMetrics()

      expect(reading.provenance?.kind).toBe('unconfirmed')
      expect(
        reading.provenance?.kind === 'unconfirmed' ? reading.provenance.why : ''
      ).toContain('no analysis was submitted by this process')
      expect(
        vi.mocked(spawnSync).mock.calls.filter(([cmd]) => cmd === 'curl')
      ).toHaveLength(1)
    })
  })

  describe('the plumbing from the scan to the verdict', () => {
    it('carries the provenance onto the metrics the gate evaluates', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-1' }] })
          : measuresOk()
      )

      const metrics = extractAllMetrics({
        scriptsToRun: [],
        submittedAnalysis: { kind: 'named', taskId: 't', analysisId: 'AN-1' },
      })

      expect(metrics.sonarqubeProvenance).toEqual({ kind: 'confirmed', analysisId: 'AN-1' })
    })

    // The skip path is untouched: no provenance, no HTTP call, so a coverage-only run
    // gets the pre-existing `skipped-dimension` advisory and not a provenance one.
    it('claims no provenance and reads nothing under --coverage-only', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const metrics = extractAllMetrics({ scriptsToRun: [], skipSonarQube: true })

      expect(metrics.sonarqubeProvenance).toBeUndefined()
      expect(vi.mocked(spawnSync).mock.calls.filter(([cmd]) => cmd === 'curl')).toHaveLength(0)
    })

    // End to end through the library: a `wrong-subject` failure on the sonarqube
    // dimension becomes a failed RULE via rule-scoped gating.
    it('turns a mismatch into a failed rule for a project that grades sonarqube', () => {
      answerCurlByUrl((url) =>
        url.includes('/api/project_analyses/search')
          ? curlSays(200, { analyses: [{ key: 'AN-OTHER' }] })
          : url.includes('/api/qualitygates/project_status')
            ? curlSays(200, { projectStatus: { status: 'OK' } })
            : measuresOk()
      )

      const metrics = extractAllMetrics({
        scriptsToRun: [],
        submittedAnalysis: { kind: 'named', taskId: 't', analysisId: 'AN-1' },
      })

      const verdict = evaluateRules(
        { version: '1.0.0', rules: { ceilings: { 'sonarqube.blocker': 0 } } },
        metrics
      )

      expect(verdict.status).toBe('fail')
      expect(verdict.failedRules.map((f) => f.rule)).toContain('sonarqube.measurement')
    })
  })
})
