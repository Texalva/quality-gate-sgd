import { describe, it, expect, afterEach } from 'vitest'
import {
  loadRules,
  computeRulesHash,
  evaluateRules,
  isCacheValid,
  isUsingEmbeddedDefaults,
} from '../src/rules.js'
import { resetConfig } from '../src/config.js'
import { isEmbeddedDefaults } from '../src/defaults.js'
import type { QualityRules, Metrics, CacheEntry } from '../src/types.js'
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
      const rules: QualityRules = { version: '1.0.0', rules: {} }
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

    // Not conditional on a matching rule: a tool asked to run and unable to is
    // a broken build whether or not anyone wrote a threshold for it. Making it
    // conditional would leave the original hole open for everyone who had not.
    it('fails with no rules configured at all', () => {
      const result = evaluateRules({ version: '1.0.0', rules: {} }, {
        scripts: {},
        measurementFailures: [failure('typescript', 'timed-out')],
      })

      expect(result.status).toBe('fail')
    })

    it('reports every failure, not just the first', () => {
      const result = evaluateRules({ version: '1.0.0', rules: {} }, {
        scripts: {},
        measurementFailures: [failure('eslint', 'crashed'), failure('typescript', 'tool-missing')],
      })

      expect(result.failedRules.filter((f) => f.type === 'measurement')).toHaveLength(2)
    })

    it('carries the evidence into the message so the cause is diagnosable', () => {
      const result = evaluateRules({ version: '1.0.0', rules: {} }, {
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
  })

  describe('monotonic evaluation', () => {
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

    it('skips metric comparison when baseline metric is undefined', () => {
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

      // Should pass because missing baseline metric is skipped
      expect(result.status).toBe('pass')
    })

    it('skips metric comparison when current metric is undefined', () => {
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

      // Should pass because missing current metric is skipped
      expect(result.status).toBe('pass')
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
})
