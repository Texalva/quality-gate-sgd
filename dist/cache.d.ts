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
 * Untracked code files, resolved by asking GIT to apply the pathspecs.
 *
 * This deliberately does NOT reuse `isCodeFile` above, and the divergence is the
 * whole point of the function existing. `isCodeFile` tests a LITERAL prefix
 * (`filePath.startsWith(pathspec + '/')`), which is blind to every pathspec form
 * git accepts and this tool documents. MEASURED on git 2.51 with an untracked
 * `packages/a/src/new.ts` and a tracked edit to `packages/a/src/a.ts`:
 *
 *   pathspec                    git diff --name-only <C>   git ls-files --others   isCodeFile
 *   'packages/*'                a.ts                       new.ts                  DROPS new.ts
 *   'packages/*\/src/**'        a.ts                       new.ts                  DROPS new.ts
 *   ':(glob)packages/*\/src/**' a.ts                       new.ts                  DROPS new.ts
 *   '*.ts'                      a.ts                       new.ts                  DROPS new.ts
 *   'packages/*\/src'           (empty)                    (empty)                 (empty)
 *
 * So git's two answers agree in every form -- including agreeing that
 * `packages/*\/src` matches nothing -- while the literal prefix test disagrees with
 * both in four of the five. A provenance check built on the prefix test would say
 * VERIFIED after new source appeared beside a stamped report, on exactly the
 * monorepo layouts an earlier freshness rule was rejected for no-oping on.
 *
 * `computeContentHash` keeps the prefix test. That is not an oversight either: its
 * output IS the cache key, and sharpening it here would move the key for every
 * glob-pathspec project -- discarding their entries and changing what the cache
 * means -- for a fix that belongs to #40. The two are allowed to differ, provenance
 * is the sharper of the two, and neither may be quietly aligned with the other
 * without moving something a user can see.
 */
export declare function listUntrackedCodeFiles(): readonly string[];
/**
 * How the code under `codePathspecs` differs from one commit, as a single digest.
 *
 * The same two git questions `computeContentHash` asks, against a caller-supplied
 * commit instead of always HEAD, and WITHOUT `measurementInputsListing()`. Each
 * difference earns its place:
 *
 *   - Parameterised commit, because the coverage-provenance sidecar has to ask "is
 *     the code the same as when this report was stamped", and the stamp may have
 *     been taken on a dirty tree. Comparing cache-key STRINGS cannot answer that.
 *     MEASURED: coverage/ not gitignored so the report is untracked, tree therefore
 *     already `?? coverage/` -- stamp key `wip:fe9d8fb:18217e4f`, then one edit to
 *     src/a.ts, key `wip:fe9d8fb:5b0c1b69`. String inequality between two `wip:`
 *     keys cannot distinguish "the code moved" from "a past working tree that
 *     cannot be recomputed", so a report the tool has direct evidence describes
 *     other code would have to be reported as merely unverifiable. Recomputing
 *     THIS digest against the recorded commit answers it exactly.
 *   - No measurement inputs, because a change to rules.json, tsconfig.json or the
 *     eslint config does not change which code a coverage report describes.
 *     Folding them in would turn editing rules.json -- the single most common
 *     adopter action -- into a claim that the report describes different code,
 *     which is false. The cache key still folds them in, and still refuses to
 *     SERVE an entry across such a change; that is a different question.
 *
 * Errors as values rather than a throw, because both of its failure modes are
 * ordinary states with different answers: an unknown commit (shallow clone,
 * rebased-away stamp) is "cannot verify THIS sidecar", while an unhashable layout
 * is "cannot verify anything here".
 */
export type CodeStateDigest = {
    readonly kind: 'digest';
    readonly digest: string;
}
/** `codePathspecs` tracks nothing, so every state of the tree hashes the same. */
 | {
    readonly kind: 'no-tracked-code';
    readonly message: string;
}
/** Git refused the question -- usually an unknown commit. */
 | {
    readonly kind: 'git-failed';
    readonly message: string;
};
export declare function codeStateDigest(againstCommit: string): CodeStateDigest;
/**
 * The digest a tree with NO code differences from the commit produces.
 *
 * Named rather than inlined because a caller comparing against it is asking a
 * specific question -- "was the recorded stamp taken over a tree whose code matched
 * its commit exactly" -- and `sha256('')` at a call site reads like an accident.
 */
export declare function digestOfUnchangedCodeState(): string;
/**
 * Get the cache key for the current state.
 *
 * A clean tree keys on the bare commit hash, and that must not change:
 * `findBaselineEntry` resolves a baseline by looking up a commit hash directly.
 *
 * A dirty tree keys on `wip:<HEAD>:<contentHash>`. HEAD is in there because the
 * content hash alone is a diff-shaped answer, and a diff is meaningless without
 * the thing it is a diff FROM. `computeContentHash` hashes
 * `git diff HEAD -- <codePathspecs>` plus untracked code, so:
 *
 *   - Two different commits with the same uncommitted edit hash the same. Rebase,
 *     switch branch, `git commit --amend`, or check out an older revision with the
 *     same one-line patch applied, and the stored verdict for a completely
 *     different tree is served.
 *   - A project whose code lies outside `codePathspecs` (`app/`, `lib/`, a
 *     monorepo's per-package `src`) diffs to nothing, so the hash is sha256("") =
 *     e3b0c442... for EVERY working-tree state. REPRODUCED: 53 tsc errors against
 *     a ceiling of 3, served as `PASSED (cached)`, exit 0, content hash e3b0c44 on
 *     both runs.
 *
 * Prefixing HEAD closes the first outright and reduces the second from "permanent"
 * to "until you commit", which is the difference between a gate that never looks at
 * your code again and one that goes stale within a commit. It is not the whole fix
 * for the pathspec blind spot -- that is #40's remaining half, which has to
 * classify what git reports rather than diffing a fixed set of paths -- but it is
 * the layout-independent part, and it costs nothing.
 *
 * The coverage-provenance sidecar inherits that blind spot exactly, and it is worth
 * stating here because this is where the sharpness is set. The sidecar records a
 * commit plus `codeStateDigest`, which asks the same two git questions this key
 * does; in a layout whose real sources are outside `codePathspecs` the digest is a
 * constant, so a sidecar written there reports VERIFIED for every future state of
 * the working tree. Provenance is exactly as sharp as this key and never sharper.
 * The one place it is deliberately sharper is the UNTRACKED half -- see
 * `listUntrackedCodeFiles` for the measured reason and for why this function's own
 * filter was left alone.
 *
 * Old `wip:<64 hex>` keys cannot collide with new `wip:<40 hex>:<64 hex>` ones, so
 * no stale entry is reachable under the new scheme and no schema bump is needed.
 * That matters: a bump discards every entry, and see CacheEntry.monotonicEvaluated
 * for what an empty cache used to do to a ratcheted project.
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
export declare function createCacheEntry(metrics: Metrics, rules: QualityRules, status: 'pass' | 'fail', failedRules: string[], monotonicEvaluated: boolean): CacheEntry;
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