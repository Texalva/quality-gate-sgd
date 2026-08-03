/**
 * Cache Module
 * Handles reading/writing the quality gate cache with schema versioning
 */
import type { QualityGateCache, CacheEntry, Metrics, QualityRules } from './types.js';
export declare function getCurrentCommitHash(): string;
/**
 * Where the previous commit's reading should come from, or why it cannot be said.
 *
 * The three cases used to be one. `git rev-parse HEAD~1` failing was read as
 * "first commit has no parent", which is only one of the reasons it fails.
 */
export type BaselineCommit = 
/** HEAD has a parent, and this is it. */
{
    readonly kind: 'parent';
    readonly hash: string;
}
/** HEAD genuinely has no parent, so there is no baseline to compare against. */
 | {
    readonly kind: 'root-commit';
}
/** Git could not be asked. Distinct from "there is nothing to find". */
 | {
    readonly kind: 'indeterminate';
    readonly reason: string;
};
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
export declare function resolveBaselineCommit(): BaselineCommit;
/**
 * Get the cache key for the current state
 * Returns commit hash for clean working tree, or wip:contentHash for uncommitted changes
 */
export declare function getCacheKey(): {
    key: string;
    isWIP: boolean;
};
/**
 * Check if a cache key is a WIP content hash (vs a commit hash)
 */
export declare function isWIPKey(key: string): boolean;
export declare function loadCache(): QualityGateCache;
export declare function saveCache(cache: QualityGateCache): void;
export declare function getCacheEntry(cache: QualityGateCache, commitHash: string): CacheEntry | undefined;
export declare function setCacheEntry(cache: QualityGateCache, commitHash: string, entry: CacheEntry): void;
export declare function createCacheEntry(metrics: Metrics, rules: QualityRules, status: 'pass' | 'fail', failedRules: string[]): CacheEntry;
/**
 * Find the best baseline entry for comparison
 *
 * For WIP code: baseline is HEAD commit (the last committed state)
 * For committed code: baseline is HEAD~1 (parent commit)
 */
export declare function findBaselineEntry(cache: QualityGateCache, _rules: QualityRules, isWIP?: boolean): CacheEntry | undefined;
/**
 * Remove entries older than specified days to keep cache size manageable
 */
export declare function pruneOldEntries(cache: QualityGateCache, maxAgeDays?: number): number;
//# sourceMappingURL=cache.d.ts.map