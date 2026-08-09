import { describe, it, expect, afterEach } from 'vitest'
import {
  loadRules,
  computeRulesHash,
  evaluateRules,
  isCacheValid,
  isMeasurementUnderRule,
  isUsingEmbeddedDefaults,
  rulesReadingMeasurement,
} from '../src/rules.js'
import { resetConfig } from '../src/config.js'
import { measurementInputsHash } from '../src/measurement-inputs.js'
import { isEmbeddedDefaults } from '../src/defaults.js'
import type {
  QualityRules,
  Metrics,
  CacheEntry,
  CoverageProvenanceStamp,
} from '../src/types.js'
import type { MeasurementFailure } from '../src/providers/types.js'

describe('loadRules', () => {
  afterEach(() => {
    resetConfig()
  })

  it('loads rules from rules.json', () => {
    const rules = loadRules()

    expect(rules.version).toBeDefined()
    expect(rules.rules).toBeDefined()
    expect(rules.rules.floors).toBeDefined()
  })

  describe('zero-config mode', () => {
    it('returns embedded defaults when rules file does not exist', () => {
      process.env.QUALITY_RULES_FILE = '/nonexistent/rules.json'
      resetConfig()

      const rules = loadRules({ silent: true })

      expect(rules.version).toBe('0.0.0-embedded')
      expect(isEmbeddedDefaults(rules)).toBe(true)
      expect(isUsingEmbeddedDefaults()).toBe(true)
    })

    it('returns coverage-only defaults when coverageOnly is true', () => {
      process.env.QUALITY_RULES_FILE = '/nonexistent/rules.json'
      resetConfig()

      const rules = loadRules({ coverageOnly: true, silent: true })

      expect(rules.description).toContain('coverage-only')
      expect(rules.rules.ceilings?.['sonarqube.blocker']).toBeUndefined()
    })

    it('returns full defaults when coverageOnly is false', () => {
      process.env.QUALITY_RULES_FILE = '/nonexistent/rules.json'
      resetConfig()

      const rules = loadRules({ coverageOnly: false, silent: true })

      expect(rules.description).toContain('full')
      expect(rules.rules.ceilings?.['sonarqube.blocker']).toBe(0)
    })

    it('marks isUsingEmbeddedDefaults as false when loading from file', () => {
      // Reset to default config (which should find the actual rules.json)
      delete process.env.QUALITY_RULES_FILE
      resetConfig()

      const rules = loadRules()

      expect(isUsingEmbeddedDefaults()).toBe(false)
      expect(rules.version).not.toBe('0.0.0-embedded')
    })
  })
})

describe('computeRulesHash', () => {
  it('returns consistent hash for same rules', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: {
        floors: { 'coverage.branches': 80 },
      },
    }

    const hash1 = computeRulesHash(rules)
    const hash2 = computeRulesHash(rules)

    expect(hash1).toBe(hash2)
  })

  it('returns different hash for different rules', () => {
    const rules1: QualityRules = {
      version: '1.0.0',
      rules: {
        floors: { 'coverage.branches': 80 },
      },
    }

    const rules2: QualityRules = {
      version: '1.0.0',
      rules: {
        floors: { 'coverage.branches': 90 },
      },
    }

    const hash1 = computeRulesHash(rules1)
    const hash2 = computeRulesHash(rules2)

    expect(hash1).not.toBe(hash2)
  })

  it('returns a 16-character hash', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: {},
    }

    const hash = computeRulesHash(rules)

    expect(hash).toHaveLength(16)
  })
})

describe('evaluateRules', () => {
  describe('floor evaluation', () => {
    it('passes when metric is above floor', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          floors: { 'coverage.unit.branches': 80 },
        },
      }

      const metrics: Metrics = {
        coverage: {
          unit: { branches: 85, statements: 90, functions: 80, lines: 85 },
        },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('pass')
      expect(result.failedRules).toHaveLength(0)
    })

    it('fails when metric is below floor', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          floors: { 'coverage.unit.branches': 80 },
        },
      }

      const metrics: Metrics = {
        coverage: {
          unit: { branches: 70, statements: 90, functions: 80, lines: 85 },
        },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('fail')
      expect(result.failedRules).toHaveLength(1)
      expect(result.failedRules[0].type).toBe('floor')
      expect(result.failedRules[0].rule).toBe('coverage.unit.branches')
    })

    it('fails when metric is missing', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          floors: { 'coverage.unit.branches': 80 },
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].message).toContain('not available')
    })

    it('fails when metric path traverses through non-object', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          floors: { 'sloc.something.deep': 100 },
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000, // sloc is a number, not an object
      }

      const result = evaluateRules(rules, metrics)

      // Should fail because sloc.something tries to access property on number
      expect(result.status).toBe('fail')
      expect(result.failedRules[0].message).toContain('not available')
    })

    it('fails when metric value is not a number', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          floors: { 'scripts.test': 1 },
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: { test: 'pass' }, // test is a string, not a number
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      // Should fail because scripts.test is 'pass' (string), not a number
      expect(result.status).toBe('fail')
      expect(result.failedRules[0].message).toContain('not available')
    })
  })

  describe('ceiling evaluation', () => {
    // `extractAllCustomMetrics` stores custom readings FLAT --
    // `metrics.custom['bundle.size']`, from `config.path.replace('custom.','')` --
    // and `validateCustomDimensions` puts no constraint on segment count. The
    // private path-walking accessor that used to live in rules.ts resolved
    // `custom.bundle.size` to undefined and `evaluateCeilings` skipped it in
    // silence, so a measured 5,000,000 passed a ceiling of 500,000 and the pass
    // was cached because the reading was complete. Reproduced through the CLI
    // before the fix; these two pin the flat lookup in both directions.
    it('enforces a ceiling on a dotted custom dimension path', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          ceilings: { 'custom.bundle.size': 500_000 },
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
        custom: { 'bundle.size': 5_000_000 },
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('fail')
      expect(result.failedRules.map((f) => f.rule)).toContain('custom.bundle.size')
    })

    it('passes a dotted custom dimension that is under its ceiling', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          ceilings: { 'custom.bundle.size': 500_000 },
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
        custom: { 'bundle.size': 400_000 },
      }

      expect(evaluateRules(rules, metrics).status).toBe('pass')
    })

    it('passes when metric is below ceiling', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          ceilings: { 'typescript.errors': 0 },
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('pass')
    })

    it('fails when metric exceeds ceiling', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          ceilings: { 'typescript.errors': 0 },
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 5, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].type).toBe('ceiling')
    })

    // A ceiling whose metric was never ASKED for stays skipped. That is the
    // legitimate half: nobody configured SonarQube, so there is nothing to
    // check and nothing failed. The other half -- a metric that is absent
    // because measuring it BROKE -- is the vacuous pass, and is covered by the
    // measurement suite below. Only `measurementFailures` distinguishes them.
    it('ignores a ceiling whose metric was never measured in the first place', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          ceilings: { 'sonarqube.bugs': 0 },
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('pass')
      expect(metrics.measurementFailures).toBeUndefined()
    })
  })

  // =========================================================================
  // Measurement failures
  // =========================================================================
  //
  // The counterweight to the ceiling asymmetry above. Ceilings guard
  // typescript.errors, eslint.errors, sonarqube.* and every custom.* dimension
  // -- none of which have floors -- so before this, a tool that crashed made
  // its own ceiling disappear.
  //
  // Every case here now carries a RULE on the dimension it breaks, because that
  // is the condition for a failed measurement to become a failed rule. The
  // ungated direction is covered by its own block below ('measurement failures
  // nothing grades'), which is the part that had to be added: an unconditional
  // failure hard-failed projects over `coverage.lambda`, a suite the provider
  // always attempts and almost no project has.
  describe('measurement failures', () => {
    const failure = (dimension: 'eslint' | 'typescript', kind: string) => ({
      kind: kind as MeasurementFailure['kind'],
      dimension,
      message: `\`${dimension}\` did not run`,
      evidence: {
        command: dimension,
        exitCode: null,
        signal: 'SIGKILL',
        elapsedMs: 1234,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    })

    it('fails the gate when a measurement could not be taken', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: { ceilings: { 'eslint.errors': 0 } },
      }
      const metrics: Metrics = {
        scripts: {},
        measurementFailures: [failure('eslint', 'crashed')],
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].type).toBe('measurement')
      expect(result.failedRules[0].rule).toBe('eslint.measurement')
    })

    // The whole point. The metric is absent, its ceiling is skipped exactly as
    // before, and the run still fails -- on the failure rather than the rule.
    it('fails even though the skipped ceiling would have passed on its own', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: { ceilings: { 'eslint.errors': 0 } },
      }
      const metrics: Metrics = {
        scripts: {},
        measurementFailures: [failure('eslint', 'output-truncated')],
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('fail')
      expect(result.failedRules.some((f) => f.type === 'ceiling')).toBe(false)
      expect(result.failedRules.some((f) => f.type === 'measurement')).toBe(true)
    })

    // A monotonic rule is enough on its own. It is the surface a project most
    // easily forgets it has: both embedded defaults ratchet typescript.errors
    // down without giving it a floor.
    it('fails when a monotonic rule is the only thing naming the dimension', () => {
      const result = evaluateRules(
        {
          version: '1.0.0',
          rules: { monotonic: [{ direction: 'down', metrics: ['typescript.errors'] }] },
        },
        {
          scripts: {},
          measurementFailures: [failure('typescript', 'timed-out')],
        }
      )

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].rule).toBe('typescript.measurement')
    })

    it('reports every failure, not just the first', () => {
      const result = evaluateRules(
        {
          version: '1.0.0',
          rules: { ceilings: { 'eslint.errors': 0, 'typescript.errors': 0 } },
        },
        {
          scripts: {},
          measurementFailures: [failure('eslint', 'crashed'), failure('typescript', 'tool-missing')],
        }
      )

      expect(result.failedRules.filter((f) => f.type === 'measurement')).toHaveLength(2)
    })

    it('carries the evidence into the message so the cause is diagnosable', () => {
      const result = evaluateRules({
        version: '1.0.0',
        rules: { ceilings: { 'typescript.errors': 0 } },
      }, {
        scripts: {},
        measurementFailures: [failure('typescript', 'timed-out')],
      })

      expect(result.failedRules[0].message).toContain('timed-out')
      expect(result.failedRules[0].message).toContain('SIGKILL')
      expect(result.failedRules[0].message).toContain('1234ms')
    })

    it('passes when the list is present but empty', () => {
      const result = evaluateRules({ version: '1.0.0', rules: {} }, {
        scripts: {},
        measurementFailures: [],
      })

      expect(result.status).toBe('pass')
    })

    // A provider that reads an artifact has no exit status, so its evidence is a
    // different shape. The cases above are now ALSO the regression test for the
    // process variant staying the fallback: their evidence literals carry no
    // `via` tag, and an exhaustive `switch (e.via)` would render them as nothing
    // -- dropping exactly the SIGKILL and 1234ms those cases assert on.
    it('renders report evidence for a measurement that read a file', () => {
      const result = evaluateRules({
        version: '1.0.0',
        rules: { floors: { 'coverage.unit.branches': 50 } },
      }, {
        scripts: {},
        measurementFailures: [
          {
            kind: 'measured-nothing' as MeasurementFailure['kind'],
            dimension: 'coverage.unit',
            message: 'the report measured nothing',
            evidence: {
              via: 'report',
              command: 'read /p/coverage/coverage-summary.json',
              elapsedMs: 7,
              attempts: [
                {
                  path: '/p/coverage/coverage-summary.json',
                  existed: true,
                  bytesRead: 1757,
                  modifiedMs: 1_700_000_000_000,
                  outcome: 'read',
                },
              ],
            },
          },
        ],
      })

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].rule).toBe('coverage.unit.measurement')

      const message = result.failedRules[0].message
      expect(message).toContain('measured-nothing')
      expect(message).toContain('/p/coverage/coverage-summary.json')
      expect(message).toContain('1757B')
      expect(message).toContain('mtime=2023-11-14T22:13:20.000Z')
      expect(message).toContain('after 7ms')
      // No fabricated process fields.
      expect(message).not.toContain('exit=')
      expect(message).not.toContain('stdout')
    })

    // The bare `coverage` dimension, gated by a rule one level DOWN from it --
    // the reverse of the prefix direction the cases above exercise.
    it('omits byte count and mtime for a report it never read', () => {
      const result = evaluateRules({
        version: '1.0.0',
        rules: { floors: { 'coverage.unit.branches': 50 } },
      }, {
        scripts: {},
        measurementFailures: [
          {
            kind: 'report-missing' as MeasurementFailure['kind'],
            dimension: 'coverage',
            message: 'no report',
            evidence: {
              via: 'report',
              command: 'read /p/coverage/coverage-summary.json',
              elapsedMs: 1,
              attempts: [
                {
                  path: '/p/coverage/coverage-summary.json',
                  existed: false,
                  bytesRead: null,
                  modifiedMs: null,
                  outcome: 'absent',
                },
              ],
            },
          },
        ],
      })

      const message = result.failedRules[0].message
      expect(message).toContain('absent')
      expect(message).not.toContain('B,')
      expect(message).not.toContain('mtime=')
    })
  })

  // =========================================================================
  // Measurement failures nothing grades
  // =========================================================================
  //
  // The three defects that made unconditional evaluation wrong, each reduced to
  // the rules and the failure that produce it:
  //
  //   (i)   a two-suite project whose scripts rewrite only the unit report
  //         hard-failed on `coverage.lambda`. `lambdaDir` defaults to
  //         `coverage-lambda` and is populated unconditionally, so BOTH suites
  //         always reach the reader.
  //   (ii)  a project gating only typescript.errors and eslint.errors, with a
  //         stray gitignored coverage/ directory, failed on coverage it never
  //         asked to have measured.
  //   (iii) a declarations-only package writes a legitimately blank summary and
  //         was refused with no opt-out.
  describe('measurement failures nothing grades', () => {
    const coverageFailure = (dimension: string) => ({
      kind: 'measured-nothing' as MeasurementFailure['kind'],
      dimension: dimension as MeasurementFailure['dimension'],
      message: `${dimension} measured nothing`,
      evidence: {
        via: 'report' as const,
        command: `read ${dimension}`,
        elapsedMs: 3,
        attempts: [
          {
            path: `/p/${dimension}/coverage-summary.json`,
            existed: true,
            bytesRead: 120,
            modifiedMs: 1_700_000_000_000,
            outcome: 'read' as const,
          },
        ],
      },
    })

    // (i). The unit floors are configured and satisfied; the lambda suite is
    // measured because the provider always attempts it, not because anyone asked.
    it('passes a project whose lambda suite nothing gates', () => {
      const result = evaluateRules(
        {
          version: '1.0.0',
          rules: { floors: { 'coverage.unit.branches': 50, 'coverage.unit.statements': 50 } },
        },
        {
          coverage: { unit: { branches: 80, statements: 80, functions: 80, lines: 80 } },
          scripts: {},
          measurementFailures: [coverageFailure('coverage.lambda')],
        }
      )

      expect(result.status).toBe('pass')
      expect(result.failedRules).toEqual([])
    })

    // (ii) and (iii). No coverage rule anywhere, so a coverage report that
    // measured nothing is a fact about a dimension this project does not grade.
    it('passes an eslint-only project with an unreadable coverage report', () => {
      const result = evaluateRules(
        {
          version: '1.0.0',
          rules: { ceilings: { 'typescript.errors': 0, 'eslint.errors': 0 } },
        },
        {
          typescript: { errors: 0, warnings: 0 },
          eslint: { errors: 0, warnings: 0 },
          scripts: {},
          measurementFailures: [coverageFailure('coverage.unit')],
        }
      )

      expect(result.status).toBe('pass')
    })

    // And the same failure DOES gate the moment a rule reads the dimension. This
    // is the pair that makes the case above evidence of scoping rather than of a
    // check that stopped working.
    it('fails the same project once a coverage floor is configured', () => {
      const result = evaluateRules(
        {
          version: '1.0.0',
          rules: {
            ceilings: { 'eslint.errors': 0 },
            floors: { 'coverage.unit.branches': 50 },
          },
        },
        {
          eslint: { errors: 0, warnings: 0 },
          scripts: {},
          measurementFailures: [coverageFailure('coverage.unit')],
        }
      )

      expect(result.status).toBe('fail')
      expect(result.failedRules.some((f) => f.rule === 'coverage.unit.measurement')).toBe(true)
    })

    // A rule on the OTHER suite is not a rule on this one.
    it('does not let a unit floor gate a lambda failure', () => {
      const result = evaluateRules(
        { version: '1.0.0', rules: { floors: { 'coverage.unit.branches': 0 } } },
        {
          coverage: { unit: { branches: 1, statements: 1, functions: 1, lines: 1 } },
          scripts: {},
          measurementFailures: [coverageFailure('coverage.lambda')],
        }
      )

      expect(result.status).toBe('pass')
    })

    // Matched on segment boundaries, so a rule cannot gate a dimension it merely
    // shares a prefix of its name with.
    it('does not match a dimension that is only a string prefix of a rule', () => {
      const result = evaluateRules(
        { version: '1.0.0', rules: { ceilings: { 'customs.dutyCount': 0 } } },
        {
          scripts: {},
          measurementFailures: [
            {
              ...coverageFailure('coverage.unit'),
              dimension: 'custom' as MeasurementFailure['dimension'],
            },
          ],
        }
      )

      expect(result.status).toBe('pass')
    })

    // The reported-but-not-gating half of the contract. Detection is
    // unconditional -- describeUnmeasured and the fix advice both read this list
    // -- and only the VERDICT is scoped.
    it('leaves the failure in metrics for the surfaces that report it', () => {
      const metrics: Metrics = {
        scripts: {},
        measurementFailures: [coverageFailure('coverage.lambda')],
      }

      expect(evaluateRules({ version: '1.0.0', rules: {} }, metrics).status).toBe('pass')
      expect(metrics.measurementFailures).toHaveLength(1)
    })
  })

  // =========================================================================
  // Derived dimensions
  // =========================================================================
  //
  // `coverage.union.*` is COMPUTED from the unit and lambda summaries by
  // mergeCoverageReports, and the two prefixes are one character apart, so name
  // matching alone treated them as unrelated. REPRODUCED: a project with a
  // `coverage.union.statements` floor had every unit/lambda measurement failure
  // demoted to an advisory while the union number DERIVED from the failed
  // measurement was graded -- a backdated unit report graded at 95 against a
  // floor of 80, exit 0, and a truncated lambda summary dropped from the merge
  // with the union summed from the unit suite alone, exit 0.
  //
  // Both directions are asserted for every edge, because either alone is
  // satisfiable by the wrong implementation: a matcher that gated everything
  // would pass the upstream half, and one that gated nothing would pass the
  // unrelated half.
  describe('measurement failures on a dimension something is derived from', () => {
    const coverageFailure = (dimension: string) => ({
      kind: 'unparseable-output' as MeasurementFailure['kind'],
      dimension: dimension as MeasurementFailure['dimension'],
      message: `${dimension} could not be read`,
      evidence: {
        via: 'report' as const,
        command: `read ${dimension}`,
        elapsedMs: 3,
        attempts: [
          {
            path: `/p/${dimension}/coverage-summary.json`,
            existed: true,
            bytesRead: 120,
            modifiedMs: 1_700_000_000_000,
            outcome: 'read' as const,
          },
        ],
      },
    })

    // The union floor is satisfied by the number the merge produced. That number
    // is the one under suspicion: it was summed from a report that failed to
    // read, so grading it is grading arithmetic over a measurement that is not
    // there.
    const unionFloorOnly = {
      version: '1.0.0',
      rules: { floors: { 'coverage.union.statements': 80 } },
    }
    const unionCoverage = {
      coverage: { union: { branches: 95, statements: 95, functions: 95, lines: 95 } },
      scripts: {},
    }

    it('gates a unit failure through a union floor', () => {
      const result = evaluateRules(unionFloorOnly, {
        ...unionCoverage,
        measurementFailures: [coverageFailure('coverage.unit')],
      })

      expect(result.status).toBe('fail')
      expect(result.failedRules.some((f) => f.rule === 'coverage.unit.measurement')).toBe(true)
    })

    // Pinned as a DECIDED trade rather than left as an accident, because two
    // independent reviewers raised it as a false positive and it is arguable.
    //
    // A summary with real per-file entries and no `total` yields an honest union
    // number -- `mergeCoverageReports` sums the entries and never reads `total` -- so
    // the provider reports the number AND a `coverage.unit` failure. Here the union
    // floor is satisfied by that number, and the gate still goes red through the
    // derivation edge.
    //
    // That is deliberate. The edge is right in general: the union is normally
    // computed from the suites' totals, so a suite that could not be read makes the
    // union suspect. Suppressing it would need a per-failure list of which derived
    // dimensions a failure does NOT invalidate, for a shape istanbul never emits --
    // and the direction of the error matters: fail-closed on a malformed report costs
    // a red gate with a message naming the file, while fail-open costs a
    // `coverage.unit.*` rule that silently never runs. The provider's message says
    // this explicitly rather than claiming the union is unaffected.
    it('fails a satisfied union floor when the suite it derives from could not be read', () => {
      const result = evaluateRules(
        { version: '1.0.0', rules: { floors: { 'coverage.union.statements': 40 } } },
        {
          // The union was measured and clears the floor by a wide margin.
          coverage: { union: { branches: 50, statements: 50, functions: 50, lines: 50 } },
          scripts: {},
          measurementFailures: [coverageFailure('coverage.unit')],
        }
      )

      expect(result.status).toBe('fail')
      expect(result.failedRules).toHaveLength(1)
      expect(result.failedRules[0].rule).toBe('coverage.unit.measurement')
      // Specifically NOT a floor failure: the number passed.
      expect(result.failedRules.some((f) => f.type === 'floor')).toBe(false)
    })

    it('gates a lambda failure through a union floor', () => {
      const result = evaluateRules(unionFloorOnly, {
        ...unionCoverage,
        measurementFailures: [coverageFailure('coverage.lambda')],
      })

      expect(result.status).toBe('fail')
      expect(result.failedRules.some((f) => f.rule === 'coverage.lambda.measurement')).toBe(true)
    })

    // A monotonic rule on the union is the same edge through a different surface,
    // and it is the surface a project is likeliest to have without noticing.
    it('gates through a union monotonic rule as well as a floor', () => {
      const result = evaluateRules(
        {
          version: '1.0.0',
          rules: { monotonic: [{ direction: 'up', metrics: ['coverage.union.branches'] }] },
        },
        { ...unionCoverage, measurementFailures: [coverageFailure('coverage.unit')] }
      )

      expect(result.status).toBe('fail')
      expect(result.failedRules.some((f) => f.rule === 'coverage.unit.measurement')).toBe(true)
    })

    // The OTHER direction of the same edge. Derivation is one-way: `unit` and
    // `lambda` come from each report's own `total`, which is validated
    // independently, so a union that could not be summed says nothing about them.
    // This is a real failure the provider emits (an unmergeable file entry is
    // reported on `coverage.union`), not a hypothetical.
    it('does not gate a union failure through a unit floor', () => {
      const result = evaluateRules(
        { version: '1.0.0', rules: { floors: { 'coverage.unit.statements': 80 } } },
        {
          coverage: { unit: { branches: 95, statements: 95, functions: 95, lines: 95 } },
          scripts: {},
          measurementFailures: [coverageFailure('coverage.union')],
        }
      )

      expect(result.status).toBe('pass')
    })

    // And the edge does not leak sideways: a union rule must not gate a dimension
    // the union is not computed from.
    it('does not gate an unrelated dimension through a union floor', () => {
      const result = evaluateRules(unionFloorOnly, {
        ...unionCoverage,
        measurementFailures: [
          {
            ...coverageFailure('coverage.unit'),
            dimension: 'eslint' as MeasurementFailure['dimension'],
          },
        ],
      })

      expect(result.status).toBe('pass')
    })

    // `typescript.rootCauses` is derived from the same tsc run as
    // `typescript.errors`, which is why it needs no edge in DERIVED_FROM: the
    // failure's dimension is the provider, and subtree matching already reaches
    // any rule under it. Pinned so a future narrowing of the matcher cannot
    // silently drop it.
    it('gates a typescript failure through a rootCauses ceiling', () => {
      const result = evaluateRules(
        { version: '1.0.0', rules: { ceilings: { 'typescript.rootCauses': 0 } } },
        {
          scripts: {},
          measurementFailures: [
            {
              ...coverageFailure('coverage.unit'),
              dimension: 'typescript' as MeasurementFailure['dimension'],
            },
          ],
        }
      )

      expect(result.status).toBe('fail')
      expect(result.failedRules.some((f) => f.rule === 'typescript.measurement')).toBe(true)
    })

    // Segment boundaries still hold for the derived path, so a project that
    // invents `coverage.unionised.*` does not inherit the union's upstreams.
    //
    // Asserted on the failed RULES rather than on the verdict: a floor on a
    // dimension no reading carries fails on its own (`Metric '...' not
    // available`), so a `pass` here would be unreachable and this test would be
    // asserting the wrong thing.
    it('does not treat a longer name sharing the union prefix as derived', () => {
      const result = evaluateRules(
        { version: '1.0.0', rules: { floors: { 'coverage.unionised.statements': 80 } } },
        {
          scripts: {},
          measurementFailures: [coverageFailure('coverage.lambda')],
        }
      )

      expect(result.failedRules.map((f) => f.type)).toEqual(['floor'])
    })
  })

  describe('monotonic evaluation', () => {
    // What a baseline entry from a real passing run carries: one provenance verdict per
    // coverage suite. `evaluateMonotonic` refuses to difference against a suite whose
    // report it cannot tie to the code (reason `baseline-unbound`), and a MISSING verdict
    // means "never checked", so a fixture that omits this exercises the guard rather than
    // the arithmetic it means to test.
    //
    // Stamped only on the fixtures whose ratchet is supposed to RUN. The guard itself has
    // its own describe block -- 'a coverage ratchet whose baseline was never tied to the
    // code' -- and the fixtures there deliberately leave it off or set it unverifiable.
    const unitVerified: readonly CoverageProvenanceStamp[] = [
      { suite: 'coverage.unit', kind: 'verified' },
    ]

    // #43, end to end at the rules layer. The ratchet is the ONLY coverage rule,
    // there IS a baseline to ratchet against, and the current report is absent.
    //
    // Before an absent report was reported, this configuration was the worst case
    // in the tool: no current value, so `evaluateMonotonic` hit its `continue` and
    // the rule silently did not run; a baseline object WAS returned, so cli.ts did
    // not count the run as having skipped its monotonic rules; and with no
    // measurement failure recorded, the pass was cached as fully earned. A project
    // whose coverage script stopped writing a report would ratchet forever against
    // nothing and never be told.
    it('fails a coverage ratchet whose current report is missing', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [{ direction: 'up', metrics: ['coverage.unit.branches'] }],
        },
      }

      const currentMetrics: Metrics = {
        // Exactly what the provider hands back for an absent summary: no coverage
        // numbers, and the reason why.
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
        measurementFailures: [
          {
            kind: 'report-missing' as MeasurementFailure['kind'],
            dimension: 'coverage.unit',
            message: '/p/coverage/coverage-summary.json does not exist',
            evidence: {
              via: 'report' as const,
              command: 'read /p/coverage/coverage-summary.json',
              elapsedMs: 1,
              attempts: [
                {
                  path: '/p/coverage/coverage-summary.json',
                  existed: false,
                  bytesRead: null,
                  modifiedMs: null,
                  outcome: 'absent' as const,
                },
              ],
            },
          },
        ],
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
        rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: { unit: { branches: 80, statements: 85, functions: 75, lines: 80 } },
          typescript: { errors: 0, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
      }

      const result = evaluateRules(rules, currentMetrics, baselineEntry)

      expect(result.status).toBe('fail')
      // The MEASUREMENT is what failed, not the comparison -- there is nothing to
      // compare. Naming the monotonic rule would claim coverage went down.
      expect(result.failedRules).toHaveLength(1)
      expect(result.failedRules[0].rule).toBe('coverage.unit.measurement')
      expect(result.failedRules[0].type).toBe('measurement')
      expect(result.failedRules[0].message).toContain('report-missing')
    })

    it('passes when metric increases (direction: up)', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'up', metrics: ['coverage.unit.branches'] },
          ],
        },
      }

      const currentMetrics: Metrics = {
        coverage: { unit: { branches: 85, statements: 90, functions: 80, lines: 85 } },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
                rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: { unit: { branches: 80, statements: 85, functions: 75, lines: 80 } },
          typescript: { errors: 0, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
      }

      const result = evaluateRules(rules, currentMetrics, baselineEntry)

      expect(result.status).toBe('pass')
    })

    it('fails when metric decreases (direction: up)', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'up', metrics: ['coverage.unit.branches'] },
          ],
        },
      }

      const currentMetrics: Metrics = {
        coverage: { unit: { branches: 75, statements: 90, functions: 80, lines: 85 } },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
                rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: { unit: { branches: 80, statements: 85, functions: 75, lines: 80 } },
          typescript: { errors: 0, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
        coverageProvenance: unitVerified,
      }

      const result = evaluateRules(rules, currentMetrics, baselineEntry)

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].type).toBe('monotonic')
      expect(result.failedRules[0].message).toContain('decreased')
    })

    it('passes when metric decreases (direction: down)', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'down', metrics: ['typescript.errors'] },
          ],
        },
      }

      const currentMetrics: Metrics = {
        coverage: {},
        typescript: { errors: 2, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
                rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: {},
          typescript: { errors: 5, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
      }

      const result = evaluateRules(rules, currentMetrics, baselineEntry)

      expect(result.status).toBe('pass')
    })

    // Found by adversarial review after the per-metric fix landed. The no-baseline
    // case returned early with an empty list, on the reasoning that the CLI says so in
    // its own words -- true of the CLI, and false of every other consumer. The MCP
    // handler was confirmed serialising `{status:"pass", failedRules:[],
    // unevaluated:[]}` for a project where every ratchet was skipped, which is a clean
    // bill of health for a run that compared nothing. The rule belongs in the
    // evaluator so no consumer re-derives it; the CLI filters `no-baseline` out of its
    // own printed list.
    it('reports every ratchet as unevaluated when there is no baseline at all', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'up', metrics: ['coverage.unit.branches'] },
            { direction: 'down', metrics: ['typescript.errors', 'eslint.errors'] },
          ],
        },
      }

      const metrics: Metrics = {
        coverage: { unit: { branches: 50, statements: 60, functions: 50, lines: 55 } },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics, undefined)

      expect(result.status).toBe('pass')
      // One per METRIC, not one per rule: three metrics across two rules.
      expect(result.unevaluated).toHaveLength(3)
      expect(result.unevaluated.every((u) => u.reason === 'no-baseline')).toBe(true)
      expect(result.unevaluated.map((u) => u.rule)).toEqual([
        'up:coverage.unit.branches',
        'down:typescript.errors',
        'down:eslint.errors',
      ])
    })

    // A rule listing no metrics runs zero comparisons and, before this, left no trace:
    // the inner loop simply did not execute, so with a baseline present the run was
    // recorded as fully evaluated and the pass was cacheable. rules.json is
    // `JSON.parse`d and cast with no runtime validation of this shape, so
    // `{"direction":"down","metrics":[]}` is a config anyone can write.
    it('reports a monotonic rule that names no metrics', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: { monotonic: [{ direction: 'down', metrics: [] }] },
      }

      const metrics: Metrics = {
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
        rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          typescript: { errors: 0, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
      }

      const result = evaluateRules(rules, metrics, baselineEntry)

      expect(result.unevaluated).toHaveLength(1)
      expect(result.unevaluated[0].reason).toBe('no-metrics')
    })

    it('skips monotonic evaluation when no baseline', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'up', metrics: ['coverage.unit.branches'] },
          ],
        },
      }

      const metrics: Metrics = {
        coverage: { unit: { branches: 50, statements: 60, functions: 50, lines: 55 } },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics, undefined)

      expect(result.status).toBe('pass')
    })

    // #28. A ratchet whose baseline value is absent does not fail -- a rule that did
    // not run is not evidence of a violation -- but it must not pass in SILENCE
    // either. The `unevaluated` assertion is the point of this test; the `pass` was
    // all it checked before, and that is exactly the state a run could reach while
    // being cached as a fully-earned verdict. Reachable by adding a ratchet to
    // rules.json after the baseline was written.
    it('reports a ratchet whose baseline value is absent instead of skipping it', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'up', metrics: ['coverage.unit.branches'] },
          ],
        },
      }

      const currentMetrics: Metrics = {
        coverage: { unit: { branches: 85, statements: 90, functions: 80, lines: 85 } },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
        rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: {}, // No unit.branches in baseline
          typescript: { errors: 0, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
      }

      const result = evaluateRules(rules, currentMetrics, baselineEntry)

      // No violation to report -- there is nothing to compare against.
      expect(result.status).toBe('pass')
      expect(result.failedRules).toHaveLength(0)

      // ...but the run is on the record as narrower than a clean one.
      expect(result.unevaluated).toHaveLength(1)
      expect(result.unevaluated[0]).toMatchObject({
        type: 'monotonic',
        rule: 'up:coverage.unit.branches',
        metricPath: 'coverage.unit.branches',
        reason: 'baseline-missing',
      })
      expect(result.unevaluated[0].message).toContain('absent from the baseline')
    })

    // The other half of the same guard. A ratchet with a live baseline and no CURRENT
    // value is a different diagnosis -- the reading is incomplete, not history --
    // and it is reported as such. Usually a measurement failure arrives with it and
    // fails the gate independently (see the #43 test above, which asserts exactly
    // that); this fixture omits the failure so the unevaluated channel is what is
    // under test, which is also the shape a dimension with no failure channel
    // produces (#42).
    it('reports a ratchet whose current value is absent, distinguishing it from a stale baseline', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'up', metrics: ['coverage.unit.branches'] },
          ],
        },
      }

      const currentMetrics: Metrics = {
        coverage: {}, // No unit.branches in current
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
        rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: { unit: { branches: 80, statements: 85, functions: 75, lines: 80 } },
          typescript: { errors: 0, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
      }

      const result = evaluateRules(rules, currentMetrics, baselineEntry)

      expect(result.status).toBe('pass')
      expect(result.unevaluated).toHaveLength(1)
      expect(result.unevaluated[0].reason).toBe('current-missing')
      expect(result.unevaluated[0].message).toContain("absent from this run's")
    })

    // The negative control for the pair above. Without it, "report everything as
    // unevaluated" would satisfy both of them, and every run would be demoted to a
    // baseline-only entry -- which is the same cache deadlock the two-tier write
    // exists to avoid, arrived at from the other direction.
    it('reports nothing unevaluated when both values are present', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'up', metrics: ['coverage.unit.branches'] },
            { direction: 'down', metrics: ['typescript.errors'] },
          ],
        },
      }

      const metrics: Metrics = {
        coverage: { unit: { branches: 85, statements: 90, functions: 80, lines: 85 } },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
        rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: { unit: { branches: 80, statements: 85, functions: 75, lines: 80 } },
          typescript: { errors: 0, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
        coverageProvenance: unitVerified,
      }

      const result = evaluateRules(rules, metrics, baselineEntry)

      expect(result.status).toBe('pass')
      expect(result.unevaluated).toEqual([])
    })

    // Per-METRIC, not per-rule: one rule naming two metrics, one of which the
    // baseline carries. The comparable metric must still be enforced. An
    // implementation that gave up on the whole rule at the first absent metric would
    // pass this test's `pass` assertion and fail its `failedRules` one.
    it('still enforces the comparable metrics of a rule that also names an absent one', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            {
              direction: 'up',
              metrics: ['coverage.unit.branches', 'coverage.lambda.branches'],
            },
          ],
        },
      }

      const metrics: Metrics = {
        coverage: { unit: { branches: 70, statements: 90, functions: 80, lines: 85 } },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
        rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: { unit: { branches: 80, statements: 85, functions: 75, lines: 80 } },
          typescript: { errors: 0, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
        coverageProvenance: unitVerified,
      }

      const result = evaluateRules(rules, metrics, baselineEntry)

      expect(result.status).toBe('fail')
      expect(result.failedRules).toHaveLength(1)
      expect(result.failedRules[0].rule).toBe('up:coverage.unit.branches')

      expect(result.unevaluated).toHaveLength(1)
      expect(result.unevaluated[0].metricPath).toBe('coverage.lambda.branches')
    })

    it('fails when metric increases (direction: down)', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          monotonic: [
            { direction: 'down', metrics: ['typescript.errors'] },
          ],
        },
      }

      const currentMetrics: Metrics = {
        coverage: {},
        typescript: { errors: 10, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const baselineEntry: CacheEntry = {
        timestamp: Date.now(),
        rulesHash: 'def',
        rulesVersion: '1.0.0',
        metrics: {
          coverage: {},
          typescript: { errors: 5, warnings: 0, rootCauses: 0 },
          eslint: { errors: 0, warnings: 0, rootCauses: 0 },
          scripts: {},
          sloc: 1000,
        },
        evaluation: { status: 'pass', failedRules: [] },
      }

      const result = evaluateRules(rules, currentMetrics, baselineEntry)

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].type).toBe('monotonic')
      expect(result.failedRules[0].message).toContain('increased')
    })
  })

  describe('script evaluation', () => {
    it('passes when required scripts pass', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          requiredScripts: ['test'],
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: { test: 'pass' },
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('pass')
    })

    it('fails when required script fails', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          requiredScripts: ['test'],
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: { test: 'fail' },
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].type).toBe('script')
    })

    it('fails when required script was not run', () => {
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {
          requiredScripts: ['test'],
        },
      }

      const metrics: Metrics = {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      }

      const result = evaluateRules(rules, metrics)

      expect(result.status).toBe('fail')
      expect(result.failedRules[0].message).toContain('was not run')
    })
  })
})

describe('isCacheValid', () => {
  // The read half of the monotonic bootstrap fix, and the pair below is the whole
  // point. Such an entry is written now (it used to be withheld, which deadlocked
  // the cache chain permanently for any project with a ratchet), so something has to
  // stop it being served as a verdict -- an unevaluated ratchet leaves no trace in
  // `metrics` for the failure check above to catch, so a later run would exit 0 on a
  // rule that never executed. It stays usable as a BASELINE, which is a different
  // question with an honest yes; see findBaselineEntry.
  describe('an entry whose monotonic rules never ran', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: { monotonic: [{ direction: 'up', metrics: ['coverage.unit.branches'] }] },
    }
    const entryWith = (monotonicEvaluated: boolean | undefined): CacheEntry => ({
      timestamp: Date.now(),
      rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: { scripts: {}, coverage: { unit: { branches: 80 } } } as CacheEntry['metrics'],
      evaluation: { status: 'pass', failedRules: [] },
      ...(monotonicEvaluated === undefined ? {} : { monotonicEvaluated }),
    })

    it('is refused as a verdict', () => {
      expect(isCacheValid(entryWith(false), rules)).toBe(false)
    })

    it('is accepted when the rules DID run', () => {
      expect(isCacheValid(entryWith(true), rules)).toBe(true)
    })

    // History is tolerated on READ: entries written before the field existed carry no
    // value, and "evaluated" is what that absence meant when they were written.
    // Refusing them instead would discard every pre-existing entry on upgrade -- the
    // same cost as a schema bump, without the bump.
    it('is accepted when the field is absent, as older entries have it', () => {
      expect(isCacheValid(entryWith(undefined), rules)).toBe(true)
    })
  })

  // The key cannot catch a config change on the path that matters. A CLEAN tree keys
  // on the bare commit hash -- it has to, since findBaselineEntry looks entries up by
  // commit hash -- so a gitignored tsconfig.json or quality-gate.config.js can be
  // rewritten with git still reporting a clean tree, the key still landing on the same
  // commit, and the previous verdict still served for a measurement that now means
  // something else. Found by adversarial review after the WIP-key half was fixed:
  // "tracked or not" was true of the dirty path only.
  describe('an entry measured under different config', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: { floors: { 'coverage.unit.branches': 50 } },
    }
    const entryStamped = (hash: string | undefined): CacheEntry => ({
      timestamp: Date.now(),
      rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      metrics: { scripts: {}, coverage: { unit: { branches: 80 } } } as CacheEntry['metrics'],
      evaluation: { status: 'pass', failedRules: [] },
      ...(hash === undefined ? {} : { measurementInputsHash: hash }),
    })

    it('is refused', () => {
      expect(isCacheValid(entryStamped('a-different-digest'), rules)).toBe(false)
    })

    // The control, without which "refuse everything" satisfies the case above.
    it('is accepted when the config is the same', () => {
      expect(isCacheValid(entryStamped(measurementInputsHash()), rules)).toBe(true)
    })

    // Unlike `packageManager`, absence implies no particular config state, so there is
    // nothing sound to infer and the entry is refused. Schema 5 means no entry this
    // version reads should lack one; this is the invariant made checkable rather than
    // a case that fires in normal operation.
    it('is refused when the entry carries no digest at all', () => {
      expect(isCacheValid(entryStamped(undefined), rules)).toBe(false)
    })
  })

  // The cache key cannot catch a runner swap: it hashes tracked code under
  // codePathspecs (src/, tests/, scripts/), and no lockfile is in it, so dropping a
  // bun.lock into an npm project changes which toolchain measures and leaves the key
  // untouched. Coverage is the concrete path -- a different test runner writes a
  // different report, or none -- so the stored verdict would be served for numbers
  // that toolchain never produced.
  describe('an entry measured by a different package manager', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: { floors: { 'coverage.unit.branches': 50 } },
    }
    const entryFrom = (packageManager: 'npm' | 'bun' | undefined): CacheEntry => ({
      timestamp: Date.now(),
      rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: { scripts: {}, coverage: { unit: { branches: 80 } } } as CacheEntry['metrics'],
      evaluation: { status: 'pass', failedRules: [] },
      ...(packageManager === undefined ? {} : { packageManager }),
    })

    afterEach(() => {
      delete process.env.QUALITY_PACKAGE_MANAGER
      resetConfig()
    })

    const runningUnder = (manager: 'npm' | 'bun') => {
      process.env.QUALITY_PACKAGE_MANAGER = manager
      resetConfig()
    }

    it('is refused', () => {
      runningUnder('bun')
      expect(isCacheValid(entryFrom('npm'), rules)).toBe(false)
    })

    it('is accepted when the manager matches', () => {
      runningUnder('bun')
      expect(isCacheValid(entryFrom('bun'), rules)).toBe(true)
    })

    // Absence means npm by INFERENCE, not by leniency: every entry written before
    // this field existed came from a version with npm hardcoded at each spawn site,
    // so npm is genuinely what measured it. That soundness is what lets the field be
    // added without a schema bump.
    it('treats an entry with no manager as npm, and refuses it under bun', () => {
      runningUnder('bun')
      expect(isCacheValid(entryFrom(undefined), rules)).toBe(false)
    })

    it('treats an entry with no manager as npm, and accepts it under npm', () => {
      runningUnder('npm')
      expect(isCacheValid(entryFrom(undefined), rules)).toBe(true)
    })
  })

  it('returns true when hashes match', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: {
        floors: { 'coverage.branches': 80 },
      },
    }

    const entry: CacheEntry = {
      timestamp: Date.now(),
            rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      },
      evaluation: { status: 'pass', failedRules: [] },
    }

    expect(isCacheValid(entry, rules)).toBe(true)
  })

  it('returns false when hashes differ', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: {
        floors: { 'coverage.branches': 80 },
      },
    }

    const entry: CacheEntry = {
      timestamp: Date.now(),
            rulesHash: 'different-hash',
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      },
      evaluation: { status: 'pass', failedRules: [] },
    }

    expect(isCacheValid(entry, rules)).toBe(false)
  })

  it('returns false when versions differ', () => {
    const rules: QualityRules = {
      version: '2.0.0',
      rules: {
        floors: { 'coverage.branches': 80 },
      },
    }

    const entry: CacheEntry = {
      timestamp: Date.now(),
            rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: {
        coverage: {},
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      },
      evaluation: { status: 'pass', failedRules: [] },
    }

    expect(isCacheValid(entry, rules)).toBe(false)
  })

  it('returns false when failed cache has missing floor metric', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: {
        floors: { 'coverage.unit.branches': 80 },
      },
    }

    const entry: CacheEntry = {
      timestamp: Date.now(),
      rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: {
        coverage: {}, // Missing coverage.unit.branches
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      },
      evaluation: { status: 'fail', failedRules: [] }, // Failed status
    }

    // Should return false because a floor metric was missing in a failed evaluation
    expect(isCacheValid(entry, rules)).toBe(false)
  })

  it('returns true when failed cache has all floor metrics present', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: {
        floors: { 'coverage.unit.branches': 80 },
      },
    }

    const entry: CacheEntry = {
      timestamp: Date.now(),
      rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: {
        coverage: { unit: { branches: 70, statements: 80, functions: 70, lines: 75 } },
        typescript: { errors: 0, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      },
      evaluation: { status: 'fail', failedRules: [] }, // Failed due to branches < 80
    }

    // Should return true because the metric exists (even though evaluation failed)
    expect(isCacheValid(entry, rules)).toBe(true)
  })

  it('returns true for failed cache when rules have no floors', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: {
        ceilings: { 'typescript.errors': 0 },
        // No floors defined
      },
    }

    const entry: CacheEntry = {
      timestamp: Date.now(),
      rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: {
        coverage: {},
        typescript: { errors: 5, warnings: 0, rootCauses: 0 },
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
      },
      evaluation: { status: 'fail', failedRules: [] }, // Failed due to errors > 0
    }

    // Should return true - no floor metrics to check for missing values
    expect(isCacheValid(entry, rules)).toBe(true)
  })

  // An entry carrying a measurement failure is an incomplete reading, and this
  // version never writes one -- `cli.ts` declines to cache any run with a
  // measurement failure, gated or not. The state is still reachable: schema
  // version 3 also covers an intermediate revision that suppressed the cache only
  // for GATED failures, so a version-3 PASS on disk can carry an ungated one.
  //
  // Serving it is the vacuous pass with the report deleted: the cached-pass path
  // prints "✓ Quality gate PASSED (cached)" and exits 0 without reading
  // `metrics.measurementFailures`, so the advisory that appeared on run 1 appears
  // nowhere afterwards.
  //
  // BOTH verdicts, because the pass branch returns early -- a check placed after
  // it would leave exactly the case that matters uncovered.
  it('refuses an entry that recorded a measurement failure', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: { ceilings: { 'eslint.errors': 0 } },
    }

    const withFailure = (status: 'pass' | 'fail'): CacheEntry => ({
      timestamp: Date.now(),
      rulesHash: computeRulesHash(rules),
      rulesVersion: '1.0.0',
      measurementInputsHash: measurementInputsHash(),
      metrics: {
        eslint: { errors: 0, warnings: 0, rootCauses: 0 },
        scripts: {},
        sloc: 1000,
        measurementFailures: [
          {
            kind: 'unparseable-output' as MeasurementFailure['kind'],
            dimension: 'coverage.lambda' as MeasurementFailure['dimension'],
            message: 'coverage-lambda/coverage-summary.json is not JSON',
            evidence: {
              via: 'report' as const,
              command: 'read coverage-lambda/coverage-summary.json',
              elapsedMs: 2,
              attempts: [
                {
                  path: '/p/coverage-lambda/coverage-summary.json',
                  existed: true,
                  bytesRead: 61,
                  modifiedMs: 1_700_000_000_000,
                  outcome: 'read' as const,
                },
              ],
            },
          },
        ],
      },
      evaluation: { status, failedRules: [] },
    })

    expect(isCacheValid(withFailure('pass'), rules)).toBe(false)
    expect(isCacheValid(withFailure('fail'), rules)).toBe(false)
  })
})

/**
 * The floor/ceiling asymmetry, which this codebase documented as a known hole for as
 * long as it stood: a missing FLOOR metric fails loudly (`Metric '...' not
 * available`) while a missing CEILING metric was skipped without a word. Adversarial
 * review reached it through `--coverage-only` with a rules.json that grades
 * `sonarqube.*`, which is a supported configuration and reported a clean pass on
 * rules nothing applied.
 */
describe('a ceiling whose metric was never measured', () => {
  const ceilingRules = (ceilings: Record<string, number>): QualityRules => ({
    version: '1.0.0',
    rules: { ceilings },
  })

  const bare: Metrics = { scripts: {}, coverage: {}, sloc: 100 }

  it('is reported as a rule that did not run, not silently skipped', () => {
    const result = evaluateRules(ceilingRules({ 'sonarqube.blocker': 0 }), bare)

    expect(result.unevaluated).toHaveLength(1)
    expect(result.unevaluated[0]).toMatchObject({
      type: 'skipped-dimension',
      rule: 'sonarqube.blocker',
      reason: 'dimension-skipped',
    })
  })

  // Reported, not failed. Promoting an unmeasured dimension to a failure was tried
  // and reversed -- see `evaluateMeasurements` -- because it fails a project for a
  // dimension nobody configured, and noise in the loud channel trains adopters to
  // stop reading it.
  it('does not fail the gate', () => {
    const result = evaluateRules(ceilingRules({ 'sonarqube.blocker': 0 }), bare)

    expect(result.status).toBe('pass')
    expect(result.failedRules).toHaveLength(0)
  })

  // The consequence that matters: `cli.ts` turns a nonempty `unevaluated` into
  // `monotonicEvaluated: false`, and `isCacheValid` refuses such an entry as a
  // verdict. So the pass is not inheritable by a later run that DID measure.
  it('leaves the run uncacheable as a verdict', () => {
    const rules = ceilingRules({ 'sonarqube.blocker': 0 })
    const result = evaluateRules(rules, bare)

    const entry = {
      timestamp: 1,
      rulesVersion: '1.0.0',
      rulesHash: computeRulesHash(rules),
      evaluation: { status: 'pass' as const, failedRules: [] },
      metrics: bare,
      monotonicEvaluated: result.unevaluated.length === 0,
    }

    expect(isCacheValid(entry, rules)).toBe(false)
  })

  // Not reported twice. An unreachable SonarQube already produces one
  // `sonarqube.measurement` failed rule that names the reason; repeating it once per
  // ceiling behind it would bury the one line that says what to fix.
  it('stays silent when a measurement failure already explains the absence', () => {
    const withFailure: Metrics = {
      ...bare,
      measurementFailures: [
        {
          kind: 'tool-missing',
          dimension: 'sonarqube',
          message: 'SonarQube did not answer',
          evidence: {
            via: 'process',
            command: 'curl -u <redacted> "http://localhost:9000/api/x"',
            exitCode: null,
            signal: null,
            elapsedMs: 1,
            stdoutBytes: 0,
            stderrBytes: 0,
          },
        },
      ],
    }

    const result = evaluateRules(
      ceilingRules({ 'sonarqube.blocker': 0, 'sonarqube.critical': 0 }),
      withFailure
    )

    expect(result.unevaluated).toHaveLength(0)
  })

  // The prefix walk. A coverage failure names the SUITE (`coverage.unit`), and the
  // ceiling names a metric under it, so matching only the first path segment would
  // report the ceiling as unexplained while the reason sat right beside it.
  it('matches a failure named for the suite, not just the top-level dimension', () => {
    const withSuiteFailure: Metrics = {
      ...bare,
      measurementFailures: [
        {
          kind: 'report-missing',
          dimension: 'coverage.unit',
          message: 'no coverage summary',
          evidence: {
            via: 'report',
            command: 'read coverage/coverage-summary.json',
            elapsedMs: 0,
            attempts: [],
          },
        },
      ],
    }

    const result = evaluateRules(
      ceilingRules({ 'coverage.unit.uncoveredLines': 10 }),
      withSuiteFailure
    )

    expect(result.unevaluated).toHaveLength(0)
  })

  it('says nothing about a ceiling whose metric IS present', () => {
    const measured: Metrics = {
      ...bare,
      typescript: { errors: 0, warnings: 0, rootCauses: 0 },
    }

    const result = evaluateRules(ceilingRules({ 'typescript.errors': 0 }), measured)

    expect(result.unevaluated).toHaveLength(0)
    expect(result.status).toBe('pass')
  })
})

/**
 * #48. `/api/measures/component` has no analysis parameter, so it answers with the LIVE
 * measures of a project key -- whatever the most recently processed analysis left in the
 * table. A second publisher for the same key between `waitForSonarTask` returning
 * SUCCESS and that read replaces them, and nothing in the response says which analysis
 * it described: the gate confirmed analysis A and graded analysis B. `readSonarqubeMetrics`
 * now states whether the numbers could be tied to the analysis this run submitted, and
 * these are the two things the gate does with that answer.
 */
describe('a sonarqube rule applied to numbers of unproven origin', () => {
  const ceilingRules = (ceilings: Record<string, number>): QualityRules => ({
    version: '1.0.0',
    rules: { ceilings },
  })

  const sonarqube = {
    bugs: 0,
    vulnerabilities: 0,
    codeSmells: 4,
    blocker: 0,
    critical: 0,
    major: 7,
    minor: 2,
    info: 1,
  }

  const unbound: Metrics = {
    scripts: {},
    sonarqube,
    sonarqubeProvenance: { kind: 'unconfirmed', why: 'because X' },
  }

  // D3, and the shape of it: reported, not failed. Some editions may not expose the
  // analysis identity at all, and failing there would block every adopter on such a
  // server over a hazard the tool cannot even detect for them.
  it('is reported once, naming the rules and the reason', () => {
    const result = evaluateRules(ceilingRules({ 'sonarqube.blocker': 0 }), unbound)

    expect(result.status).toBe('pass')
    expect(result.failedRules).toHaveLength(0)
    expect(result.unevaluated).toHaveLength(1)
    expect(result.unevaluated[0]).toMatchObject({
      type: 'unbound-provenance',
      rule: 'sonarqube.provenance',
      reason: 'provenance-unconfirmed',
    })
    expect(result.unevaluated[0].message).toContain('sonarqube.blocker')
    expect(result.unevaluated[0].message).toContain('because X')
  })

  // ONE entry, not one per rule. The sentence is identical for all eight sonarqube
  // ceilings a default ruleset ships, and noise in the loud channel is what trains
  // adopters to stop reading it.
  it('says it once for eight ceilings, not eight times', () => {
    const result = evaluateRules(
      ceilingRules({
        'sonarqube.bugs': 0,
        'sonarqube.vulnerabilities': 0,
        'sonarqube.blocker': 0,
        'sonarqube.critical': 0,
        'sonarqube.major': 10,
      }),
      unbound
    )

    expect(result.unevaluated.filter((u) => u.type === 'unbound-provenance')).toHaveLength(1)
    expect(result.unevaluated[0].message).toContain('5 sonarqube rule(s)')
  })

  // The consequence that actually matters, reusing the existing two-tier machinery with
  // no new cache field: `cli.ts` turns a nonempty `unevaluated` into
  // `monotonicEvaluated: false`, `isCacheValid` refuses that as a VERDICT, and
  // `findBaselineEntry` still accepts it as a BASELINE.
  it('leaves that run uncacheable as a verdict', () => {
    const rules = ceilingRules({ 'sonarqube.blocker': 0 })
    const result = evaluateRules(rules, unbound)

    const entry = {
      timestamp: 1,
      rulesVersion: '1.0.0',
      rulesHash: computeRulesHash(rules),
      evaluation: { status: 'pass' as const, failedRules: [] },
      metrics: unbound,
      monotonicEvaluated: result.unevaluated.length === 0,
    }

    expect(isCacheValid(entry, rules)).toBe(false)
  })

  // A normal run must not become permanently baseline-only -- that cost would land on
  // every adopter and destroy `PASSED (cached)` for all of them.
  it('says nothing when the provenance is confirmed', () => {
    const bound: Metrics = {
      ...unbound,
      sonarqubeProvenance: { kind: 'confirmed', analysisId: 'AN-1' },
    }

    const result = evaluateRules(ceilingRules({ 'sonarqube.blocker': 0 }), bound)

    expect(result.unevaluated.filter((u) => u.type === 'unbound-provenance')).toHaveLength(0)
  })

  // Gated on some rule reading sonarqube. Without the gate a project that measures
  // sonarqube and grades none of it would be baseline-only forever and re-scan every
  // run, over a provenance nothing grades against.
  it('says nothing when no rule grades sonarqube', () => {
    const alsoTypescript: Metrics = {
      ...unbound,
      typescript: { errors: 0, warnings: 0, rootCauses: 0 },
    }

    const result = evaluateRules(ceilingRules({ 'typescript.errors': 0 }), alsoTypescript)

    expect(result.unevaluated.filter((u) => u.type === 'unbound-provenance')).toHaveLength(0)
  })

  // The gate reads floors, ceilings AND monotonic rules, so a project that ratchets
  // `sonarqube.major` and sets no ceiling is not silently exempt.
  it('counts a ratchet on sonarqube as grading it', () => {
    const rules: QualityRules = {
      version: '1.0.0',
      rules: { monotonic: [{ direction: 'down', metrics: ['sonarqube.major'] }] },
    }

    const result = evaluateRules(rules, unbound)
    const provenance = result.unevaluated.filter((u) => u.type === 'unbound-provenance')

    expect(provenance).toHaveLength(1)
    expect(provenance[0].message).toContain('sonarqube.major')
  })
})

/**
 * #48, the quiet half. An unconfirmed run is only marked baseline-only, so its numbers
 * are still accepted as the ratchet FLOOR for the next commit -- and that next run
 * confirms its own provenance, is stamped fully evaluated, and IS cached as a verdict.
 * The regression the ratchet exists to catch is laundered through the baseline channel by
 * the entry the provenance check itself wrote.
 */
describe('a ratchet whose baseline sonarqube numbers were never bound', () => {
  const ratchet: QualityRules = {
    version: '1.0.0',
    rules: { monotonic: [{ direction: 'down', metrics: ['sonarqube.major'] }] },
  }

  const sonarqubeWith = (major: number) => ({
    bugs: 0,
    vulnerabilities: 0,
    codeSmells: 0,
    blocker: 0,
    critical: 0,
    major,
    minor: 0,
    info: 0,
  })

  const baselineEntryWith = (metrics: Metrics): CacheEntry => ({
    timestamp: 1,
    rulesVersion: '1.0.0',
    rulesHash: computeRulesHash(ratchet),
    evaluation: { status: 'pass', failedRules: [] },
    metrics,
  })

  // The two-commit sequence, as constructed. C1 read 120 from a foreign analysis and was
  // never able to bind it; C2 measures a real 118, which is a REGRESSION from C1's true
  // 90 and passes a naive 118 <= 120 comparison.
  const c1: Metrics = {
    scripts: {},
    sonarqube: sonarqubeWith(120),
    sonarqubeProvenance: { kind: 'unconfirmed', why: 'the project key names a module' },
  }
  const c2: Metrics = {
    scripts: {},
    sonarqube: sonarqubeWith(118),
    sonarqubeProvenance: { kind: 'confirmed', analysisId: 'AN-2' },
  }

  it('does not run, and says which number it refused to difference against', () => {
    const result = evaluateRules(ratchet, c2, baselineEntryWith(c1))

    expect(result.unevaluated).toHaveLength(1)
    expect(result.unevaluated[0]).toMatchObject({
      type: 'monotonic',
      rule: 'down:sonarqube.major',
      reason: 'baseline-unbound',
    })
    expect(result.unevaluated[0].message).toContain('120')
  })

  // And therefore C2 is not cacheable as a verdict either, which is what stops the
  // laundering: without this, C2 is stamped `monotonicEvaluated: true` and served.
  it('leaves the inheriting run uncacheable as a verdict', () => {
    const result = evaluateRules(ratchet, c2, baselineEntryWith(c1))

    expect(
      isCacheValid(
        {
          timestamp: 2,
          rulesVersion: '1.0.0',
          rulesHash: computeRulesHash(ratchet),
          evaluation: { status: 'pass', failedRules: [] },
          metrics: c2,
          monotonicEvaluated: result.unevaluated.length === 0,
        },
        ratchet
      )
    ).toBe(false)
  })

  // An entry written before the field existed carries a sonarqube reading and no
  // provenance, which means "never checked" and not "fine".
  it('treats an absent baseline provenance the same as an unconfirmed one', () => {
    const preFix: Metrics = { scripts: {}, sonarqube: sonarqubeWith(120) }

    const result = evaluateRules(ratchet, c2, baselineEntryWith(preFix))

    expect(result.unevaluated[0]).toMatchObject({ reason: 'baseline-unbound' })
  })

  // The ordinary case must still ratchet, or this check has disabled the feature.
  it('runs normally when the baseline was bound', () => {
    const boundBaseline: Metrics = {
      ...c1,
      sonarqubeProvenance: { kind: 'confirmed', analysisId: 'AN-1' },
    }

    const passing = evaluateRules(ratchet, c2, baselineEntryWith(boundBaseline))
    expect(passing.unevaluated).toHaveLength(0)
    expect(passing.status).toBe('pass')

    const regressed: Metrics = { ...c2, sonarqube: sonarqubeWith(121) }
    const failing = evaluateRules(ratchet, regressed, baselineEntryWith(boundBaseline))
    expect(failing.status).toBe('fail')
    expect(failing.failedRules[0].rule).toBe('down:sonarqube.major')
  })

  // A ratchet on a dimension that is not sonarqube is untouched by any of this.
  it('does not interfere with a ratchet on another dimension', () => {
    const tsRatchet: QualityRules = {
      version: '1.0.0',
      rules: { monotonic: [{ direction: 'down', metrics: ['typescript.errors'] }] },
    }
    const before: Metrics = {
      ...c1,
      typescript: { errors: 5, warnings: 0, rootCauses: 0 },
    }
    const after: Metrics = {
      ...c2,
      typescript: { errors: 5, warnings: 0, rootCauses: 0 },
    }

    const result = evaluateRules(tsRatchet, after, baselineEntryWith(before))

    expect(result.unevaluated).toHaveLength(0)
    expect(result.status).toBe('pass')
  })
})

/**
 * #39's BASELINE half, which the sonarqube half above left open by asserting in a
 * comment that it did not exist.
 *
 * `usableBaseline` said an unconfirmed entry "is still an honest reading of its
 * typescript, eslint and coverage" -- written when coverage provenance was not a thing
 * that could fail. Once it was, coverage needed the identical guard and did not have
 * one: `monotonicEvaluated: false` stops the unverified run being served as a VERDICT,
 * and nothing stopped it being differenced against as a BASELINE.
 *
 * Same construction and the same arithmetic as the sonarqube block, one dimension over.
 */
describe('a coverage ratchet whose baseline was never tied to the code', () => {
  const ratchet: QualityRules = {
    version: '1.0.0',
    rules: { monotonic: [{ direction: 'up', metrics: ['coverage.unit.statements'] }] },
  }

  const coverageWith = (statements: number): Metrics['coverage'] => ({
    unit: { statements, branches: statements, functions: statements, lines: statements },
  })

  const entryWith = (
    metrics: Metrics,
    coverageProvenance?: readonly CoverageProvenanceStamp[]
  ): CacheEntry => ({
    timestamp: 1,
    rulesVersion: '1.0.0',
    rulesHash: computeRulesHash(ratchet),
    evaluation: { status: 'pass', failedRules: [] },
    metrics,
    ...(coverageProvenance === undefined ? {} : { coverageProvenance }),
  })

  // C1's report was never stamped, so its 10 is advisory-only and the entry is written
  // baseline-only. C2 stamps a real report at 40 -- a REGRESSION from C1's true 90 --
  // and 40 >= 10 passes a naive `up` comparison.
  const c1: Metrics = { scripts: {}, coverage: coverageWith(10) }
  const c2: Metrics = { scripts: {}, coverage: coverageWith(40) }
  const verified: readonly CoverageProvenanceStamp[] = [
    { suite: 'coverage.unit', kind: 'verified' },
  ]

  it('does not run, and says which number it refused to difference against', () => {
    const result = evaluateRules(
      ratchet,
      c2,
      entryWith(c1, [{ suite: 'coverage.unit', kind: 'unverifiable' }])
    )

    expect(result.unevaluated).toHaveLength(1)
    expect(result.unevaluated[0]).toMatchObject({
      type: 'monotonic',
      rule: 'up:coverage.unit.statements',
      reason: 'baseline-unbound',
    })
    expect(result.unevaluated[0].message).toContain('10')
    expect(result.unevaluated[0].message).toContain('coverage.unit')
  })

  // Which is what stops the laundering: without it C2 is stamped
  // `monotonicEvaluated: true` and served as a verdict on the next run.
  it('leaves the inheriting run uncacheable as a verdict', () => {
    const result = evaluateRules(
      ratchet,
      c2,
      entryWith(c1, [{ suite: 'coverage.unit', kind: 'unverifiable' }])
    )

    expect(
      isCacheValid(
        {
          timestamp: 2,
          rulesVersion: '1.0.0',
          rulesHash: computeRulesHash(ratchet),
          evaluation: { status: 'pass', failedRules: [] },
          metrics: c2,
          monotonicEvaluated: result.unevaluated.length === 0,
        },
        ratchet
      )
    ).toBe(false)
  })

  // An entry written before the field existed carries coverage numbers and no verdict,
  // which means "never checked" and not "fine".
  it('treats an absent baseline verdict the same as an unverifiable one', () => {
    const result = evaluateRules(ratchet, c2, entryWith(c1))

    expect(result.unevaluated[0]).toMatchObject({ reason: 'baseline-unbound' })
  })

  // A stale baseline is only reachable from history -- a stale report fails the gate and
  // the failure blocks the entry write -- but differencing against one is the same defect.
  it('refuses a baseline whose report was recognised as stale', () => {
    const result = evaluateRules(
      ratchet,
      c2,
      entryWith(c1, [{ suite: 'coverage.unit', kind: 'stale' }])
    )

    expect(result.unevaluated[0]).toMatchObject({ reason: 'baseline-unbound' })
  })

  // The ordinary case must still ratchet, or this check has disabled the feature.
  it('runs normally when the baseline report was verified', () => {
    const passing = evaluateRules(ratchet, c2, entryWith(c1, verified))
    expect(passing.unevaluated).toHaveLength(0)
    expect(passing.status).toBe('pass')

    const regressed: Metrics = { scripts: {}, coverage: coverageWith(5) }
    const failing = evaluateRules(ratchet, regressed, entryWith(c1, verified))
    expect(failing.status).toBe('fail')
    expect(failing.failedRules[0].rule).toBe('up:coverage.unit.statements')
  })

  // PER-SUITE. A project whose unit report is stamped and whose lambda report is not
  // must keep the ratchets that read unit and lose only the ones that read lambda.
  it('refuses only the suites whose provenance is unestablished', () => {
    const both: QualityRules = {
      version: '1.0.0',
      rules: {
        monotonic: [
          {
            direction: 'up',
            metrics: ['coverage.unit.statements', 'coverage.lambda.statements'],
          },
        ],
      },
    }
    const withLambda = (statements: number): Metrics => ({
      scripts: {},
      coverage: {
        unit: {
          statements,
          branches: statements,
          functions: statements,
          lines: statements,
        },
        lambda: {
          statements,
          branches: statements,
          functions: statements,
          lines: statements,
        },
      },
    })

    const result = evaluateRules(
      both,
      withLambda(40),
      entryWith(withLambda(10), verified)
    )

    expect(result.unevaluated).toHaveLength(1)
    expect(result.unevaluated[0].metricPath).toBe('coverage.lambda.statements')
    expect(result.unevaluated[0].reason).toBe('baseline-unbound')
  })

  // A `coverage.union` ratchet is differenced against numbers summed from BOTH reports,
  // so it must refuse when EITHER suite is unestablished. A single-suite answer here
  // would keep the ratchet running on half a provenance -- the same "derived number
  // graded from a failed upstream" shape `measurementsBehind` exists to close.
  it('refuses a union ratchet when only one of its two suites is verified', () => {
    const union: QualityRules = {
      version: '1.0.0',
      rules: { monotonic: [{ direction: 'up', metrics: ['coverage.union.statements'] }] },
    }
    const withUnion = (statements: number): Metrics => ({
      scripts: {},
      coverage: {
        unit: {
          statements,
          branches: statements,
          functions: statements,
          lines: statements,
        },
        union: {
          statements,
          branches: statements,
          functions: statements,
          lines: statements,
        },
      },
    })

    const result = evaluateRules(
      union,
      withUnion(40),
      entryWith(withUnion(10), verified)
    )

    expect(result.unevaluated).toHaveLength(1)
    expect(result.unevaluated[0]).toMatchObject({
      metricPath: 'coverage.union.statements',
      reason: 'baseline-unbound',
    })
  })

  // A ratchet on a dimension that reads no coverage report is untouched by any of this.
  it('does not interfere with a ratchet on another dimension', () => {
    const tsRatchet: QualityRules = {
      version: '1.0.0',
      rules: { monotonic: [{ direction: 'down', metrics: ['typescript.errors'] }] },
    }
    const before: Metrics = {
      ...c1,
      typescript: { errors: 5, warnings: 0, rootCauses: 0 },
    }
    const after: Metrics = {
      ...c2,
      typescript: { errors: 5, warnings: 0, rootCauses: 0 },
    }

    const result = evaluateRules(tsRatchet, after, entryWith(before))

    expect(result.unevaluated).toHaveLength(0)
    expect(result.status).toBe('pass')
  })
})

/**
 * #48, the entry the schema counter cannot catch: one written by an INTERMEDIATE
 * revision of schema version 7, before sonarqube readings were bound to an analysis. It
 * carries a sonarqube reading, no provenance and no unevaluated rule, so it looks fully
 * earned -- and `cli.ts` exits 0 on a cached pass before contacting the server.
 */
describe('a cached entry whose sonarqube numbers were never bound', () => {
  const entryWith = (metrics: Metrics, rules: QualityRules): CacheEntry => ({
    timestamp: 1,
    rulesVersion: rules.version,
    rulesHash: computeRulesHash(rules),
    evaluation: { status: 'pass', failedRules: [] },
    metrics,
    monotonicEvaluated: true,
    packageManager: 'npm',
    measurementInputsHash: measurementInputsHash(),
  })

  const sonarqube = {
    bugs: 0,
    vulnerabilities: 0,
    codeSmells: 0,
    blocker: 0,
    critical: 0,
    major: 0,
    minor: 0,
    info: 0,
  }

  const sonarRules: QualityRules = {
    version: '1.0.0',
    rules: { ceilings: { 'sonarqube.blocker': 0 } },
  }

  it('is not served as a verdict when a rule grades sonarqube', () => {
    const entry = entryWith({ scripts: {}, sonarqube }, sonarRules)

    expect(isCacheValid(entry, sonarRules)).toBe(false)
  })

  it('is served when the provenance was confirmed', () => {
    const entry = entryWith(
      {
        scripts: {},
        sonarqube,
        sonarqubeProvenance: { kind: 'confirmed', analysisId: 'AN-1' },
      },
      sonarRules
    )

    expect(isCacheValid(entry, sonarRules)).toBe(true)
  })

  // Scoped to rulesets that grade sonarqube, for the same reason the advisory is: a
  // project that measures sonarqube and grades none of it must not re-measure forever.
  it('is served when no rule grades sonarqube', () => {
    const tsRules: QualityRules = {
      version: '1.0.0',
      rules: { ceilings: { 'typescript.errors': 0 } },
    }
    const entry = entryWith(
      { scripts: {}, sonarqube, typescript: { errors: 0, warnings: 0, rootCauses: 0 } },
      tsRules
    )

    expect(isCacheValid(entry, tsRules)).toBe(true)
  })

  // `--coverage-only` writes no sonarqube reading at all, so there is nothing to bind
  // and the pre-existing `skipped-dimension` advisory is what covers it.
  it('is served when the entry has no sonarqube reading at all', () => {
    const entry = entryWith({ scripts: {} }, sonarRules)

    expect(isCacheValid(entry, sonarRules)).toBe(true)
  })
})

// ===========================================================================
// Which rules read a dimension
// ===========================================================================
//
// `isMeasurementUnderRule` answers this as a boolean, and a boolean cannot be
// reported. The coverage-provenance advisory has to NAME the rules it stands for --
// an adopter told "some rule reads this" cannot act on it -- so both callers now go
// through one matcher and this pins the two answers together.
describe('rulesReadingMeasurement', () => {
  const gradesCoverageThreeWays: QualityRules = {
    version: '1.0.0',
    rules: {
      floors: { 'coverage.unit.branches': 50, 'coverage.union.statements': 60 },
      ceilings: { 'typescript.errors': 0 },
      monotonic: [{ direction: 'up', metrics: ['coverage.unit.statements'] }],
    },
  }

  it('names every rule surface that reads the dimension, including the derived one', () => {
    // `coverage.union.statements` is in the list because `coverage.union` is COMPUTED
    // from `coverage.unit` -- name matching cannot see that, so the edge is declared
    // in DERIVED_FROM and this is the caller that depends on it being followed.
    expect(rulesReadingMeasurement(gradesCoverageThreeWays, 'coverage.unit')).toEqual([
      // Sorted, because the caller puts this in a sentence -- and `union` sorts before
      // `unit` ('o' < 't'), which is worth pinning so a reorder is a test failure
      // rather than a silently different message.
      'coverage.union.statements',
      'coverage.unit.branches',
      'coverage.unit.statements',
    ])
  })

  it('says nothing for a build-only ruleset', () => {
    // The scoping the advisory depends on. Without it every build-only project with a
    // stray coverage/ directory would print a coverage advisory it has no rule for and
    // would stop caching verdicts.
    const buildOnly: QualityRules = {
      version: '1.0.0',
      rules: { ceilings: { 'typescript.errors': 3, 'eslint.errors': 2 }, requiredScripts: [] },
    }

    expect(rulesReadingMeasurement(buildOnly, 'coverage.unit')).toEqual([])
    expect(isMeasurementUnderRule(buildOnly, 'coverage.unit')).toBe(false)
  })

  it('agrees with isMeasurementUnderRule on every row', () => {
    const rows = [
      { rules: gradesCoverageThreeWays, dimension: 'coverage.unit', gated: true },
      { rules: gradesCoverageThreeWays, dimension: 'coverage.lambda', gated: true },
      { rules: gradesCoverageThreeWays, dimension: 'typescript', gated: true },
      { rules: gradesCoverageThreeWays, dimension: 'sonarqube', gated: false },
      { rules: gradesCoverageThreeWays, dimension: 'custom.anyCount', gated: false },
    ]

    for (const row of rows) {
      expect(
        rulesReadingMeasurement(row.rules, row.dimension).length > 0,
        row.dimension
      ).toBe(row.gated)
      expect(isMeasurementUnderRule(row.rules, row.dimension), row.dimension).toBe(row.gated)
    }
  })
})

// ===========================================================================
// A stale report is not an unmeasured dimension
// ===========================================================================
//
// THREE measurement failures arrive WITH a number for their dimension: the report
// parsed, `total` was valid, and `metrics.coverage.unit` holds a percentage. Every other
// kind arrives with the dimension absent, which is what made "could not be measured" a
// true sentence. Printing it over one of these three contradicts the percentage in the
// same output.
//
// The set is enumerated in a test rather than left implicit because it grew, and growing
// it is what made the sentence false: `provenance-unverified` and
// `code-changed-during-measurement` both joined `stale-report`, and every surface
// carrying its own `=== 'stale-report'` check kept printing the wrong sentence for them.
// This case failed only against the apollo-client golden master, which is a slow and
// lucky way to catch a wording bug. See MEASUREMENT_KINDS_REPORTING_A_NUMBER.
describe('the sentence a stale coverage report gets', () => {
  const staleFailure: MeasurementFailure = {
    kind: 'stale-report',
    dimension: 'coverage.unit',
    message: '/p/coverage/coverage-summary.json describes a different state of the code.',
    evidence: {
      via: 'report',
      command: 'read /p/coverage/coverage-summary.json',
      elapsedMs: 0,
      attempts: [
        {
          path: '/p/coverage/coverage-summary.json',
          existed: true,
          bytesRead: null,
          modifiedMs: null,
          outcome: 'read',
        },
      ],
    },
  }

  it('fails the rule without claiming the dimension was not measured', () => {
    const result = evaluateRules(
      { version: '1.0.0', rules: { floors: { 'coverage.unit.statements': 50 } } },
      {
        scripts: {},
        coverage: { unit: { branches: 80, statements: 80, functions: 80, lines: 80 } },
        measurementFailures: [staleFailure],
      }
    )

    expect(result.status).toBe('fail')
    const measurement = result.failedRules.find((f) => f.rule === 'coverage.unit.measurement')
    expect(measurement?.message).toContain('was measured, but nothing ties the number to this code')
    expect(measurement?.message).not.toContain('could not be measured')
  })

  it.each([
    'provenance-unverified',
    'code-changed-during-measurement',
  ] as const)('says the same of a %s reading, which also carries a number', (kind) => {
    const result = evaluateRules(
      { version: '1.0.0', rules: { floors: { 'coverage.unit.statements': 50 } } },
      {
        scripts: {},
        coverage: { unit: { branches: 80, statements: 80, functions: 80, lines: 80 } },
        measurementFailures: [{ ...staleFailure, kind }],
      }
    )

    expect(result.status).toBe('fail')
    const measurement = result.failedRules.find((f) => f.rule === 'coverage.unit.measurement')
    expect(measurement?.message).toContain('was measured, but nothing ties the number to this code')
    expect(measurement?.message).not.toContain('could not be measured')
  })

  it('still says "could not be measured" for a dimension that really was not', () => {
    const result = evaluateRules(
      { version: '1.0.0', rules: { ceilings: { 'eslint.errors': 0 } } },
      {
        scripts: {},
        measurementFailures: [{ ...staleFailure, kind: 'crashed', dimension: 'eslint' }],
      }
    )

    expect(result.failedRules[0].message).toContain('eslint could not be measured')
  })
})
