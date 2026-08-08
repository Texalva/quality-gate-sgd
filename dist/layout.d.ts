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
/** The directory this tool measures. Not configurable -- see the module comment. */
export declare const REQUIRED_SOURCE_DIR = "src/";
/**
 * Refuse to measure a project whose code is not where this tool looks.
 *
 * Throws with a message that names the constraint and the one knob that widens it.
 * Callers turn that into an exit-1 with the text; there is no partial mode, because
 * "measured some of your code and reported it as your code" is the outcome being
 * prevented.
 */
export declare function assertSupportedLayout(projectRoot: string, codePathspecs: readonly string[]): void;
//# sourceMappingURL=layout.d.ts.map