/**
 * Cache Module
 * Handles reading/writing the quality gate cache with schema versioning
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import type {
  QualityGateCache,
  CacheEntry,
  Metrics,
  QualityRules,
} from './types.js';
import { computeRulesHash } from './rules.js';
import { getConfig } from './config.js';

/**
 * 4 since an absent coverage summary became a measurement failure. Before that, 3
 * since zero-denominator dimensions changed value and only rule-graded measurement
 * failures fail. Each one moves the definition of a pass, and `cli.ts` exits 0 on a
 * cached pass without measuring anything, so an older entry can assert a verdict
 * this version would not reach -- a version-3 entry holding `coverage: {}` and a
 * PASS that a ratchet reached by skipping the absent value was accepted by
 * `isCacheValid` verbatim. `loadCache` discards a mismatched schema, which is the
 * point: the fix must not be undone by a cache written before it. Full reasoning on
 * QualityGateCache in types.ts.
 */
const CURRENT_SCHEMA_VERSION = 4;

/**
 * Buffer ceiling for the git reads whose output scales with the repository.
 *
 * `execSync` THROWS on overflow rather than truncating -- verified: ENOBUFS,
 * with a partial and unpredictable amount of output attached to the error -- and
 * its default ceiling is 1 MiB.
 * That matters here because the overflow is correlated with the very thing
 * being measured: the more files a tree has modified or untracked, the longer
 * `git status --porcelain` gets, so the dirtiest trees were the likeliest to
 * throw. Combined with the catch that used to answer "clean", the failure mode
 * got MORE likely exactly when being wrong cost the most.
 *
 * Not applied to `git rev-parse`, whose output is a single 41-byte hash.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// =============================================================================
// Git Utilities
// =============================================================================

export function getCurrentCommitHash(): string {
  const config = getConfig();
  try {
    return execSync('git rev-parse HEAD', {
      cwd: config.projectRoot,
      encoding: 'utf-8',
    }).trim();
  } catch {
    throw new Error('Failed to get current commit hash');
  }
}

/**
 * Where the previous commit's reading should come from, or why it cannot be said.
 *
 * The three cases used to be one. `git rev-parse HEAD~1` failing was read as
 * "first commit has no parent", which is only one of the reasons it fails.
 */
export type BaselineCommit =
  /** HEAD has a parent, and this is it. */
  | { readonly kind: 'parent'; readonly hash: string }
  /** HEAD genuinely has no parent, so there is no baseline to compare against. */
  | { readonly kind: 'root-commit' }
  /** Git could not be asked. Distinct from "there is nothing to find". */
  | { readonly kind: 'indeterminate'; readonly reason: string };

/**
 * The parent of HEAD, read out of the commit object itself.
 *
 * `git rev-parse HEAD~1` is the obvious way and it is wrong here, because it
 * respects the shallow graft: in a `--depth 1` clone -- what
 * `actions/checkout` produces by DEFAULT -- it exits 128 "unknown revision".
 * The old catch turned that into "first commit", `findBaselineEntry` returned
 * nothing, and `evaluateMonotonic` returns an empty list when it has no
 * baseline. Every monotonic rule therefore evaporated in CI while passing
 * locally, which is the exact inversion of where they matter.
 *
 * Measured on git 2.51 in a depth-1 clone, since the alternatives look
 * equivalent and are not:
 *
 *   git rev-parse HEAD~1     -> exit 128, fatal: unknown revision
 *   git rev-parse HEAD^@     -> EMPTY, exit 0   (indistinguishable from a root
 *                                                commit -- the dangerous one)
 *   git log -1 --format=%P   -> EMPTY, exit 0   (same trap)
 *   git cat-file commit HEAD -> `parent <sha>` present and correct
 *
 * The commit object is the raw stored object; a shallow clone hides the parent
 * from revision walks without rewriting it. So the hash is recoverable, and a
 * cache entry keyed by it is still there to be found.
 */
export function resolveBaselineCommit(): BaselineCommit {
  const config = getConfig();
  let commitObject: string;

  try {
    commitObject = execSync('git cat-file commit HEAD', {
      cwd: config.projectRoot,
      encoding: 'utf-8',
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (error) {
    return {
      kind: 'indeterminate',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // Header only. The message follows the first blank line and may itself contain
  // a line beginning "parent " -- a revert or a cherry-pick note routinely
  // does -- which a whole-output scan would read as a second parent.
  const header = commitObject.split('\n\n', 1)[0];
  const parents = header
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length).trim());

  if (parents.length === 0) {
    return { kind: 'root-commit' };
  }

  // First parent for a merge: the baseline is the branch being merged into,
  // matching what HEAD~1 meant.
  return { kind: 'parent', hash: parents[0] };
}

// =============================================================================
// WIP Content Hashing
// =============================================================================

/**
 * Check if there are any uncommitted changes (staged or unstaged).
 *
 * Throws rather than guessing. This used to answer `false` on any git failure,
 * annotated "safe default", and it was the opposite of safe: `false` sends
 * getCacheKey() down the commit-hash branch, so uncommitted code inherits
 * whatever verdict that commit last earned -- and cli.ts exits 0 on a cached
 * pass without measuring anything at all. A quality gate that reports PASS for
 * code it never looked at is the failure this tool exists to prevent.
 *
 * There is also nothing for the swallow to protect. When git is genuinely
 * unavailable, the very next call (`getCurrentCommitHash`) throws anyway; the
 * catch only changed which error surfaced, and only after silently committing
 * to the dangerous branch.
 */
function hasUncommittedChanges(): boolean {
  const config = getConfig();
  try {
    const output = execSync('git status --porcelain', {
      cwd: config.projectRoot,
      encoding: 'utf-8',
      maxBuffer: GIT_MAX_BUFFER,
    });
    return output.trim().length > 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to determine whether the working tree is clean: ${reason}. ` +
        'Refusing to assume it is -- that would cache this run against the wrong commit.'
    );
  }
}

/**
 * Build git pathspec from config
 */
function getCodePathspec(): string {
  const config = getConfig();
  return '-- ' + config.codePathspecs.join(' ');
}

/**
 * Check if a file path matches code patterns (affects quality)
 */
function isCodeFile(filePath: string): boolean {
  const config = getConfig();
  const codeExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  // Check if file is in any of the configured code directories
  const isInCodeDir = config.codePathspecs.some((pathspec) =>
    filePath.startsWith(pathspec.replace(/\/$/, '') + '/')
  );
  const hasCodeExt = codeExtensions.some((ext) => filePath.endsWith(ext));

  // Also include specific config files that affect quality metrics
  const isQualityConfig = [
    'vitest.config.ts',
    'jest.config.ts',
    'sonar-project.properties',
    'rules.json',
  ].includes(filePath);

  return (isInCodeDir && hasCodeExt) || isQualityConfig;
}

/**
 * Compute a stable content hash from git diff + untracked files
 * Only includes source code files that affect quality metrics.
 * Changes to docs, config, etc. won't invalidate the cache.
 */
function computeContentHash(): string {
  const config = getConfig();
  const codePathspec = getCodePathspec();

  // Get diff of code file changes only (staged + unstaged vs HEAD)
  const trackedDiff = execSync(`git diff HEAD ${codePathspec}`, {
    cwd: config.projectRoot,
    encoding: 'utf-8',
    maxBuffer: GIT_MAX_BUFFER,
  });

  // Get list of untracked files (not in .gitignore)
  const untrackedList = execSync('git ls-files --others --exclude-standard', {
    cwd: config.projectRoot,
    encoding: 'utf-8',
    maxBuffer: GIT_MAX_BUFFER,
  }).trim();

  // Build content for untracked CODE files only
  let untrackedContent = '';
  if (untrackedList) {
    const files = untrackedList
      .split('\n')
      .filter((f) => f && isCodeFile(f))
      .sort();
    for (const file of files) {
      const fullPath = path.join(config.projectRoot, file);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        untrackedContent += `\n@@@ untracked: ${file} @@@\n`;
        try {
          untrackedContent += fs.readFileSync(fullPath, 'utf-8');
        } catch {
          // Skip files we can't read (binary, permissions, etc.)
          untrackedContent += '[unreadable]';
        }
      }
    }
  }

  // Combine and hash
  const combined = trackedDiff + untrackedContent;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Get the cache key for the current state
 * Returns commit hash for clean working tree, or wip:contentHash for uncommitted changes
 */
export function getCacheKey(): { key: string; isWIP: boolean } {
  if (!hasUncommittedChanges()) {
    return {
      key: getCurrentCommitHash(),
      isWIP: false,
    };
  }

  const contentHash = computeContentHash();
  return {
    key: `wip:${contentHash}`,
    isWIP: true,
  };
}

/**
 * Check if a cache key is a WIP content hash (vs a commit hash)
 */
export function isWIPKey(key: string): boolean {
  return key.startsWith('wip:');
}

// =============================================================================
// Cache I/O
// =============================================================================

function createEmptyCache(): QualityGateCache {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    entries: {},
  };
}

function isValidCacheSchema(data: unknown): data is QualityGateCache {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    obj.schemaVersion === CURRENT_SCHEMA_VERSION &&
    typeof obj.entries === 'object' &&
    obj.entries !== null
  );
}

export function loadCache(): QualityGateCache {
  const config = getConfig();
  if (!fs.existsSync(config.cache.file)) {
    return createEmptyCache();
  }

  try {
    const content = fs.readFileSync(config.cache.file, 'utf-8');
    const data = JSON.parse(content) as unknown;

    if (isValidCacheSchema(data)) {
      return data;
    }

    // Schema mismatch - could implement migration here
    // For now, start fresh if schema version doesn't match
    console.error(
      `Cache schema version mismatch. Expected ${CURRENT_SCHEMA_VERSION}, got ${(data as Record<string, unknown>).schemaVersion}. Starting fresh.`
    );
    return createEmptyCache();
  } catch {
    console.error('Failed to load cache, starting fresh');
    return createEmptyCache();
  }
}

export function saveCache(cache: QualityGateCache): void {
  const config = getConfig();
  // Sort entries by commit hash for clean git diffs
  const sortedEntries: Record<string, CacheEntry> = {};
  const sortedKeys = Object.keys(cache.entries).sort();

  for (const key of sortedKeys) {
    sortedEntries[key] = cache.entries[key];
  }

  const sortedCache: QualityGateCache = {
    schemaVersion: cache.schemaVersion,
    entries: sortedEntries,
  };

  fs.writeFileSync(
    config.cache.file,
    JSON.stringify(sortedCache, null, 2) + '\n'
  );
}

// =============================================================================
// Cache Entry Operations
// =============================================================================

export function getCacheEntry(
  cache: QualityGateCache,
  commitHash: string
): CacheEntry | undefined {
  return cache.entries[commitHash];
}

export function setCacheEntry(
  cache: QualityGateCache,
  commitHash: string,
  entry: CacheEntry
): void {
  cache.entries[commitHash] = entry;
}

export function createCacheEntry(
  metrics: Metrics,
  rules: QualityRules,
  status: 'pass' | 'fail',
  failedRules: string[]
): CacheEntry {
  return {
    timestamp: Date.now(),
    rulesVersion: rules.version,
    rulesHash: computeRulesHash(rules),
    evaluation: {
      status,
      failedRules,
    },
    metrics,
  };
}

// =============================================================================
// Baseline Resolution
// =============================================================================

/**
 * Find the best baseline entry for comparison
 *
 * For WIP code: baseline is HEAD commit (the last committed state)
 * For committed code: baseline is HEAD~1 (parent commit)
 */
export function findBaselineEntry(
  cache: QualityGateCache,
  _rules: QualityRules,
  isWIP: boolean = false
): CacheEntry | undefined {
  if (isWIP) {
    // For WIP: baseline is HEAD commit (last committed state)
    const headCommit = getCurrentCommitHash();
    return usableBaseline(cache.entries[headCommit]);
  }

  // For committed code: baseline is the parent of HEAD
  const baseline = resolveBaselineCommit();

  // Throws rather than returning undefined, because undefined here is
  // indistinguishable from "no baseline exists" and that is precisely the
  // conflation this function used to make. A missing baseline silently disables
  // every monotonic rule, so guessing at one is not a safe default -- a gate
  // that cannot tell whether it checked something must not report a pass.
  if (baseline.kind === 'indeterminate') {
    throw new Error(
      `Failed to determine the commit to compare against: ${baseline.reason}. ` +
        'Refusing to treat this as a first commit -- that would silently skip every monotonic ' +
        'rule instead of enforcing it.'
    );
  }

  if (baseline.kind === 'root-commit') {
    return undefined;
  }

  const entry = cache.entries[baseline.hash];

  if (!entry) {
    return undefined;
  }

  // Note: We still use old entries even if rules changed
  // The evaluation will be re-done, but we can compare metrics
  return usableBaseline(entry);
}

/**
 * A baseline whose own reading was incomplete is not a baseline.
 *
 * `isCacheValid` already refuses such an entry when it would be served as a
 * verdict, but this function bypassed that check entirely and monotonic
 * evaluation is where it hurts: `evaluateMonotonic` skips a comparison whose
 * baseline value is `undefined`, so a stored failure for the ratcheted dimension
 * silently disables the ratchet -- and because a baseline object WAS returned,
 * `cli.ts` does not count the rule as unevaluated and caches the pass as fully
 * earned. Floors fail loudly on a missing metric; monotonic rules do not, which
 * is what makes this the quiet direction.
 *
 * `cli.ts` no longer writes such an entry (any measurement failure blocks the
 * write), so the reachable population is entries left by an earlier build that
 * scoped that suppression to gated failures only. Discarding them costs one
 * re-measurement and removes the whole shape.
 *
 * Returning `undefined` deliberately routes into the SAME path as "no baseline
 * exists", which suppresses caching rather than failing the gate -- see the
 * monotonic-without-baseline policy question this leaves open (#28).
 */
function usableBaseline(entry: CacheEntry | undefined): CacheEntry | undefined {
  if (!entry) return undefined;
  return (entry.metrics.measurementFailures?.length ?? 0) > 0 ? undefined : entry;
}

// =============================================================================
// Cache Pruning
// =============================================================================

/**
 * Remove entries older than specified days to keep cache size manageable
 */
export function pruneOldEntries(
  cache: QualityGateCache,
  maxAgeDays: number = 90
): number {
  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let pruned = 0;

  for (const [hash, entry] of Object.entries(cache.entries)) {
    if (entry.timestamp < cutoffTime) {
      delete cache.entries[hash];
      pruned++;
    }
  }

  return pruned;
}
