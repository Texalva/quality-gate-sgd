/**
 * Cache Module
 * Handles reading/writing the quality gate cache with schema versioning
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { computeRulesHash } from './rules.js';
import { getConfig } from './config.js';
import { readEntryManager } from './runner.js';
/**
 * 5 since an individual ratcheted metric absent from the baseline became a rule that
 * did not run. That is a change in what a PASS means, and the previous build recorded
 * it as the opposite: `monotonicSkipped` was true only when the whole baseline was
 * missing, so a run whose ratchet was skipped per-metric was stamped
 * `monotonicEvaluated: true`. `isCacheValid` refuses only an explicit `false`, so
 * every such entry on disk would be served by the cached-pass exit-0 path -- the
 * fixed build inheriting exactly the verdict the fix exists to prevent.
 * CONSTRUCTED and confirmed: a version-4 entry of that shape returns
 * `isCacheValid() === true`. Bumping discards it, which costs one re-measurement.
 *
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
const CURRENT_SCHEMA_VERSION = 5;
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
export function getCurrentCommitHash() {
    const config = getConfig();
    try {
        return execSync('git rev-parse HEAD', {
            cwd: config.projectRoot,
            encoding: 'utf-8',
        }).trim();
    }
    catch {
        throw new Error('Failed to get current commit hash');
    }
}
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
export function resolveBaselineCommit() {
    const config = getConfig();
    let commitObject;
    try {
        commitObject = execSync('git cat-file commit HEAD', {
            cwd: config.projectRoot,
            encoding: 'utf-8',
            maxBuffer: GIT_MAX_BUFFER,
        });
    }
    catch (error) {
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
function hasUncommittedChanges() {
    const config = getConfig();
    try {
        const output = execSync('git status --porcelain', {
            cwd: config.projectRoot,
            encoding: 'utf-8',
            maxBuffer: GIT_MAX_BUFFER,
        });
        return output.trim().length > 0;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to determine whether the working tree is clean: ${reason}. ` +
            'Refusing to assume it is -- that would cache this run against the wrong commit.');
    }
}
/**
 * Build git pathspec from config
 */
function getCodePathspec() {
    const config = getConfig();
    return '-- ' + config.codePathspecs.join(' ');
}
/**
 * Check if a file path matches code patterns (affects quality)
 */
function isCodeFile(filePath) {
    const config = getConfig();
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx'];
    // Check if file is in any of the configured code directories
    const isInCodeDir = config.codePathspecs.some((pathspec) => filePath.startsWith(pathspec.replace(/\/$/, '') + '/'));
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
function computeContentHash() {
    const config = getConfig();
    const codePathspec = getCodePathspec();
    // A hash of nothing is not a cache key.
    //
    // `git diff HEAD -- <pathspecs>` over paths that hold no tracked files is the
    // empty string for EVERY working-tree state, so the WIP key was
    // sha256("") = e3b0c442... permanently and the stored verdict was served for
    // arbitrarily different code until the commit changed. REPRODUCED before this:
    // a tree with 53 tsc errors against a ceiling of 3 printed
    // `✓ Quality gate PASSED (cached)` and exited 0, content hash e3b0c44 on both runs.
    // Anchoring the key to HEAD bounded that to "until you commit"; this ends it.
    //
    // Checked against `git ls-files`, which asks the question that actually matters --
    // does git TRACK anything under these paths -- rather than whether a directory
    // exists. A `src/` holding only gitignored build output is the same blind spot
    // with a directory in front of it.
    //
    // This is a refusal rather than a fallback because there is no honest fallback:
    // hashing the whole tree would change what the cache means, and guessing the real
    // layout is the same class of silent mis-scope. The project says where its code is
    // (QUALITY_CODE_PATHSPECS, default `src/,tests/,scripts/`); if that is wrong, the
    // answer is to say so, not to grade something else.
    const tracked = execSync(`git ls-files ${codePathspec}`, {
        cwd: config.projectRoot,
        encoding: 'utf-8',
        maxBuffer: GIT_MAX_BUFFER,
    }).trim();
    if (tracked.length === 0) {
        throw new Error(`No tracked files match ${config.codePathspecs.join(', ')}, so there is nothing to ` +
            'hash and the cache key would be the same constant for every state of the working ' +
            'tree -- which serves a stored verdict for code that was never measured. This tool ' +
            'measures code under `src/`; if yours lives elsewhere, set QUALITY_CODE_PATHSPECS to ' +
            'the paths that hold it. Refusing to run rather than caching against a hash of nothing.');
    }
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
                }
                catch {
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
 * Old `wip:<64 hex>` keys cannot collide with new `wip:<40 hex>:<64 hex>` ones, so
 * no stale entry is reachable under the new scheme and no schema bump is needed.
 * That matters: a bump discards every entry, and see CacheEntry.monotonicEvaluated
 * for what an empty cache used to do to a ratcheted project.
 */
export function getCacheKey() {
    if (!hasUncommittedChanges()) {
        return {
            key: getCurrentCommitHash(),
            isWIP: false,
        };
    }
    // Both resolved into named consts, in the order they are read, rather than
    // interpolated inline. `computeContentHash` shells git twice and
    // `getCurrentCommitHash` once, so an inline call would put the git invocations in
    // template-literal order -- readable here, and invisible to the tests, which stub
    // `execSync` by call sequence.
    const headHash = getCurrentCommitHash();
    const contentHash = computeContentHash();
    return {
        key: `wip:${headHash}:${contentHash}`,
        isWIP: true,
    };
}
/**
 * Check if a cache key is a WIP content hash (vs a commit hash)
 */
export function isWIPKey(key) {
    return key.startsWith('wip:');
}
// =============================================================================
// Cache I/O
// =============================================================================
function createEmptyCache() {
    return {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        entries: {},
    };
}
function isValidCacheSchema(data) {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const obj = data;
    return (obj.schemaVersion === CURRENT_SCHEMA_VERSION &&
        typeof obj.entries === 'object' &&
        obj.entries !== null);
}
export function loadCache() {
    const config = getConfig();
    if (!fs.existsSync(config.cache.file)) {
        return createEmptyCache();
    }
    try {
        const content = fs.readFileSync(config.cache.file, 'utf-8');
        const data = JSON.parse(content);
        if (isValidCacheSchema(data)) {
            return data;
        }
        // Schema mismatch - could implement migration here
        // For now, start fresh if schema version doesn't match
        console.error(`Cache schema version mismatch. Expected ${CURRENT_SCHEMA_VERSION}, got ${data.schemaVersion}. Starting fresh.`);
        return createEmptyCache();
    }
    catch {
        console.error('Failed to load cache, starting fresh');
        return createEmptyCache();
    }
}
export function saveCache(cache) {
    const config = getConfig();
    // Sort entries by commit hash for clean git diffs
    const sortedEntries = {};
    const sortedKeys = Object.keys(cache.entries).sort();
    for (const key of sortedKeys) {
        sortedEntries[key] = cache.entries[key];
    }
    const sortedCache = {
        schemaVersion: cache.schemaVersion,
        entries: sortedEntries,
    };
    fs.writeFileSync(config.cache.file, JSON.stringify(sortedCache, null, 2) + '\n');
}
// =============================================================================
// Cache Entry Operations
// =============================================================================
export function getCacheEntry(cache, commitHash) {
    return cache.entries[commitHash];
}
export function setCacheEntry(cache, commitHash, entry) {
    cache.entries[commitHash] = entry;
}
export function createCacheEntry(metrics, rules, status, failedRules, 
// REQUIRED, though the field it sets is optional. A writer that forgets it would
// record an unevaluated ratchet as an evaluated one, which is the shape
// `isCacheValid` exists to refuse; tolerating history is a reason to accept a
// missing value when READING, not a reason to let a new entry omit it.
monotonicEvaluated) {
    return {
        timestamp: Date.now(),
        rulesVersion: rules.version,
        rulesHash: computeRulesHash(rules),
        evaluation: {
            status,
            failedRules,
        },
        metrics,
        monotonicEvaluated,
        // Read from config rather than taken as a parameter, unlike the flag above:
        // which manager ran is ambient for the whole process, not a property of this
        // run that only the caller knows, so there is nothing here for a writer to
        // forget or to get wrong.
        packageManager: getConfig().packageManager.manager,
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
export function findBaselineEntry(cache, _rules, isWIP = false) {
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
        throw new Error(`Failed to determine the commit to compare against: ${baseline.reason}. ` +
            'Refusing to treat this as a first commit -- that would silently skip every monotonic ' +
            'rule instead of enforcing it.');
    }
    if (baseline.kind === 'root-commit') {
        return undefined;
    }
    const entry = cache.entries[baseline.hash];
    if (!entry) {
        return undefined;
    }
    // An entry written under a DIFFERENT ruleset is still a valid baseline, and this
    // is a decision rather than an oversight -- `isCacheValid` checks `rulesHash` and
    // this function deliberately does not.
    //
    // The worry was that an entry written under a ruleset lacking some ratchet gets
    // accepted as that ratchet's starting point. It does, and that is correct:
    // extraction is not rule-scoped (`extractAllMetrics` measures every dimension it
    // can, whatever the rules say), so the parent's value for the newly-ratcheted
    // metric is an honest reading of the parent either way. Rules decide what is
    // GRADED; they do not decide what was measured.
    //
    // Refusing on a hash mismatch would cost real enforcement for no correctness gain:
    // every edit to rules.json would discard every baseline, so the commit that adds a
    // ratchet -- and every commit until a full re-measure walks forward again -- would
    // have nothing to compare against, which is the deadlock the two-tier write exists
    // to avoid. The one case the worry actually names, a metric MISSING from the
    // baseline, is now caught per-metric by `evaluateMonotonic` and reported as
    // unevaluated instead of being skipped in silence.
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
function usableBaseline(entry) {
    if (!entry)
        return undefined;
    if ((entry.metrics.measurementFailures?.length ?? 0) > 0)
        return undefined;
    // A baseline measured by a different package manager is refused here as well as in
    // `isCacheValid`, and the two are NOT the same check even though they compare the
    // same field. `isCacheValid` asks "may this entry be served as a verdict"; this asks
    // "are these numbers comparable to the ones I just took". For `monotonicEvaluated`
    // those questions have different answers -- an unevaluated entry is still an honest
    // reading of its commit, so it makes a fine baseline. For the package manager they
    // have the SAME answer, because numbers from two toolchains cannot be differenced:
    //
    //   parent measured under npm: typescript.errors = 10
    //   this run under bun:        typescript.errors = 5
    //   the parent's TRUE bun reading would have been 4
    //
    // A `down` ratchet should fail 4 -> 5 and instead passes 10 -> 5, and the run is then
    // recorded with `monotonicEvaluated: true`, so the unearned pass becomes cacheable.
    // Guarding only the verdict path left exactly this open.
    return readEntryManager(entry.packageManager) === getConfig().packageManager.manager
        ? entry
        : undefined;
}
// =============================================================================
// Cache Pruning
// =============================================================================
/**
 * Remove entries older than specified days to keep cache size manageable
 */
export function pruneOldEntries(cache, maxAgeDays = 90) {
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
//# sourceMappingURL=cache.js.map