/**
 * Source Layout Policy
 * ====================
 * This tool measures code under `src/`. That is a declared constraint, not an
 * accident of implementation, and this module is where it is enforced rather than
 * assumed.
 *
 * WHY `src/` IS MANDATORY. It is how a project says which code is subject to the
 * ratchet. A gate pointed at a whole repository grades vendored code, generated
 * clients, fixtures and build output, and the ratchet then moves for reasons nobody
 * intended. Naming one directory makes the boundary explicit and reviewable.
 *
 * WHY IT IS CHECKED RATHER THAN DOCUMENTED. The assumption was already load-bearing
 * in four unrelated places -- eslint lints `src/`, the SLOC counter walks `src/`, the
 * cache hashes `codePathspecs` (default `src/,tests/,scripts/`), and coverage
 * provenance answers "which code does this report describe" by diffing those same
 * pathspecs against the commit a sidecar records. A project laid out differently did
 * not fail; it measured a subset, or nothing, and the results still looked like
 * measurements:
 *
 *   - eslint reports a crashed measurement (loud, and only because of an earlier fix)
 *   - the SLOC counter returns 0, which normalises other dimensions against nothing
 *   - the cache key stops responding to edits, and a stored verdict is served for
 *     code the gate never looked at -- REPRODUCED: 53 tsc errors against a ceiling of
 *     3, `✓ Quality gate PASSED (cached)`, exit 0
 *   - the coverage provenance digest becomes the same constant too, so a stamped
 *     report is reported VERIFIED for every future state of the working tree. That is
 *     why `stamp-coverage` calls this function before writing anything: a sidecar that
 *     vouches for everything is strictly worse than no sidecar.
 *
 * An unsupported layout that runs anyway and reports a number is precisely the class
 * of failure this tool exists to prevent, so it refuses instead.
 *
 * WHAT IS DELIBERATELY NOT CHECKED. That `src/` holds ALL of your code. A project can
 * still keep half its sources in `app/` and get a reading of the half under `src/`.
 * Detecting that means guessing what the project meant, and a wrong guess is the same
 * silent mis-scope in a different coat. The contract is stated plainly and checked at
 * its one honest boundary: does `src/` track code at all.
 */

import { execSync } from 'child_process';

/** Matches the buffer the cache uses; `git ls-files` grows with repository size. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** The directory this tool measures. Not configurable -- see the module comment. */
export const REQUIRED_SOURCE_DIR = 'src/';

/**
 * The tracked files git reports under one set of pathspecs.
 *
 * `git ls-files` rather than a directory check, because the question is whether git
 * TRACKS code there. A `src/` holding only gitignored build output is the same blind
 * spot with a directory in front of it, and it would satisfy `existsSync`.
 */
function tracksFiles(projectRoot: string, pathspecs: readonly string[]): boolean {
  const listed = execSync(`git ls-files -- ${pathspecs.join(' ')}`, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return listed.trim().length > 0;
}

/**
 * Refuse to measure a project whose code is not where this tool looks.
 *
 * Throws with a message that names the constraint and the one knob that widens it.
 * Callers turn that into an exit-1 with the text; there is no partial mode, because
 * "measured some of your code and reported it as your code" is the outcome being
 * prevented.
 */
export function assertSupportedLayout(
  projectRoot: string,
  codePathspecs: readonly string[]
): void {
  if (!tracksFiles(projectRoot, [REQUIRED_SOURCE_DIR])) {
    throw new Error(
      `No tracked files under \`${REQUIRED_SOURCE_DIR}\`. This tool measures code under ` +
        `\`${REQUIRED_SOURCE_DIR}\` -- eslint lints it, the SLOC counter walks it, and the ` +
        'cache key is derived from it -- so a project laid out differently is measured ' +
        'partially or not at all, and the result still looks like a measurement. Move your ' +
        `sources under \`${REQUIRED_SOURCE_DIR}\`, or if you have a genuine reason not to, ` +
        'set QUALITY_CODE_PATHSPECS to the paths that hold your code and be aware that ' +
        'eslint and the SLOC counter still only read `src/`. Refusing to run rather than ' +
        'grading a fraction of your project.'
    );
  }

  // Separately reachable: a project that DOES have `src/` but whose
  // QUALITY_CODE_PATHSPECS was set to something that tracks nothing. The cache key
  // would then be a constant, which is the defect above by another route.
  if (!tracksFiles(projectRoot, codePathspecs)) {
    throw new Error(
      `No tracked files match QUALITY_CODE_PATHSPECS (${codePathspecs.join(', ')}), so the ` +
        'cache key would be the same constant for every state of the working tree -- which ' +
        'serves a stored verdict for code that was never measured. Point it at the paths ' +
        'that hold your code.'
    );
  }
}
