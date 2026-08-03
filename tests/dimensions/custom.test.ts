import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import type { SpawnSyncReturns } from 'child_process'
import {
  loadCustomDimensions,
  extractCustomMetric,
  registerCustomDimensions,
  extractAllCustomMetrics,
  type CustomDimensionConfig,
} from '../../src/dimensions/custom.js'

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  }
})

// Mock child_process
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}))

/**
 * A finished extractor run. Defaults to the shape of a clean one, so each test
 * states only the field it is about.
 */
async function mockExtractor(overrides: Partial<SpawnSyncReturns<string>> = {}) {
  const { spawnSync } = await import('child_process')
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>)
}

/** The numeric reading, or a test failure naming why there wasn't one. */
function readingOf(result: ReturnType<typeof extractCustomMetric>): number {
  if (!result.ok) {
    throw new Error(`expected a reading, got ${result.error.kind}: ${result.error.message}`)
  }
  return result.value
}

// Mock registry - ensure it doesn't conflict with our tests
vi.mock('../../src/dimensions/registry.js', () => ({
  registerDimension: vi.fn(),
  getValidPaths: vi.fn(() => []),
}))

describe('loadCustomDimensions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when no config file exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = await loadCustomDimensions()

    expect(result).toEqual([])
  })

  it('tries multiple config file names in order', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    await loadCustomDimensions('/test/path')

    // Should check all config file names
    expect(fs.existsSync).toHaveBeenCalledWith('/test/path/quality-gate.config.ts')
    expect(fs.existsSync).toHaveBeenCalledWith('/test/path/quality-gate.config.js')
    expect(fs.existsSync).toHaveBeenCalledWith('/test/path/quality-gate.config.mjs')
    expect(fs.existsSync).toHaveBeenCalledWith('/test/path/quality-gate.config.cjs')
  })

  it('refuses to treat an unreadable config as an empty one', async () => {
    // Returning [] here deleted every ceiling that referred to a custom
    // dimension, and the gate then passed having enforced fewer rules than it
    // was configured with.
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Read error')
    })

    await expect(loadCustomDimensions('/test/path')).rejects.toThrow(/could not be read.*Read error/)
  })

  it('parses TS config with simple JSON array export', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    // Simple literal JSON array in the file
    const configContent = `
export const customDimensions = [
  {"path": "custom.test", "displayName": "Test", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}}
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    const result = await loadCustomDimensions('/test/path')

    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('custom.test')
  })

  it('refuses a TS config whose dimensions it can only half-read', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    // Config with JS expressions that can't be parsed as JSON
    const configContent = `
export const customDimensions = [
  { path: \`custom.test\`, displayName: getDisplayName(), direction: 'lower-better' }
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    await expect(loadCustomDimensions('/test/path')).rejects.toThrow(/Install tsx or ts-node/)
  })

  it('refuses a TS config that mentions dimensions it cannot extract', async () => {
    // The extraction regex is a heuristic -- it stops at the first `]`, so a
    // nested array defeats it. Failing to match is not evidence of absence.
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })
    vi.mocked(fs.readFileSync).mockReturnValue(`
export const customDimensions = buildDimensions()
`)

    await expect(loadCustomDimensions('/test/path')).rejects.toThrow(/could not.*extract/)
  })

  it('returns empty when no customDimensions export found in TS file', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    const configContent = `
export const otherConfig = { foo: 'bar' };
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    const result = await loadCustomDimensions('/test/path')

    expect(result).toEqual([])
  })

  it('rejects the config rather than silently dropping an invalid dimension', async () => {
    // Skipping the bad entry was the same hole as an unloadable file, one
    // dimension at a time: the dropped dimension's ceiling stopped being
    // enforced and nothing said so.
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    const configContent = `
export const customDimensions = [
  {"path": "custom.valid", "displayName": "Valid", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}},
  {"path": "invalid.noprefix", "displayName": "Invalid", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}}
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    await expect(loadCustomDimensions('/test/path')).rejects.toThrow(
      /index 1 has path 'invalid.noprefix'/
    )
  })

  it('names the index of a dimension it cannot read', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })
    vi.mocked(fs.readFileSync).mockReturnValue(`
export const customDimensions = [
  {"path": "custom.valid", "displayName": "Valid", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}},
  {"path": "custom.missing", "displayName": "No extractor"}
];
`)

    await expect(loadCustomDimensions('/test/path')).rejects.toThrow(
      /index 1 is not a usable definition/
    )
  })

  it('rejects two dimensions claiming the same path', async () => {
    // Only one would ever be measured, and which one is an accident of ordering.
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })
    vi.mocked(fs.readFileSync).mockReturnValue(`
export const customDimensions = [
  {"path": "custom.dupe", "displayName": "First", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}},
  {"path": "custom.dupe", "displayName": "Second", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 2"}}
];
`)

    await expect(loadCustomDimensions('/test/path')).rejects.toThrow(/repeats the path 'custom.dupe'/)
  })

  it('rejects a customDimensions export that is not an array', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })
    vi.mocked(fs.readFileSync).mockReturnValue(`
export const customDimensions = ["not", "dimensions"];
`)

    // Parses as JSON, so it reaches validation as two unusable entries.
    await expect(loadCustomDimensions('/test/path')).rejects.toThrow(
      /index 0 is not a usable definition/
    )
  })

  it('sets default values for continuity and defaultWeight', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    const configContent = `
export const customDimensions = [
  {"path": "custom.test", "displayName": "Test", "direction": "higher-better", "extractor": {"type": "script", "command": "echo 1"}}
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    const result = await loadCustomDimensions('/test/path')

    expect(result[0].continuity).toBe('discrete')
    expect(result[0].defaultWeight).toBe(0.01)
  })

  it('preserves custom continuity and defaultWeight values', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    const configContent = `
export const customDimensions = [
  {"path": "custom.test", "displayName": "Test", "direction": "lower-better", "continuity": "smooth", "defaultWeight": 0.5, "extractor": {"type": "script", "command": "echo 1"}}
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    const result = await loadCustomDimensions('/test/path')

    expect(result[0].continuity).toBe('smooth')
    expect(result[0].defaultWeight).toBe(0.5)
  })

  // Note: Testing .js/.mjs/.cjs config files requires actual file system access
  // and dynamic imports, which are challenging to mock in Vitest. The TypeScript
  // path is tested via the readFileSync fallback which covers the main logic.
})

describe('extractCustomMetric', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const baseConfig: CustomDimensionConfig = {
    path: 'custom.test',
    displayName: 'Test',
    direction: 'lower-better',
    extractor: {
      type: 'script',
      command: 'echo 42',
      parseOutput: 'number',
    },
  }

  describe('successful readings', () => {
    it('extracts number from simple output', async () => {
      await mockExtractor({ stdout: '42\n' })

      expect(readingOf(extractCustomMetric(baseConfig))).toBe(42)
    })

    it('extracts first number from text output', async () => {
      await mockExtractor({ stdout: 'Found 15 issues in 3 files\n' })

      expect(readingOf(extractCustomMetric(baseConfig))).toBe(15)
    })

    it('handles decimal numbers', async () => {
      await mockExtractor({ stdout: 'Average: 3.14159\n' })

      expect(readingOf(extractCustomMetric(baseConfig))).toBe(3.14159)
    })

    it('handles negative numbers', async () => {
      await mockExtractor({ stdout: 'Delta: -5.5\n' })

      expect(readingOf(extractCustomMetric(baseConfig))).toBe(-5.5)
    })

    it('reads a genuine zero as a zero', async () => {
      // The whole point of the failure channel is that this stays distinct from
      // every broken run below, all of which used to produce exactly this.
      await mockExtractor({ stdout: '0\n' })

      expect(readingOf(extractCustomMetric(baseConfig))).toBe(0)
    })

    it('extracts value from JSON output with jsonPath', async () => {
      await mockExtractor({ stdout: JSON.stringify({ summary: { total: 25, average: 5.5 } }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.summary.total',
        },
      }

      expect(readingOf(extractCustomMetric(config))).toBe(25)
    })

    it('extracts value using jsonPath without $ prefix', async () => {
      await mockExtractor({ stdout: JSON.stringify({ count: 100 }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: 'count',
        },
      }

      expect(readingOf(extractCustomMetric(config))).toBe(100)
    })

    it('extracts value from JSON array using index', async () => {
      await mockExtractor({ stdout: JSON.stringify({ items: [10, 20, 30] }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.items[1]',
        },
      }

      expect(readingOf(extractCustomMetric(config))).toBe(20)
    })

    it('returns numeric JSON value when no jsonPath', async () => {
      await mockExtractor({ stdout: '42' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: { type: 'script', command: 'echo 42', parseOutput: 'json' },
      }

      expect(readingOf(extractCustomMetric(config))).toBe(42)
    })

    it('parses a fully-numeric string value from jsonPath', async () => {
      await mockExtractor({ stdout: JSON.stringify({ value: '123.5' }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.value',
        },
      }

      expect(readingOf(extractCustomMetric(config))).toBe(123.5)
    })

    it('extracts value using regex with capture group', async () => {
      await mockExtractor({ stdout: 'Complexity score: 7.5 (medium)\n' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'plato report',
          parseOutput: 'regex',
          regex: 'score:\\s*(\\d+\\.?\\d*)',
        },
      }

      expect(readingOf(extractCustomMetric(config))).toBe(7.5)
    })
  })

  describe('the run itself failed', () => {
    it('reports a command that does not exist as tool-missing, not as zero', async () => {
      const enoent = Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' })
      await mockExtractor({ status: null, error: enoent })

      const result = extractCustomMetric(baseConfig)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('tool-missing')
    })

    it('reports a non-zero exit as crashed, not as zero', async () => {
      // The defect: `lower-better` dimensions are best at zero and gated only by
      // ceilings, so the harder the extractor failed the better the score.
      await mockExtractor({ status: 1, stderr: 'command not found: complexity-tool\n' })

      const result = extractCustomMetric(baseConfig)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('crashed')
      expect(result.error.evidence.exitCode).toBe(1)
    })

    it('accepts a non-zero exit the extractor declared as success', async () => {
      // `grep -c` exits 1 when the count is zero. Declaring that beats the
      // obvious `|| true` workaround, which would hide real errors too.
      await mockExtractor({ status: 1, stdout: '0\n' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'grep -c TODO src/index.ts',
          successExitCodes: [0, 1],
        },
      }

      expect(readingOf(extractCustomMetric(config))).toBe(0)
    })

    it('still rejects an exit code outside the declared set', async () => {
      await mockExtractor({ status: 2, stderr: 'grep: src: Is a directory\n' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'grep -c TODO src',
          successExitCodes: [0, 1],
        },
      }

      const result = extractCustomMetric(config)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('crashed')
    })

    it('reports a killed extractor as a failure, with the signal as evidence', async () => {
      // Whether a kill is attributed to the timeout or to a crash depends on
      // elapsed-vs-budget, which this call site computes internally and so
      // cannot drive; that attribution is tested against classifyProcessOutput
      // directly, where elapsed is an argument. What matters here is that a
      // killed extractor cannot come back as a reading.
      await mockExtractor({ status: null, signal: 'SIGTERM' })

      const result = extractCustomMetric(baseConfig)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.evidence.signal).toBe('SIGTERM')
    })

    it('reports truncated output as truncated rather than parsing the fragment', async () => {
      const enobufs = Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' })
      await mockExtractor({ status: null, stdout: '123', error: enobufs })

      const result = extractCustomMetric(baseConfig)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('output-truncated')
    })

    it('names the dimension that went unmeasured', async () => {
      await mockExtractor({ status: 1 })

      const config: CustomDimensionConfig = { ...baseConfig, path: 'custom.anyCount' }
      const result = extractCustomMetric(config)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.dimension).toBe('custom.anyCount')
    })
  })

  describe('the run succeeded but its output cannot be read', () => {
    async function expectUnparseable(config: CustomDimensionConfig) {
      const result = extractCustomMetric(config)

      expect(result.ok).toBe(false)
      if (result.ok) return undefined
      expect(result.error.kind).toBe('unparseable-output')
      return result.error.message
    }

    it('rejects output containing no number at all', async () => {
      await mockExtractor({ stdout: 'No numbers here\n' })

      expect(await expectUnparseable(baseConfig)).toContain('found none')
    })

    it('rejects empty output', async () => {
      await mockExtractor({ stdout: '' })

      expect(await expectUnparseable(baseConfig)).toContain('empty output')
    })

    it('rejects invalid JSON', async () => {
      await mockExtractor({ stdout: 'not valid json' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat broken.json',
          parseOutput: 'json',
          jsonPath: '$.value',
        },
      }

      expect(await expectUnparseable(config)).toContain('not valid JSON')
    })

    it('rejects a JSON document that is not a number when no jsonPath is set', async () => {
      await mockExtractor({ stdout: '{"key": "value"}' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: { type: 'script', command: 'echo json', parseOutput: 'json' },
      }

      await expectUnparseable(config)
    })

    it('rejects a jsonPath that matches nothing', async () => {
      await mockExtractor({ stdout: JSON.stringify({ summary: { other: 1 } }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.summary.total',
        },
      }

      expect(await expectUnparseable(config)).toContain('matched nothing')
    })

    it('rejects a jsonPath traversing through null', async () => {
      await mockExtractor({ stdout: JSON.stringify({ summary: null }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.summary.total',
        },
      }

      await expectUnparseable(config)
    })

    it('rejects a jsonPath traversing through a primitive', async () => {
      await mockExtractor({ stdout: JSON.stringify({ summary: 42 }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.summary.total',
        },
      }

      await expectUnparseable(config)
    })

    it('rejects array indexing applied to a non-array', async () => {
      await mockExtractor({ stdout: JSON.stringify({ items: 'not-an-array' }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.items[0]',
        },
      }

      await expectUnparseable(config)
    })

    it('rejects a non-numeric string value from jsonPath', async () => {
      await mockExtractor({ stdout: JSON.stringify({ value: 'not-a-number' }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.value',
        },
      }

      expect(await expectUnparseable(config)).toContain('not a number')
    })

    it('rejects a string that merely STARTS with a number', async () => {
      // parseFloat read 42 out of this and `|| 0` covered the rest. A value that
      // is partly prose is a sign the jsonPath points somewhere unintended, so
      // guessing at it is worse than reporting it.
      await mockExtractor({ stdout: JSON.stringify({ value: '42 issues remaining' }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.value',
        },
      }

      await expectUnparseable(config)
    })

    it('rejects a boolean value from jsonPath', async () => {
      // Number(false) is 0, so this reached a ceiling as a perfect score.
      await mockExtractor({ stdout: JSON.stringify({ value: false }) })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'cat report.json',
          parseOutput: 'json',
          jsonPath: '$.value',
        },
      }

      expect(await expectUnparseable(config)).toContain('boolean')
    })

    it('rejects an unknown parseOutput mode', async () => {
      // Reachable in practice: configs are loaded from a file and the mode is
      // not validated, so a typo silently scored 0 on every commit.
      await mockExtractor({ stdout: '42\n' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'echo 42',
          parseOutput: 'nubmer' as 'number',
        },
      }

      expect(await expectUnparseable(config)).toContain('unknown parseOutput mode')
    })

    it('rejects a regex mode with no pattern configured', async () => {
      await mockExtractor({ stdout: '42\n' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: { type: 'script', command: 'test', parseOutput: 'regex' },
      }

      expect(await expectUnparseable(config)).toContain('no regex pattern is configured')
    })

    it('rejects a regex pattern that does not compile', async () => {
      await mockExtractor({ stdout: '42\n' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'test',
          parseOutput: 'regex',
          regex: '[invalid regex(',
        },
      }

      expect(await expectUnparseable(config)).toContain('does not compile')
    })

    it('rejects a regex that matches nothing', async () => {
      await mockExtractor({ stdout: 'No match here\n' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'test',
          parseOutput: 'regex',
          regex: 'score:\\s*(\\d+)',
        },
      }

      expect(await expectUnparseable(config)).toContain('matched nothing')
    })

    it('rejects a regex with no capture group', async () => {
      await mockExtractor({ stdout: 'score: 7\n' })

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: {
          type: 'script',
          command: 'test',
          parseOutput: 'regex',
          regex: 'score:\\s*\\d+',
        },
      }

      expect(await expectUnparseable(config)).toContain('no capture group')
    })
  })

  describe('how the command is invoked', () => {
    it('uses custom timeout', async () => {
      await mockExtractor({ stdout: '42\n' })
      const { spawnSync } = await import('child_process')

      const config: CustomDimensionConfig = {
        ...baseConfig,
        extractor: { type: 'script', command: 'slow-command', timeout: 60000 },
      }

      extractCustomMetric(config)

      expect(spawnSync).toHaveBeenCalledWith(
        expect.stringContaining('slow-command'),
        expect.objectContaining({ timeout: 60000 })
      )
    })

    it('gives the extractor far more than execSync default 1 MiB', async () => {
      // execSync threw ENOBUFS past 1 MiB and the catch scored it 0, so a
      // verbose extractor failed on output volume alone.
      await mockExtractor({ stdout: '42\n' })
      const { spawnSync } = await import('child_process')

      extractCustomMetric(baseConfig)

      expect(spawnSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ maxBuffer: 64 * 1024 * 1024 })
      )
    })

    it('runs under a shell with pipefail so a failing pipeline stage counts', async () => {
      // `sh -c 'grep pattern missing | wc -l'` exits 0 and prints 0, because wc
      // succeeded at counting nothing -- so a search that never ran becomes a
      // perfect lower-better score. Only the real end-to-end control can prove
      // the shell honours this; what is checkable here is that we ask it to.
      await mockExtractor({ stdout: '42\n' })
      const { spawnSync } = await import('child_process')

      extractCustomMetric(baseConfig)

      expect(spawnSync).toHaveBeenCalledWith(
        'set -o pipefail; echo 42',
        expect.objectContaining({ shell: 'bash' })
      )
    })
  })
})

describe('registerCustomDimensions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when no config file exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const configs = await registerCustomDimensions('/nonexistent')

    expect(configs).toEqual([])
  })

  it('registers dimensions from config file', async () => {
    const { registerDimension } = await import('../../src/dimensions/registry.js')

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    const configContent = `
export const customDimensions = [
  {"path": "custom.metric1", "displayName": "Metric 1", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}},
  {"path": "custom.metric2", "displayName": "Metric 2", "description": "Custom description", "direction": "higher-better", "extractor": {"type": "script", "command": "echo 2"}}
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    const configs = await registerCustomDimensions('/test/path')

    expect(configs).toHaveLength(2)
    expect(registerDimension).toHaveBeenCalledTimes(2)
    expect(registerDimension).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'custom.metric1',
        displayName: 'Metric 1',
        category: 'custom',
        direction: 'lower-better',
      })
    )
    expect(registerDimension).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'custom.metric2',
        displayName: 'Metric 2',
        description: 'Custom description',
        category: 'custom',
        direction: 'higher-better',
      })
    )
  })

  it('uses default description when not provided', async () => {
    const { registerDimension } = await import('../../src/dimensions/registry.js')

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    const configContent = `
export const customDimensions = [
  {"path": "custom.test", "displayName": "Test Metric", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}}
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    await registerCustomDimensions('/test/path')

    expect(registerDimension).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Custom metric: Test Metric',
      })
    )
  })

  it('handles registration errors gracefully', async () => {
    const { registerDimension } = await import('../../src/dimensions/registry.js')
    vi.mocked(registerDimension).mockImplementation(() => {
      throw new Error('Registration failed')
    })

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    const configContent = `
export const customDimensions = [
  {"path": "custom.test", "displayName": "Test", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}}
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const configs = await registerCustomDimensions('/test/path')

    // Still returns configs even if registration fails
    expect(configs).toHaveLength(1)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to register custom dimension'),
      expect.any(Error)
    )
    consoleSpy.mockRestore()
  })

  it('sets default continuity and weight in registered dimension', async () => {
    const { registerDimension } = await import('../../src/dimensions/registry.js')

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).endsWith('quality-gate.config.ts')
    })

    const configContent = `
export const customDimensions = [
  {"path": "custom.test", "displayName": "Test", "direction": "lower-better", "extractor": {"type": "script", "command": "echo 1"}}
];
`
    vi.mocked(fs.readFileSync).mockReturnValue(configContent)

    await registerCustomDimensions('/test/path')

    expect(registerDimension).toHaveBeenCalledWith(
      expect.objectContaining({
        continuity: 'discrete',
        defaultWeight: 0.01,
        unit: 'count',
      })
    )
  })
})

describe('extractAllCustomMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const CONFIGS: CustomDimensionConfig[] = [
    {
      path: 'custom.metricA',
      displayName: 'Metric A',
      direction: 'lower-better',
      extractor: { type: 'script', command: 'echo 10' },
    },
    {
      path: 'custom.metricB',
      displayName: 'Metric B',
      direction: 'higher-better',
      extractor: { type: 'script', command: 'echo 20' },
    },
  ]

  it('extracts all metrics from configs', async () => {
    const { spawnSync } = await import('child_process')
    const finished = (stdout: string) =>
      ({ pid: 1, output: [], stdout, stderr: '', status: 0, signal: null }) as SpawnSyncReturns<string>

    vi.mocked(spawnSync)
      .mockReturnValueOnce(finished('10\n'))
      .mockReturnValueOnce(finished('20\n'))

    const result = extractAllCustomMetrics(CONFIGS)

    expect(result.metrics).toEqual({ metricA: 10, metricB: 20 })
    expect(result.failures).toEqual([])
  })

  it('keeps measuring after one extractor fails, and omits the failed dimension', async () => {
    const { spawnSync } = await import('child_process')
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        pid: 1, output: [], stdout: '', stderr: 'boom\n', status: 3, signal: null,
      } as SpawnSyncReturns<string>)
      .mockReturnValueOnce({
        pid: 2, output: [], stdout: '20\n', stderr: '', status: 0, signal: null,
      } as SpawnSyncReturns<string>)

    const result = extractAllCustomMetrics(CONFIGS)

    // Absent, NOT zero. Zero would satisfy a `custom.metricA` ceiling.
    expect(result.metrics).toEqual({ metricB: 20 })
    expect('metricA' in result.metrics).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({ kind: 'crashed', dimension: 'custom.metricA' })
  })

  it('returns empty object for empty configs', () => {
    const result = extractAllCustomMetrics([])

    expect(result.metrics).toEqual({})
    expect(result.failures).toEqual([])
  })
})
