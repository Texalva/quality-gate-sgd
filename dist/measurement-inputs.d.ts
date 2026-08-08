/**
 * Measurement Inputs
 * ==================
 * The project-root files that decide what a measurement MEANS, and a digest of them.
 *
 * Its own module because both sides of the cache need it and neither can import the
 * other: `cache.ts` already imports `computeRulesHash` from `rules.ts`, so a helper
 * living in either would close a cycle. Same reason `readEntryManager` lives in
 * `runner.ts`. The digest is read on the WRITE path (`createCacheEntry` stamps it) and
 * on the READ path (`isCacheValid` refuses a mismatch).
 */
/**
 * Project-root files that decide what a measurement MEANS.
 *
 * These are inputs, not artifacts, and that distinction is why they belong in the
 * cache identity unconditionally. Widening the key to cover generated reports has a
 * real cost -- the key moves whenever a report is rewritten, so the cache stops
 * hitting -- and config has no such tension: it changes when a human changes it.
 *
 * TWO defects were closed by this list, and the second is why it is hashed by CONTENT
 * rather than filtered out of a git diff.
 *
 * (1) MISSING ENTRIES. The old list named four files. `tsconfig.json` was not among
 * them though it decides `typescript.errors` outright, and neither was the eslint
 * config though it decides `eslint.errors` -- an asymmetry with `vitest.config.ts`,
 * which WAS named. Nor was `quality-gate.config.*`, the sharpest of the three: a
 * custom dimension is gated by a ceiling and by nothing else, so no other channel
 * would notice. REPRODUCED before this: rewriting a custom dimension's extractor
 * command and its display name left the content hash at `e3b0c44` across both runs,
 * and the prior verdict was served for a measurably different measurement.
 *
 * (2) THE ENTRIES THAT WERE THERE DID NOT WORK. `isCodeFile` is applied only to
 * `git ls-files --others`, and the tracked diff is scoped to `codePathspecs` (default
 * `src/,tests/,scripts/`), which no root-level config file falls under. So a config
 * file counted only while UNTRACKED, and every real project commits these. MEASURED:
 * with a tracked `vitest.config.ts`, rewriting it end to end left the WIP key
 * byte-identical -- `wip:7de5d4b6...:3c4adc84...` before and after. Reading the bytes
 * sidesteps the tracked/untracked distinction entirely.
 *
 * `package.json` is here because it decides which COMMANDS run: the typecheck
 * script's body is what `typescript.errors` is a count of, and the script name is
 * resolved from this file. The lockfiles are here for the same reason one step out --
 * a dependency upgrade changes what the linter and compiler report. Both churn more
 * than the rest, and a cache miss after `npm install` is the correct outcome rather
 * than a regression.
 *
 * WHAT THIS STILL DOES NOT COVER, so it is not read as more than it is: a config that
 * `extends` or imports another file (a shared tsconfig base, a published eslint
 * preset) changes meaning without changing these bytes; and the list is project-root
 * only, so a tsconfig nested under a monorepo's `packages` directory is out of scope.
 * Both are transitive-closure problems, a different design than a file list.
 */
export declare const MEASUREMENT_INPUTS: readonly string[];
/**
 * One line per measurement input, naming it and digesting its bytes.
 *
 * Per-file SHA-256 of the RAW BYTES, not the decoded text: `bun.lockb` is binary, and
 * reading it as utf-8 would fold distinct lockfiles onto the same replacement
 * characters. Absent files are recorded as absent rather than skipped, so ADDING a
 * config moves the digest as surely as editing one -- dropping in an
 * `eslint.config.mjs` where there was none changes every lint reading that follows.
 *
 * Returned as the listing rather than a single hash because the WIP content hash
 * concatenates it with git output before hashing once, while the cache entry stamps a
 * hash of it. Both want the same bytes; only one of them wants them pre-digested.
 */
export declare function measurementInputsListing(): string;
/** The stamped form: one hash over the whole listing. */
export declare function measurementInputsHash(): string;
//# sourceMappingURL=measurement-inputs.d.ts.map