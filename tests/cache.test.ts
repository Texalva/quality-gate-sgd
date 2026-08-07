import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { execSync } from 'child_process'
import type { QualityGateCache, CacheEntry, Metrics, QualityRules } from '../src/types.js'

// Mock modules
vi.mock('fs')
vi.mock('child_process')
vi.mock('../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    projectRoot: '/test/project',
    codePathspecs: ['src/', 'tests/'],
    // Stamped onto every entry so a cached verdict cannot be served for a run made
    // by a different toolchain.
    packageManager: { manager: 'npm', reason: 'test fixture' },
    cache: {
      file: '/test/project/.quality-cache.json',
    },
  })),
}))
vi.mock('../src/rules.js', () => ({
  computeRulesHash: vi.fn(() => 'test-rules-hash'),
}))

// Import after mocks
import {
  getCurrentCommitHash,
  resolveBaselineCommit,
  getCacheKey,
  isWIPKey,
  loadCache,
  saveCache,
  getCacheEntry,
  setCacheEntry,
  createCacheEntry,
  findBaselineEntry,
  pruneOldEntries,
} from '../src/cache.js'

const mockFs = vi.mocked(fs)
const mockExecSync = vi.mocked(execSync)

/**
 * The raw output of `git cat-file commit <ref>`: header lines, a blank line,
 * then the message. Reproduced faithfully because the parse depends on that
 * shape -- the blank line is what keeps a "parent" line in the MESSAGE from
 * being read as a parent.
 */
function commitObject(parents: string[], message = 'subject line'): string {
  return [
    'tree 73f4a563c2329887a460e314b14bcde40af16e45',
    ...parents.map((hash) => `parent ${hash}`),
    'author Test <t@example.com> 1700000000 +0000',
    'committer Test <t@example.com> 1700000000 +0000',
    '',
    message,
    '',
  ].join('\n')
}

describe('cache module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getCurrentCommitHash', () => {
    it('returns trimmed commit hash', () => {
      mockExecSync.mockReturnValue('abc123def456\n')

      const result = getCurrentCommitHash()

      expect(result).toBe('abc123def456')
      expect(mockExecSync).toHaveBeenCalledWith('git rev-parse HEAD', {
        cwd: '/test/project',
        encoding: 'utf-8',
      })
    })

    it('throws error on git failure', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('git error')
      })

      expect(() => getCurrentCommitHash()).toThrow('Failed to get current commit hash')
    })
  })

  describe('resolveBaselineCommit', () => {
    it('returns the parent recorded in the commit object', () => {
      mockExecSync.mockReturnValue(commitObject(['parent123']))

      const result = resolveBaselineCommit()

      expect(result).toEqual({ kind: 'parent', hash: 'parent123' })
    })

    it('reads the commit object rather than walking revisions', () => {
      // The whole fix. `git rev-parse HEAD~1` respects the shallow graft and
      // fails in a depth-1 clone -- actions/checkout's default -- which the old
      // code read as "first commit", silently disabling every monotonic rule.
      // The stored commit object still carries the parent.
      mockExecSync.mockReturnValue(commitObject(['parent123']))

      resolveBaselineCommit()

      expect(mockExecSync).toHaveBeenCalledWith(
        'git cat-file commit HEAD',
        expect.objectContaining({ cwd: '/test/project' })
      )
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining('HEAD~1'),
        expect.anything()
      )
    })

    it('reports a genuine root commit as a root commit', () => {
      mockExecSync.mockReturnValue(commitObject([]))

      expect(resolveBaselineCommit()).toEqual({ kind: 'root-commit' })
    })

    it('reports a git failure as indeterminate, not as a root commit', () => {
      // These were the same answer before, and they call for opposite responses:
      // a root commit has no baseline, a broken git means we cannot tell.
      mockExecSync.mockImplementation(() => {
        throw new Error('fatal: not a git repository')
      })

      const result = resolveBaselineCommit()

      expect(result.kind).toBe('indeterminate')
      if (result.kind !== 'indeterminate') return
      expect(result.reason).toContain('not a git repository')
    })

    it('takes the first parent of a merge commit', () => {
      mockExecSync.mockReturnValue(commitObject(['mainline456', 'merged789']))

      expect(resolveBaselineCommit()).toEqual({ kind: 'parent', hash: 'mainline456' })
    })

    it('ignores a "parent" line inside the commit message', () => {
      // A revert or cherry-pick note routinely produces one, and a whole-output
      // scan would read it as a second parent.
      mockExecSync.mockReturnValue(
        commitObject(['realparent'], 'Revert a change\n\nparent deadbeefdeadbeefdeadbeef')
      )

      expect(resolveBaselineCommit()).toEqual({ kind: 'parent', hash: 'realparent' })
    })
  })

  describe('getCacheKey', () => {
  /**
   * Answers each git invocation by WHAT IT ASKS, not by call order.
   *
   * The order-based `mockReturnValueOnce` chains these replaced were brittle in two
   * ways that both bit. Inserting one git call into `getCacheKey` silently shifted
   * every subsequent answer -- so a test could keep passing while asserting on the
   * wrong command's output. And an unconsumed queued value leaks into the next test,
   * because `clearAllMocks` does not drain the once-queue; that is exactly how the
   * ENOBUFS case below ended up asserting on an error from a different git call.
   */
  const mockGit = (answers: {
    status?: string
    head?: string
    lsFiles?: string
    diff?: string
    others?: string
  }) => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const command = String(cmd)
      if (command.startsWith('git status')) return answers.status ?? ''
      if (command.startsWith('git rev-parse')) return answers.head ?? 'abc123\n'
      if (command.startsWith('git ls-files --others')) return answers.others ?? ''
      if (command.startsWith('git ls-files')) return answers.lsFiles ?? 'src/file.ts\n'
      if (command.startsWith('git diff')) return answers.diff ?? ''
      throw new Error(`unstubbed git command: ${command}`)
    })
  }

    it('returns commit hash when no uncommitted changes', () => {
      mockGit({ status: '', head: 'abc123\n' })

      const result = getCacheKey()

      expect(result).toEqual({
        key: 'abc123',
        isWIP: false,
      })
    })

    // #40's remaining form, and the reason this is a refusal rather than a fallback.
    // `git diff HEAD -- <pathspecs>` over paths holding no tracked files is the empty
    // string for EVERY working-tree state, so the key was sha256("") permanently and
    // the stored verdict was served for arbitrarily different code. Reproduced end to
    // end before the fix: 53 tsc errors against a ceiling of 3, `PASSED (cached)`,
    // exit 0, content hash e3b0c44 on both runs.
    //
    // Checked with `git ls-files` rather than by looking for a directory: a `src/`
    // holding only gitignored build output is the same blind spot with a directory in
    // front of it.
    it('refuses to key on a hash of nothing when the pathspecs track no files', () => {
      mockGit({ status: 'M app/file.ts\n', lsFiles: '' })

      expect(() => getCacheKey()).toThrow(/No tracked files match/)
      // Names the knob, since the fix is either moving the code or setting this.
      expect(() => getCacheKey()).toThrow(/QUALITY_CODE_PATHSPECS/)
    })

    // The control: a pathspec that DOES track files must still key normally, or the
    // refusal above is satisfiable by refusing everything.
    it('keys normally when the pathspecs track files', () => {
      mockGit({ status: 'M src/file.ts\n', lsFiles: 'src/file.ts\n', diff: 'a diff' })

      expect(getCacheKey().key).toMatch(/^wip:[0-9a-f]+:[0-9a-f]{64}$/)
    })

    it('returns wip key when uncommitted changes exist', () => {
      mockGit({ status: 'M src/file.ts\n', diff: 'diff content' })

      const result = getCacheKey()

      expect(result.isWIP).toBe(true)
      expect(result.key).toMatch(/^wip:/)
    })

    // The WIP key must name the commit the diff is a diff FROM. A content hash on
    // its own is a diff-shaped answer with no anchor, so the same uncommitted edit
    // on two different commits keyed identically -- rebase, amend, switch branch,
    // or check out an older revision with the same one-line patch, and the stored
    // verdict for a completely different tree was served. It also bounded the
    // pathspec blind spot (#40): a project whose code lies outside
    // `codePathspecs` diffs to nothing, so the hash was sha256("") for every
    // working-tree state and the key NEVER moved -- reproduced serving
    // `PASSED (cached)` for a tree with 53 tsc errors against a ceiling of 3.
    //
    // Asserted as three parts rather than `/^wip:/`, which is what the case above
    // does and what let this ship: that pattern holds just as well for the broken
    // format.
    it('anchors the wip key to HEAD, not to the diff alone', () => {
      mockGit({
        status: 'M src/file.ts\n',
        head: 'abc1234567890abc1234567890abc1234567890a\n',
        diff: 'diff content',
      })

      const [prefix, head, content] = getCacheKey().key.split(':')

      expect(prefix).toBe('wip')
      expect(head).toBe('abc1234567890abc1234567890abc1234567890a')
      expect(content).toMatch(/^[0-9a-f]{64}$/)
    })

    // Two commits, the same uncommitted diff: the keys must differ. Without this the
    // assertion above is satisfiable by a key that merely CONTAINS a commit hash
    // without it varying.
    it('gives two commits with the same diff different keys', () => {
      const keyFor = (head: string) => {
        mockGit({ status: 'M src/file.ts\n', head: `${head}\n`, diff: 'the identical diff' })
        return getCacheKey().key
      }

      expect(keyFor('1111111111111111111111111111111111111111')).not.toBe(
        keyFor('2222222222222222222222222222222222222222')
      )
    })

    // This previously asserted the OPPOSITE -- that a failed `git status`
    // yields the commit hash with isWIP: false. That is not a lenient default,
    // it is a cache poisoning: cli.ts looks the commit up, finds the verdict it
    // earned when it was clean, and exits 0 announcing PASSED without running a
    // single measurement over the uncommitted code.
    // Only ONE queued value, deliberately. `getCacheKey` throws on the first call, so
    // a second `mockReturnValueOnce` here is never consumed -- and `clearAllMocks`
    // does not drain the once-queue, so it leaks into the NEXT test and shifts every
    // call it makes by one. That is exactly what happened: the ENOBUFS case below
    // inherited a leftover value, so its "git status" call returned instead of
    // throwing and the error it asserted on came from a later git invocation. It
    // passed while testing something else.
    it('refuses to guess the tree state when git status fails', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('git status failed')
      })

      expect(() => getCacheKey()).toThrow(/whether the working tree is clean/)
    })

    // The realistic trigger, and the reason this is not a theoretical concern:
    // execSync throws ENOBUFS past its 1 MiB default rather than truncating,
    // and `git status --porcelain` grows with the number of changed files. The
    // failure was therefore likeliest on the dirtiest trees -- the ones where
    // reusing a clean commit's verdict does the most damage.
    it('does not report a clean tree when git status output overflows the buffer', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('spawnSync /bin/sh ENOBUFS'), {
          code: 'ENOBUFS',
        })
      })

      // Both halves: the ENOBUFS reason survives into the message, AND it is the
      // tree-state check that refused rather than some later git call. Asserting the
      // reason alone is what let the leaked-queue problem above hide here.
      expect(() => getCacheKey()).toThrow(/whether the working tree is clean/)
      mockExecSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('spawnSync /bin/sh ENOBUFS'), {
          code: 'ENOBUFS',
        })
      })
      expect(() => getCacheKey()).toThrow(/ENOBUFS/)
    })

    it('reads git status with a buffer far above the default', () => {
      mockGit({ status: '' })

      getCacheKey()

      expect(mockExecSync).toHaveBeenCalledWith(
        'git status --porcelain',
        expect.objectContaining({ maxBuffer: 64 * 1024 * 1024 })
      )
    })

    it('includes untracked code files in content hash', () => {
      mockGit({ status: '?? src/new.ts\n', others: 'src/new.ts\n' })

      mockFs.existsSync.mockReturnValue(true)
      mockFs.statSync.mockReturnValue({ isFile: () => true } as fs.Stats)
      mockFs.readFileSync.mockReturnValue('new file content')

      const result = getCacheKey()

      expect(result.isWIP).toBe(true)
      expect(result.key).toMatch(/^wip:/)
    })

    it('skips non-code untracked files', () => {
      mockGit({ status: '?? docs/readme.md\n', others: 'docs/readme.md\n' })

      const result = getCacheKey()

      expect(result.isWIP).toBe(true)
    })

    it('handles unreadable untracked files', () => {
      mockExecSync
        .mockReturnValueOnce('?? src/binary.ts\n') // git status --porcelain
        .mockReturnValueOnce('') // git diff HEAD
        .mockReturnValueOnce('src/binary.ts\n') // git ls-files --others

      mockFs.existsSync.mockReturnValue(true)
      mockFs.statSync.mockReturnValue({ isFile: () => true } as fs.Stats)
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Binary file')
      })

      const result = getCacheKey()

      expect(result.isWIP).toBe(true)
    })

    it('skips non-file entries in untracked list', () => {
      mockExecSync
        .mockReturnValueOnce('?? src/\n') // git status --porcelain
        .mockReturnValueOnce('') // git diff HEAD
        .mockReturnValueOnce('src/\n') // git ls-files --others

      mockFs.existsSync.mockReturnValue(true)
      mockFs.statSync.mockReturnValue({ isFile: () => false } as fs.Stats)

      const result = getCacheKey()

      expect(result.isWIP).toBe(true)
    })
  })

  describe('isWIPKey', () => {
    it('returns true for wip keys', () => {
      expect(isWIPKey('wip:abc123')).toBe(true)
    })

    it('returns false for commit hashes', () => {
      expect(isWIPKey('abc123def456')).toBe(false)
    })
  })

  describe('loadCache', () => {
    it('returns empty cache when file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)

      const result = loadCache()

      expect(result).toEqual({
        schemaVersion: 4,
        entries: {},
      })
    })

    it('returns parsed cache when file exists with valid schema', () => {
      const cacheData: QualityGateCache = {
        schemaVersion: 4,
        entries: {
          'abc123': {
            timestamp: 12345,
            rulesVersion: '1.0.0',
            rulesHash: 'hash',
            evaluation: { status: 'pass', failedRules: [] },
            metrics: {} as Metrics,
          },
        },
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cacheData))

      const result = loadCache()

      expect(result).toEqual(cacheData)
    })

    it('returns empty cache on invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('invalid json')

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = loadCache()

      expect(result).toEqual({
        schemaVersion: 4,
        entries: {},
      })
      consoleSpy.mockRestore()
    })

    // Version 1 specifically, because that is the schema whose entries were
    // scored before a failed measurement could fail the gate. A stored PASS
    // from then may be a vacuous one, so discarding it is the point of the
    // bump rather than a side effect.
    it('returns empty cache on schema version mismatch', () => {
      const oldCache = {
        schemaVersion: 1,
        entries: { abc123: { timestamp: 1, evaluation: { status: 'pass', failedRules: [] } } },
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(oldCache))

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = loadCache()

      expect(result).toEqual({
        schemaVersion: 4,
        entries: {},
      })
      consoleSpy.mockRestore()
    })

    // The IMMEDIATELY previous schema, which is the one a real upgrade actually
    // meets and the easiest to leave accepted by accident.
    //
    // The entry below is exactly the shape the 3 -> 4 bump exists for, and it was
    // reproduced against the build that changed the measurement without bumping:
    // `coverage: {}` with no `measurementFailures` and a stored PASS. A ceiling or a
    // ratchet reached that pass by silently skipping the absent coverage value --
    // `evaluateCeilings` and `evaluateMonotonic` both `continue` on undefined, and
    // only `evaluateFloors` reports a missing metric. This version treats the absent
    // report as `report-missing`, so it would NOT reach that verdict; but `cli.ts`
    // exits 0 on a cached pass without measuring anything, so retaining the entry
    // carries the defect forward past its own fix.
    it('discards the previous schema, not merely unrecognised ones', () => {
      const previousCache = {
        schemaVersion: 3,
        entries: {
          abc123: {
            timestamp: 1,
            rulesVersion: '1.0.0',
            rulesHash: 'h',
            evaluation: { status: 'pass', failedRules: [] },
            metrics: { scripts: {}, coverage: {} },
          },
        },
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(previousCache))

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = loadCache()

      expect(result.entries).toEqual({})
      expect(result.schemaVersion).toBe(4)
      consoleSpy.mockRestore()
    })

    // Version 2 as well, which is what the 2 -> 3 bump was for: a zero-denominator
    // dimension changed value, and only rule-graded measurement failures fail. Kept
    // as a separate case because "discards the one before it" and "discards every
    // older one" are different claims, and a check written as `=== 3` would satisfy
    // the first while silently accepting nothing else.
    it('discards a schema two versions old as well', () => {
      const olderCache = {
        schemaVersion: 2,
        entries: {
          abc123: {
            timestamp: 1,
            rulesVersion: '1.0.0',
            rulesHash: 'h',
            evaluation: { status: 'pass', failedRules: [] },
            metrics: { scripts: {}, coverage: { unit: { branches: 100 } } },
          },
        },
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(olderCache))

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = loadCache()

      expect(result.entries).toEqual({})
      expect(result.schemaVersion).toBe(4)
      consoleSpy.mockRestore()
    })

    it('returns empty cache when entries is not an object', () => {
      const invalidCache = {
        schemaVersion: 4,
        entries: 'not an object',
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidCache))

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = loadCache()

      expect(result).toEqual({
        schemaVersion: 4,
        entries: {},
      })
      consoleSpy.mockRestore()
    })

    it('returns empty cache when data is null', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('null')

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = loadCache()

      expect(result).toEqual({
        schemaVersion: 4,
        entries: {},
      })
      consoleSpy.mockRestore()
    })

    it('returns empty cache when entries is null', () => {
      const invalidCache = {
        schemaVersion: 4,
        entries: null,
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidCache))

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = loadCache()

      expect(result).toEqual({
        schemaVersion: 4,
        entries: {},
      })
      consoleSpy.mockRestore()
    })
  })

  describe('saveCache', () => {
    it('writes sorted cache to file', () => {
      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: {
          'zzz': { timestamp: 1, rulesVersion: '1.0.0', rulesHash: 'h', evaluation: { status: 'pass', failedRules: [] }, metrics: {} as Metrics },
          'aaa': { timestamp: 2, rulesVersion: '1.0.0', rulesHash: 'h', evaluation: { status: 'pass', failedRules: [] }, metrics: {} as Metrics },
        },
      }

      saveCache(cache)

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/test/project/.quality-cache.json',
        expect.stringContaining('"aaa"')
      )

      // Verify aaa comes before zzz in the output
      const writtenContent = (mockFs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
      const aaaIndex = writtenContent.indexOf('"aaa"')
      const zzzIndex = writtenContent.indexOf('"zzz"')
      expect(aaaIndex).toBeLessThan(zzzIndex)
    })
  })

  describe('getCacheEntry', () => {
    it('returns entry for existing key', () => {
      const entry: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: {} as Metrics,
      }
      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: { 'abc123': entry },
      }

      const result = getCacheEntry(cache, 'abc123')

      expect(result).toBe(entry)
    })

    it('returns undefined for missing key', () => {
      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: {},
      }

      const result = getCacheEntry(cache, 'missing')

      expect(result).toBeUndefined()
    })
  })

  describe('setCacheEntry', () => {
    it('sets entry in cache', () => {
      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: {},
      }
      const entry: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: {} as Metrics,
      }

      setCacheEntry(cache, 'abc123', entry)

      expect(cache.entries['abc123']).toBe(entry)
    })
  })

  describe('createCacheEntry', () => {
    it('creates entry with correct structure', () => {
      const metrics: Metrics = {
        coverage: { unit: { branches: 80, statements: 85 } },
      } as Metrics
      const rules: QualityRules = {
        version: '1.0.0',
        rules: {},
      }

      const result = createCacheEntry(metrics, rules, 'pass', [], true)

      expect(result.rulesVersion).toBe('1.0.0')
      expect(result.rulesHash).toBe('test-rules-hash')
      expect(result.evaluation.status).toBe('pass')
      expect(result.evaluation.failedRules).toEqual([])
      expect(result.metrics).toBe(metrics)
      expect(typeof result.timestamp).toBe('number')
      expect(result.monotonicEvaluated).toBe(true)
    })

    it('creates entry with failed rules', () => {
      const metrics = {} as Metrics
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      const result = createCacheEntry(metrics, rules, 'fail', ['rule1', 'rule2'], true)

      expect(result.evaluation.status).toBe('fail')
      expect(result.evaluation.failedRules).toEqual(['rule1', 'rule2'])
    })

    // The write half of the bootstrap fix. A run whose ratchets had no baseline used
    // to be withheld entirely, which deadlocked the chain: every clean run needed an
    // entry at HEAD's parent, back to the root commit, which has none -- so no entry
    // was ever written and every ratchet stayed unevaluated while the gate printed
    // PASS. It is now recorded and MARKED, so it can seed a baseline without ever
    // being served as a verdict.
    it('records that the monotonic rules did not run', () => {
      const result = createCacheEntry({} as Metrics, { version: '1.0.0', rules: {} }, 'pass', [], false)

      expect(result.monotonicEvaluated).toBe(false)
    })
  })

  describe('findBaselineEntry', () => {
    it('returns HEAD entry for WIP code', () => {
      const headEntry: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: {} as Metrics,
      }

      mockExecSync.mockReturnValue('headcommit\n')

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: { 'headcommit': headEntry },
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      const result = findBaselineEntry(cache, rules, true)

      expect(result).toBe(headEntry)
    })

    it('returns parent entry for committed code', () => {
      const parentEntry: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: {} as Metrics,
      }

      mockExecSync.mockReturnValue(commitObject(['parentcommit']))

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: { 'parentcommit': parentEntry },
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      const result = findBaselineEntry(cache, rules, false)

      expect(result).toBe(parentEntry)
    })

    // `evaluateMonotonic` skips a comparison whose baseline value is undefined,
    // so a baseline entry that recorded a failure for the ratcheted dimension
    // silently disables the ratchet -- and because an entry WAS returned, cli.ts
    // does not count the rule as unevaluated and caches the pass as fully earned.
    // Floors fail loudly on a missing metric; monotonic rules do not.
    // The counterpart to the refusal below, and the reason the bootstrap fix works:
    // an entry whose monotonic rules never ran is not servable as a VERDICT
    // (isCacheValid refuses it) but IS servable as a baseline, because "are these
    // numbers a reading of that commit?" is a different question with an honest yes.
    // Without this, marking the entry would have been pointless -- the chain would
    // still never bootstrap.
    it('accepts a baseline whose monotonic rules did not run', () => {
      const seedEntry: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: { scripts: {}, coverage: { unit: { branches: 80 } } } as unknown as Metrics,
        monotonicEvaluated: false,
      }

      mockExecSync.mockReturnValue(commitObject(['parentcommit']))

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: { parentcommit: seedEntry },
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      expect(findBaselineEntry(cache, rules, false)).toBe(seedEntry)
    })

    /**
     * A baseline from a different package manager, which the verdict-path guard in
     * `isCacheValid` does NOT cover -- `findBaselineEntry` is a separate route and was
     * left open when that guard was added.
     *
     * Numbers from two toolchains cannot be differenced. Concretely: the parent was
     * measured under npm at `typescript.errors: 10`, this run is bun at 5, and the
     * parent's true bun reading would have been 4. A `down` ratchet should fail 4 -> 5
     * and instead passes 10 -> 5 -- then the run is recorded `monotonicEvaluated: true`,
     * so the unearned pass becomes cacheable as a fully-earned verdict.
     *
     * Note this differs from `monotonicEvaluated` directly above, where the baseline IS
     * accepted. That entry is an honest reading of its commit; this one is a reading of
     * a different toolchain.
     */
    it('refuses a baseline measured by a different package manager', () => {
      const npmBaseline: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: { scripts: {}, typescript: { errors: 10 } } as unknown as Metrics,
        packageManager: 'bun',
      }

      mockExecSync.mockReturnValue(commitObject(['parentcommit']))

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: { parentcommit: npmBaseline },
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      // The mocked config runs npm; the entry says bun.
      expect(findBaselineEntry(cache, rules, false)).toBeUndefined()
    })

    it('accepts a baseline measured by the same package manager', () => {
      const npmBaseline: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: { scripts: {}, typescript: { errors: 10 } } as unknown as Metrics,
        packageManager: 'npm',
      }

      mockExecSync.mockReturnValue(commitObject(['parentcommit']))

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: { parentcommit: npmBaseline },
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      expect(findBaselineEntry(cache, rules, false)).toBe(npmBaseline)
    })

    it('refuses a baseline whose own reading recorded a measurement failure', () => {
      const incompleteBaseline: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: {
          measurementFailures: [
            {
              kind: 'unparseable-output',
              dimension: 'coverage.unit',
              message: 'the baseline run could not read its coverage report',
            },
          ],
        } as unknown as Metrics,
      }

      mockExecSync.mockReturnValue(commitObject(['parentcommit']))

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: { 'parentcommit': incompleteBaseline },
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      expect(findBaselineEntry(cache, rules, false)).toBeUndefined()
    })

    it('refuses an incomplete HEAD entry as a WIP baseline too', () => {
      const incompleteHead: CacheEntry = {
        timestamp: 12345,
        rulesVersion: '1.0.0',
        rulesHash: 'hash',
        evaluation: { status: 'pass', failedRules: [] },
        metrics: {
          measurementFailures: [
            { kind: 'crashed', dimension: 'eslint', message: 'eslint died' },
          ],
        } as unknown as Metrics,
      }

      mockExecSync.mockReturnValue('headcommit\n')

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: { 'headcommit': incompleteHead },
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      expect(findBaselineEntry(cache, rules, true)).toBeUndefined()
    })

    it('returns undefined on a root commit, which genuinely has no baseline', () => {
      mockExecSync.mockReturnValue(commitObject([]))

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: {},
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      expect(findBaselineEntry(cache, rules, false)).toBeUndefined()
    })

    it('throws when the baseline cannot be determined', () => {
      // Returning undefined here would be indistinguishable from a root commit,
      // and `evaluateMonotonic` skips every rule when it has no baseline -- so
      // the quiet answer disables the rules instead of enforcing them.
      mockExecSync.mockImplementation(() => {
        throw new Error('fatal: not a git repository')
      })

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: {},
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      expect(() => findBaselineEntry(cache, rules, false)).toThrow(
        /Refusing to treat this as a first commit/
      )
    })

    it('returns undefined when parent commit exists but not in cache', () => {
      mockExecSync.mockReturnValue(commitObject(['parentcommit']))

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: {
          'othercommit': {
            timestamp: 12345,
            rulesVersion: '1.0.0',
            rulesHash: 'hash',
            evaluation: { status: 'pass', failedRules: [] },
            metrics: {} as Metrics,
          },
        },
      }
      const rules: QualityRules = { version: '1.0.0', rules: {} }

      const result = findBaselineEntry(cache, rules, false)

      expect(result).toBeUndefined()
    })
  })

  describe('pruneOldEntries', () => {
    it('removes entries older than specified days', () => {
      const now = Date.now()
      const oldTimestamp = now - 100 * 24 * 60 * 60 * 1000 // 100 days ago
      const recentTimestamp = now - 10 * 24 * 60 * 60 * 1000 // 10 days ago

      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: {
          'old': { timestamp: oldTimestamp, rulesVersion: '1.0.0', rulesHash: 'h', evaluation: { status: 'pass', failedRules: [] }, metrics: {} as Metrics },
          'recent': { timestamp: recentTimestamp, rulesVersion: '1.0.0', rulesHash: 'h', evaluation: { status: 'pass', failedRules: [] }, metrics: {} as Metrics },
        },
      }

      const pruned = pruneOldEntries(cache, 90)

      expect(pruned).toBe(1)
      expect(cache.entries['old']).toBeUndefined()
      expect(cache.entries['recent']).toBeDefined()
    })

    it('returns 0 when no entries to prune', () => {
      const cache: QualityGateCache = {
        schemaVersion: 4,
        entries: {},
      }

      const pruned = pruneOldEntries(cache, 90)

      expect(pruned).toBe(0)
    })
  })
})
