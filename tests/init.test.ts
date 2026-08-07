/**
 * Init Module Tests
 * =================
 * What `init` WRITES, with one theme: the generated configuration has to be one
 * the gate that generated it can actually satisfy. Every case below is a shape
 * where it could not.
 *
 * `src/init.ts` is excluded from coverage instrumentation (vitest.config.ts, as
 * an interactive CLI file), so none of this shows up as a coverage number. It is
 * here because the defects it pins are not detectable from the outside: a floor
 * on a dimension the reader reports as absent looks exactly like a floor that is
 * merely strict, until the build has been red for a week.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  analyzeRepo,
  calibrateCoverageRules,
  classifyCoverageTotal,
  conductInterview,
  generateConfig,
  interpretYesNo,
  scriptWritesCoverage,
} from '../src/init.js'
import type {
  CalibrationMetrics,
  CountCalibration,
  CoverageCalibration,
  GeneratedConfig,
  GeometrySuggestion,
  InterviewAnswers,
  RepoAnalysis,
} from '../src/init.js'

const TEST_DIR = join(process.cwd(), '.test-init')

/** An istanbul `total` entry. */
const entry = (total: number, covered: number, pct: number | string) => ({
  total,
  covered,
  skipped: 0,
  pct,
})

function writePackageJson(scripts: Record<string, string>): void {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(
    join(TEST_DIR, 'package.json'),
    JSON.stringify({ name: 'subject', scripts }, null, 2)
  )
}

const SUGGESTION: GeometrySuggestion = {
  dimensions: ['coverage.unit.branches'],
  rationale: 'test',
  coverageTarget: 70,
  recommendSonarQube: false,
}

const ANSWERS: InterviewAnswers = {
  useSonarQube: false,
  coverageTarget: 70,
  testCommand: 'test:coverage',
  strictMode: false,
}

const ANALYSIS: RepoAnalysis = {
  packageJson: { scripts: { 'test:coverage': 'vitest run --coverage', test: 'vitest run' } },
  hasTypeScript: false,
  hasJest: false,
  hasVitest: true,
  hasMocha: false,
  hasEslint: false,
  hasSonarConfig: false,
  hasDocker: false,
  testCommand: 'test:coverage',
  testCommandWritesCoverage: true,
  testScriptCandidates: [{ name: 'test:coverage', writesCoverage: true }],
  coverageWritingScripts: ['test:coverage'],
  srcDir: 'src',
  estimatedSloc: 100,
  packageManager: { manager: 'npm', reason: 'test fixture' },
}

function metricsWith(coverage: CoverageCalibration): CalibrationMetrics {
  return {
    coverage,
    typescript: { kind: 'measured', errors: 0 },
    eslint: { kind: 'measured', errors: 0 },
  }
}

function generate(
  coverage: CoverageCalibration,
  overrides: { analysis?: Partial<RepoAnalysis>; answers?: Partial<InterviewAnswers> } = {}
): GeneratedConfig {
  return generateConfig(
    { ...ANALYSIS, ...overrides.analysis },
    SUGGESTION,
    { ...ANSWERS, ...overrides.answers },
    metricsWith(coverage)
  )
}

/**
 * The yes/no prompts answered YES on a bare Enter, at both call sites.
 *
 * `askQuestion` returned `answer.trim() || defaultAnswer` where `defaultAnswer` was
 * the DISPLAY string, so an empty line came back as the literal `"y/N"` -- and
 * `"y/n".startsWith('y')` is true. The `Y/n` branch was right only by accident.
 *
 * In this file rather than treated as a prompt nicety, because both prompts change
 * what the generated config CONTAINS: strict mode writes `typescript.errors: 0` and
 * `eslint.errors: 0`, so an adopter reading `[y/N]` as "the safe default is no" and
 * pressing Enter got the zero-tolerance ruleset from the command whose whole job is
 * to write one the gate can satisfy.
 *
 * Tested through `interpretYesNo` -- a pure function over the typed line -- because
 * that is the only seam where the bug is visible. A test that stubbed `askQuestion`
 * would have passed against the defect: the defect WAS what `askQuestion` returned.
 */
describe('interpretYesNo', () => {
  // The whole bug: an empty line must be "no answer", so the caller applies the
  // default it printed. Anything that resolves '' to a value here reintroduces it.
  it('reads a bare Enter as no answer at all', () => {
    expect(interpretYesNo('')).toBeUndefined()
    expect(interpretYesNo('   ')).toBeUndefined()
  })

  it('reads an explicit answer', () => {
    for (const yes of ['y', 'Y', 'yes', 'YES', ' yes ']) expect(interpretYesNo(yes)).toBe(true)
    for (const no of ['n', 'N', 'no', 'NO', ' no ']) expect(interpretYesNo(no)).toBe(false)
  })

  // The display strings themselves, which is what the old code was actually
  // interpreting. Neither may read as an answer, or the defect returns by the route it
  // arrived on. This is also why the reading is an exact match on a closed set rather
  // than a `startsWith` prefix test: `'y/N'.toLowerCase().startsWith('y')` is true, so
  // a prefix test leaves the landmine armed for the next caller who passes something
  // that is not a typed line. Caught by this case against a prefix implementation.
  it('does not read its own prompt text as an answer', () => {
    expect(interpretYesNo('y/N')).toBeUndefined()
    expect(interpretYesNo('Y/n')).toBeUndefined()
  })

  // An unrecognised line takes the default too. The default is printed on the same
  // line, so falling back to it is the answer the user can already see.
  it('takes the default for anything it cannot read', () => {
    for (const junk of ['maybe', '1', '0', 'sure', 'yep', 'nope']) {
      expect(interpretYesNo(junk)).toBeUndefined()
    }
  })
})

describe('scriptWritesCoverage', () => {
  it.each([
    ['test:coverage', 'vitest run', true],
    ['coverage', 'nyc mocha', true],
    ['test', 'jest --coverage', true],
    ['test', 'vitest run', false],
    ['test:unit', 'jest test/unit', false],
    ['ci:cov', 'vitest run', true],
  ])('%s -> %s writes coverage: %s', (name, body, expected) => {
    expect(scriptWritesCoverage(name, body)).toBe(expected)
  })
})

describe('analyzeRepo test-command ranking', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // The regression this ranking exists for: ordering the candidates by NAME put
  // `test:unit` above `test`, which is the inversion in exactly the case a
  // coverage-aware pick is supposed to fix.
  it('prefers `test` over `test:unit` when only `test` writes coverage', () => {
    writePackageJson({ test: 'jest --coverage', 'test:unit': 'jest test/unit' })

    const analysis = analyzeRepo(TEST_DIR)

    expect(analysis.testCommand).toBe('test')
    expect(analysis.testCommandWritesCoverage).toBe(true)
  })

  it('prefers `test:unit` over `test` when only `test:unit` writes coverage', () => {
    writePackageJson({ test: 'vitest run', 'test:unit': 'vitest run --coverage' })

    const analysis = analyzeRepo(TEST_DIR)

    expect(analysis.testCommand).toBe('test:unit')
    expect(analysis.testCommandWritesCoverage).toBe(true)
  })

  it('keeps the name order among scripts that all write coverage', () => {
    writePackageJson({
      test: 'jest --coverage',
      coverage: 'jest --coverage',
      'test:coverage': 'jest --coverage',
    })

    expect(analyzeRepo(TEST_DIR).testCommand).toBe('test:coverage')
  })

  it('keeps the name order when none of the candidates write coverage', () => {
    writePackageJson({ test: 'vitest run', 'test:unit': 'vitest run tests/unit' })

    const analysis = analyzeRepo(TEST_DIR)

    expect(analysis.testCommand).toBe('test')
    expect(analysis.testCommandWritesCoverage).toBe(false)
  })

  it('records coverage-writing scripts outside the candidate list', () => {
    writePackageJson({ test: 'vitest run', 'ci:coverage': 'vitest run --coverage' })

    const analysis = analyzeRepo(TEST_DIR)

    // `ci:coverage` is not a candidate -- init will not silently run a script
    // whose name it does not recognise -- but the warning has to be able to name
    // it, because it is the thing the adopter should have used.
    expect(analysis.testCommand).toBe('test')
    expect(analysis.coverageWritingScripts).toEqual(['ci:coverage'])
  })

  it('ignores non-string script values', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({ scripts: { test: null, 'test:unit': 'vitest run' } })
    )

    expect(analyzeRepo(TEST_DIR).testCommand).toBe('test:unit')
  })
})

describe('the non-coverage test-command warning', () => {
  let errors: string[]

  beforeEach(() => {
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const analysisWith = (overrides: Partial<RepoAnalysis>): RepoAnalysis => ({
    ...ANALYSIS,
    ...overrides,
  })

  // The defect: the warning sat BELOW `if (options.yes) return`, so the one
  // adopter who cannot correct the choice interactively -- and the path CI uses --
  // was the only one who never saw it.
  it('is emitted on the -y path', async () => {
    await conductInterview(
      analysisWith({
        testCommand: 'test',
        testCommandWritesCoverage: false,
        testScriptCandidates: [{ name: 'test', writesCoverage: false }],
        coverageWritingScripts: [],
      }),
      SUGGESTION,
      { yes: true, noDocker: true, verbose: false }
    )

    expect(errors.join('\n')).toContain('does not appear to write a coverage report')
  })

  it('names the better candidate it rejected', async () => {
    await conductInterview(
      analysisWith({
        testCommand: 'test',
        testCommandWritesCoverage: false,
        testScriptCandidates: [{ name: 'test', writesCoverage: false }],
        coverageWritingScripts: ['ci:coverage'],
      }),
      SUGGESTION,
      { yes: true, noDocker: true, verbose: false }
    )

    expect(errors.join('\n')).toContain('ci:coverage')
  })

  it('tells a project with no coverage script what to add', async () => {
    await conductInterview(
      analysisWith({
        testCommand: 'test',
        testCommandWritesCoverage: false,
        coverageWritingScripts: [],
      }),
      SUGGESTION,
      { yes: true, noDocker: true, verbose: false }
    )

    expect(errors.join('\n')).toContain('vitest run --coverage')
  })

  it('stays quiet when the chosen script writes coverage and was the first choice', async () => {
    await conductInterview(ANALYSIS, SUGGESTION, {
      yes: true,
      noDocker: true,
      verbose: false,
    })

    expect(errors.join('\n')).not.toContain('coverage report')
  })

  it('explains the pick when a later-named script won on coverage', async () => {
    await conductInterview(
      analysisWith({
        testCommand: 'test:unit',
        testCommandWritesCoverage: true,
        testScriptCandidates: [
          { name: 'test', writesCoverage: false },
          { name: 'test:unit', writesCoverage: true },
        ],
        coverageWritingScripts: ['test:unit'],
      }),
      SUGGESTION,
      { yes: true, noDocker: true, verbose: false }
    )

    expect(errors.join('\n')).toContain('Using `npm run test:unit`')
  })
})

describe('classifyCoverageTotal', () => {
  it('reads an ordinary report', () => {
    const result = classifyCoverageTotal(
      {
        statements: entry(100, 80, 80),
        branches: entry(50, 30, 60),
        functions: entry(10, 9, 90),
        lines: entry(100, 80, 80),
      },
      'coverage/coverage-summary.json'
    )

    expect(result).toEqual({
      kind: 'measured',
      reportPath: 'coverage/coverage-summary.json',
      branches: 60,
      statements: 80,
    })
  })

  // MEASURED shape, vitest 4 + @vitest/coverage-v8 on a branchless module:
  //   "branches": {"total":0,"covered":0,"skipped":0,"pct":100}
  // beside honest non-zero statements. The 100 is istanbul's percent(0, 0), not a
  // measurement, so it must not become a floor.
  it('reports a zero-denominator dimension as absent, not as 100', () => {
    const result = classifyCoverageTotal(
      {
        statements: entry(4, 3, 75),
        branches: entry(0, 0, 100),
        functions: entry(2, 1, 50),
        lines: entry(2, 2, 100),
      },
      'coverage/coverage-summary.json'
    )

    expect(result).toMatchObject({ kind: 'measured', branches: null, statements: 75 })
  })

  it('treats an all-zero report as measured-nothing', () => {
    const result = classifyCoverageTotal(
      {
        statements: entry(0, 0, 100),
        branches: entry(0, 0, 100),
        functions: entry(0, 0, 100),
        lines: entry(0, 0, 100),
      },
      'coverage/coverage-summary.json'
    )

    expect(result.kind).toBe('measured-nothing')
  })

  // istanbul's blankSummary emits the STRING "Unknown" in the number field. It
  // used to survive into `Math.round`, and `JSON.stringify` writes NaN as `null`
  // -- a floor of null is permanently satisfied, since `0 < null` is false.
  it('rejects a non-numeric pct over a real denominator', () => {
    const result = classifyCoverageTotal(
      {
        statements: entry(4, 3, 'Unknown'),
        branches: entry(2, 1, 50),
        functions: entry(2, 1, 50),
        lines: entry(4, 3, 75),
      },
      'coverage/coverage-summary.json'
    )

    expect(result.kind).toBe('unreadable')
    expect(result).toHaveProperty('detail', expect.stringContaining('"Unknown"'))
  })

  it('rejects a report with no numeric denominators at all', () => {
    expect(classifyCoverageTotal(undefined, 'coverage/coverage-summary.json').kind).toBe(
      'unreadable'
    )
    expect(
      classifyCoverageTotal({ statements: entry(4, 3, 75) }, 'coverage/coverage-summary.json').kind
    ).toBe('unreadable')
  })
})

describe('calibrateCoverageRules', () => {
  const measured = (branches: number | null, statements: number | null): CoverageCalibration => ({
    kind: 'measured',
    reportPath: 'coverage/coverage-summary.json',
    branches,
    statements,
  })

  it('floors a measured dimension just below its current value', () => {
    const { floors, ratchet } = calibrateCoverageRules(ANALYSIS, ANSWERS, measured(60, 80))

    expect(floors).toEqual({
      'coverage.unit.branches': 55,
      'coverage.unit.statements': 75,
    })
    expect(ratchet).toEqual(['coverage.unit.branches', 'coverage.unit.statements'])
  })

  it('caps a measured floor at the interview target', () => {
    const { floors } = calibrateCoverageRules(ANALYSIS, ANSWERS, measured(99, 99))

    expect(floors['coverage.unit.branches']).toBe(70)
    expect(floors['coverage.unit.statements']).toBe(80)
  })

  // Critical (vii): the null branch used to substitute
  // `Math.max(coverageTarget - 10, 30)` for a dimension the reader had refused,
  // which on a branchless codebase is a floor no edit can satisfy.
  it('writes no floor and no ratchet for a dimension the codebase does not have', () => {
    const { floors, ratchet, notes } = calibrateCoverageRules(
      ANALYSIS,
      ANSWERS,
      measured(null, 75)
    )

    expect(floors).not.toHaveProperty('coverage.unit.branches')
    expect(floors).toEqual({ 'coverage.unit.statements': 70 })
    expect(ratchet).toEqual(['coverage.unit.statements'])
    expect(notes.join('\n')).toContain('coverage.unit.branches')
  })

  it('writes no coverage rules when the report cannot be read', () => {
    for (const kind of ['measured-nothing', 'unreadable'] as const) {
      const { floors, ratchet } = calibrateCoverageRules(ANALYSIS, ANSWERS, {
        kind,
        detail: 'broken',
      })

      expect(floors).toEqual({})
      expect(ratchet).toEqual([])
    }
  })

  it('writes no coverage rules when the gate\'s own script writes no report', () => {
    const { floors, ratchet, notes } = calibrateCoverageRules(
      { ...ANALYSIS, packageJson: { scripts: { test: 'vitest run' } } },
      { ...ANSWERS, testCommand: 'test' },
      { kind: 'not-written', detail: 'no report' }
    )

    expect(floors).toEqual({})
    expect(ratchet).toEqual([])
    expect(notes.join('\n')).toContain('coverage-writing script')
  })

  // The legitimate no-report case: a day-one repo whose `test:coverage` script
  // exists but has no tests to run yet. Calibrating from the interview target is
  // what init has always done here and stays.
  it('falls back to the interview target when a coverage script wrote nothing yet', () => {
    const { floors, ratchet } = calibrateCoverageRules(ANALYSIS, ANSWERS, {
      kind: 'not-written',
      detail: 'no report',
    })

    expect(floors).toEqual({
      'coverage.unit.branches': 60,
      'coverage.unit.statements': 70,
    })
    expect(ratchet).toHaveLength(2)
  })
})

describe('generateConfig', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pairs the coverage floors with the script that writes the report', () => {
    const { rules } = generate({
      kind: 'measured',
      reportPath: 'coverage/coverage-summary.json',
      branches: 60,
      statements: 80,
    })

    expect(rules.rules.requiredScripts).toEqual(['test:coverage'])
    expect(Object.keys(rules.rules.floors)).toContain('coverage.unit.branches')
  })

  it('never writes a null or NaN floor', () => {
    for (const coverage of [
      { kind: 'measured', reportPath: 'r', branches: null, statements: null },
      { kind: 'measured-nothing', detail: 'x' },
      { kind: 'unreadable', detail: 'x' },
      { kind: 'not-written', detail: 'x' },
    ] as CoverageCalibration[]) {
      const { rules } = generate(coverage, { answers: { testCommand: 'test' } })
      const serialized = JSON.stringify(rules)

      expect(serialized).not.toContain('null')
      expect(serialized).not.toContain('NaN')
    }
  })

  it('emits no coverage monotonic rule when there are no coverage floors', () => {
    const { rules } = generate(
      { kind: 'measured-nothing', detail: 'nothing instrumented' },
      { answers: { testCommand: 'test' } }
    )

    expect(rules.rules.floors).toEqual({})
    expect(rules.rules.monotonic.flatMap((m) => m.metrics)).not.toContain(
      'coverage.unit.branches'
    )
  })

  it('keeps the typescript and eslint ceilings independent of coverage', () => {
    const { rules } = generateConfig(
      { ...ANALYSIS, hasTypeScript: true, hasEslint: true },
      SUGGESTION,
      ANSWERS,
      {
        coverage: { kind: 'not-written', detail: 'x' },
        typescript: { kind: 'measured', errors: 3 },
        eslint: { kind: 'measured', errors: 7 },
      }
    )

    expect(rules.rules.ceilings['typescript.errors']).toBe(3)
    expect(rules.rules.ceilings['eslint.errors']).toBe(7)
  })

  // A ceiling is a claim about the project's current state, so it needs a reading of
  // that state. The old code initialised both counts to 0 and left them there when
  // the measurement failed, writing `eslint.errors: 0` for a project whose linter
  // never ran -- and the gate, measuring successfully later, then fails against a
  // number nothing ever measured, with no edit that clears it.
  describe('a dimension that could not be measured', () => {
    const generateWith = (
      typescript: CountCalibration,
      eslint: CountCalibration,
      answers = ANSWERS
    ) =>
      generateConfig(
        { ...ANALYSIS, hasTypeScript: true, hasEslint: true },
        SUGGESTION,
        answers,
        { coverage: { kind: 'not-written', detail: 'x' }, typescript, eslint }
      )

    it('gets no ceiling, rather than a ceiling of zero', () => {
      const { rules } = generateWith(
        { kind: 'unmeasurable', detail: 'the type-check crashed' },
        { kind: 'unmeasurable', detail: 'eslint exited 2' }
      )

      expect(rules.rules.ceilings['typescript.errors']).toBeUndefined()
      expect(rules.rules.ceilings['eslint.errors']).toBeUndefined()
    })

    it('gets no ratchet either, since there is no baseline to ratchet from', () => {
      const { rules } = generateWith(
        { kind: 'unmeasurable', detail: 'crashed' },
        { kind: 'unmeasurable', detail: 'crashed' }
      )
      const ratcheted = rules.rules.monotonic.flatMap((m) => m.metrics)

      expect(ratcheted).not.toContain('typescript.errors')
      expect(ratcheted).not.toContain('eslint.errors')
    })

    it('does not stop the OTHER dimension being graded', () => {
      const { rules } = generateWith(
        { kind: 'measured', errors: 4 },
        { kind: 'unmeasurable', detail: 'eslint exited 2' }
      )

      expect(rules.rules.ceilings['typescript.errors']).toBe(4)
      expect(rules.rules.ceilings['eslint.errors']).toBeUndefined()
    })

    // strictMode's 0 is the user's stated intent, not a calibration, so it needs no
    // measurement behind it.
    it('still gets a ceiling of 0 under strictMode, which is intent not calibration', () => {
      const { rules } = generateWith(
        { kind: 'unmeasurable', detail: 'crashed' },
        { kind: 'unmeasurable', detail: 'crashed' },
        { ...ANSWERS, strictMode: true }
      )

      expect(rules.rules.ceilings['typescript.errors']).toBe(0)
      expect(rules.rules.ceilings['eslint.errors']).toBe(0)
    })

    it('says so in QUALITY.md rather than printing a number beside no ceiling', () => {
      const { explanation } = generateWith(
        { kind: 'unmeasurable', detail: 'crashed' },
        { kind: 'unmeasurable', detail: 'crashed' }
      )

      expect(explanation).toContain('not measured')
      expect(explanation).not.toContain('≤undefined')
    })
  })

  it('does not print an undefined floor into QUALITY.md', () => {
    const { explanation } = generate({
      kind: 'measured',
      reportPath: 'r',
      branches: null,
      statements: 80,
    })

    expect(explanation).not.toContain('undefined')
    expect(explanation).toContain('none in this codebase')
  })
})

// =============================================================================
// What the package SHIPS
// =============================================================================

/**
 * The pairing rule, applied to every rules.json this repo hands to an adopter.
 *
 * The gate runs `requiredScripts` and THEN reads the coverage report, so a
 * `coverage.*` rule paired with scripts that write no report is graded against
 * whatever generation of the code last wrote one. The shipped template and the
 * README example both did exactly that -- the tool shipped the config it then
 * rejects -- so the invariant is asserted here rather than left to review.
 */
interface ShippedRules {
  rules?: {
    floors?: Record<string, number>
    ceilings?: Record<string, number>
    monotonic?: Array<{ metrics?: string[] }>
    requiredScripts?: string[]
  }
}

function gatesCoverage(parsed: ShippedRules): boolean {
  const named = [
    ...Object.keys(parsed.rules?.floors ?? {}),
    ...Object.keys(parsed.rules?.ceilings ?? {}),
    ...(parsed.rules?.monotonic ?? []).flatMap((m) => m.metrics ?? []),
  ]
  return named.some((dimension) => dimension.startsWith('coverage.'))
}

function assertCoveragePairing(label: string, parsed: ShippedRules): void {
  if (!gatesCoverage(parsed)) return

  const scripts = parsed.rules?.requiredScripts ?? []
  expect(
    scripts.some((name) => scriptWritesCoverage(name, '')),
    `${label} gates a coverage.* dimension but none of its requiredScripts ` +
      `(${scripts.join(', ') || 'none'}) looks like it writes a coverage report`
  ).toBe(true)
}

describe('shipped configurations', () => {
  it('templates/rules.template.json pairs coverage floors with a coverage script', () => {
    const parsed = JSON.parse(
      readFileSync(join(process.cwd(), 'templates/rules.template.json'), 'utf-8')
    ) as ShippedRules

    assertCoveragePairing('templates/rules.template.json', parsed)
  })

  it("this repo's own rules.json pairs coverage floors with a coverage script", () => {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), 'rules.json'), 'utf-8')) as ShippedRules

    assertCoveragePairing('rules.json', parsed)
  })

  it('every complete rules.json in README.md pairs coverage floors with a coverage script', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf-8')
    const fences = readme.match(/```json\n([\s\S]*?)```/g) ?? []

    const complete = fences
      .map((fence) => fence.replace(/```json\n/, '').replace(/```$/, ''))
      .map((body) => {
        try {
          return JSON.parse(body) as ShippedRules
        } catch {
          // Fragments like `"floors": { ... }` are not standalone JSON. They
          // cannot express a pairing, so skipping them loses nothing.
          return null
        }
      })
      .filter((parsed): parsed is ShippedRules => parsed !== null && parsed.rules !== undefined)

    expect(complete.length).toBeGreaterThan(0)
    complete.forEach((parsed, index) => assertCoveragePairing(`README example ${index + 1}`, parsed))
  })

  it('generated configs satisfy the same pairing rule', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const cases: CoverageCalibration[] = [
        { kind: 'measured', reportPath: 'r', branches: 60, statements: 80 },
        { kind: 'measured', reportPath: 'r', branches: null, statements: 80 },
        { kind: 'not-written', detail: 'x' },
        { kind: 'measured-nothing', detail: 'x' },
      ]
      for (const coverage of cases) {
        assertCoveragePairing('generated rules.json', generate(coverage).rules)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })
})
