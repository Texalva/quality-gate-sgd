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
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getConfig } from './config.js';
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
export const MEASUREMENT_INPUTS = [
    // What is graded.
    'rules.json',
    // What is measured, and how.
    'tsconfig.json',
    'quality-gate.config.ts',
    'quality-gate.config.js',
    'quality-gate.config.mjs',
    'quality-gate.config.cjs',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc.json',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    'vitest.config.ts',
    'vitest.config.js',
    'vitest.config.mts',
    'jest.config.ts',
    'jest.config.js',
    'sonar-project.properties',
    // Which commands run, and against which dependency versions.
    'package.json',
    'package-lock.json',
    'bun.lock',
    'bun.lockb',
];
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
export function measurementInputsListing() {
    const config = getConfig();
    return MEASUREMENT_INPUTS.map((name) => {
        const fullPath = path.join(config.projectRoot, name);
        let digest = 'absent';
        try {
            if (fs.statSync(fullPath).isFile()) {
                digest = crypto
                    .createHash('sha256')
                    .update(fs.readFileSync(fullPath))
                    .digest('hex');
            }
        }
        catch {
            // Unreadable is its own state, and distinct from both absent and any content: a
            // config the tool cannot read is a measurement it cannot account for, and
            // collapsing it into `absent` would let a permissions flip go unnoticed.
            digest = 'unreadable';
        }
        return `@@@ input: ${name} ${digest} @@@`;
    })
        .concat(sonarTargetLine())
        .join('\n');
}
/**
 * The SonarQube server and project this run grades against, as one digest.
 *
 * Not a file, so the list above cannot carry it: `SONARQUBE_URL` and
 * `SONARQUBE_PROJECT_KEY` come from the environment, and `sonar-project.properties`
 * is only one of the places the answer can come from. Without this line, two runs
 * pointed at DIFFERENT servers -- or at different project keys on the same server --
 * produced the same cache identity, so a verdict earned against a staging instance
 * with an empty quality profile was served for production.
 *
 * Digested rather than named, for two reasons: the URL may embed a credential, and a
 * project key can carry an organisation name nobody chose to publish in a cache file
 * that gets committed.
 */
function sonarTargetLine() {
    const config = getConfig();
    const digest = crypto
        .createHash('sha256')
        .update(`${config.sonarqube.url}\n${config.sonarqube.projectKey}`)
        .digest('hex');
    return `@@@ target: sonarqube ${digest} @@@`;
}
/** The stamped form: one hash over the whole listing. */
export function measurementInputsHash() {
    return crypto.createHash('sha256').update(measurementInputsListing()).digest('hex');
}
//# sourceMappingURL=measurement-inputs.js.map