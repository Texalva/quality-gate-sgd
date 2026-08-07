/**
 * Package Manager Runner
 * ======================
 * The one place that answers "how do I run a script in this project" and "how do I
 * run a locally-installed binary". Every measurement that shells out to the
 * project's own toolchain goes through here.
 *
 * WHY IT IS ONE MODULE AND NOT A TERNARY AT EACH CALL SITE. `npm` was welded into
 * five unrelated places -- the typecheck provider, the lint provider, `runScript`,
 * the sonar scan, and init's calibration. Fixing them individually is how `init`
 * ends up calibrating a project with `npm run` while the gate measures it with
 * `bun run`: the interview reports one set of numbers, the gate then writes rules
 * against a different set, and the mismatch surfaces as a mysterious first-run
 * failure. The two must resolve the runner identically by construction, so they
 * ask the same function.
 *
 * WHY A WRONG GUESS IS MOSTLY SAFE, AND WHERE IT IS NOT. Detection is a heuristic
 * over lockfiles and will occasionally be wrong. For the ordinary failures that is
 * tolerable: a missing binary or a non-zero exit becomes a `MeasurementFailure` via
 * `classifyProcessOutput`, and the gate fails loudly with the command in the
 * evidence.
 *
 * That reasoning was originally written as "there is no path where a mis-detected
 * runner produces a number", and that was WRONG. `bun run <name>` does not fail on a
 * script package.json lacks -- it falls through to a same-named executable in
 * `node_modules/.bin`. A `type-check` shim that prints nothing and exits 0 is then a
 * successful process with empty output, which no exit-code check can tell from a clean
 * project. Reproduced against bun 1.3.14 (npm exits 1 there).
 *
 * So the safety does not come from the managers agreeing; it comes from
 * `manifestDefinesScript` settling existence from the manifest BEFORE anything is
 * spawned. A runner difference that turns "missing" into "ran something else" has to
 * be closed above the spawn, not diagnosed after it. The remaining known gap of this
 * shape is `npx`/`bunx` auto-installing an absent binary -- pre-existing for npx, and
 * tracked separately.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED. pnpm and yarn are not detected as distinct
 * managers. `npm run <script>` reads scripts out of package.json and works in a
 * pnpm or yarn workspace, so they fall through to the npm path and keep working;
 * claiming first-class support would imply this tool tests against their
 * node_modules layouts, and it does not.
 */
/** Managers this tool actually spawns. See the module comment on pnpm/yarn. */
export type PackageManager = 'npm' | 'bun';
/**
 * Which manager to use, and the signal that chose it.
 *
 * `reason` is not decoration -- it is appended to the command string in failure
 * evidence, so a run that shelled the wrong thing says why it did.
 */
export interface RunnerSelection {
    readonly manager: PackageManager;
    readonly reason: string;
}
/** Set to `npm` or `bun` to override detection entirely. */
export declare const PACKAGE_MANAGER_ENV_VAR = "QUALITY_PACKAGE_MANAGER";
/**
 * Which package manager runs this project.
 *
 * Order is most-explicit-first: an override, then a declaration in the manifest,
 * then lockfiles, then bun's own config file, then npm. Pure apart from reading
 * the filesystem, so callers can resolve it once and report it.
 *
 * Throws only for an override naming an unsupported manager. That case is not a
 * failed guess but a stated intention this tool cannot honour, and quietly
 * running npm instead would answer a question nobody asked.
 */
export declare function detectPackageManager(projectRoot: string): RunnerSelection;
/**
 * A resolved command: what to spawn, with what arguments, and how to describe it.
 *
 * `display` is EXACTLY the command that ran and nothing else, so it can be pasted
 * into a shell. The detection reason was briefly appended here and that was wrong:
 * failure evidence is supposed to hand back something reproducible, and
 * `npm run type-check (package-lock.json present)` is not a command. The reason
 * belongs in the diagnosis of failures where the runner is a plausible cause, and
 * in the one-line report of what the gate resolved -- not stapled to every
 * command string the tool prints.
 */
export interface ResolvedCommand {
    readonly executable: string;
    readonly args: readonly string[];
    readonly display: string;
}
/**
 * Run a script from package.json.
 *
 * Both managers spell this `<manager> run <script>`, exit non-zero when the script
 * is missing, and forward the script's own exit code otherwise -- verified against
 * npm 10 and bun 1.3.14. The wording of the missing-script message differs, which
 * matters only where a failure is being labelled.
 */
export declare function scriptCommand(script: string, selection: RunnerSelection): ResolvedCommand;
/**
 * Run a binary installed in the project's node_modules.
 *
 * `npx` for npm, `bunx` for bun. Not `node_modules/.bin/<bin>` directly, which was
 * the obvious-looking unification: those shims start with a `#!/usr/bin/env node`
 * shebang, so executing them requires node on PATH and defeats the point on a
 * machine that has bun and nothing else. `bunx` runs the same package under bun's
 * own runtime.
 */
export declare function binaryCommand(binary: string, args: readonly string[], selection: RunnerSelection): ResolvedCommand;
/** Set to run a differently-named script for the typescript dimension. */
export declare const TYPECHECK_SCRIPT_ENV_VAR = "QUALITY_TYPECHECK_SCRIPT";
/**
 * Whether package.json actually defines this script.
 *
 * Load-bearing, not a convenience: `bun run <name>` does NOT fail when the script is
 * absent. It falls through to a same-named executable in `node_modules/.bin` --
 * documented bun behaviour, and REPRODUCED here against bun 1.3.14 with a
 * `.bin/type-check` that prints nothing and exits 0, where `npm run type-check`
 * exited 1 with "Missing script".
 *
 * That difference is a vacuous pass of the purest kind: a bun project with no
 * type-check script but any dependency exposing a `type-check` binary gets exit 0, no
 * diagnostics, `{errors: 0}`, and a satisfied `typescript.errors: 0` ceiling. The
 * provider's exit-code corroboration cannot catch it, because the exit code is
 * genuinely 0 and something genuinely ran.
 *
 * So existence is established from the manifest BEFORE spawning, for both managers
 * rather than only bun -- a check that fires for one runner and not the other is a
 * check nobody maintains.
 */
export declare function manifestDefinesScript(projectRoot: string, script: string): boolean;
/** The script the typescript dimension will run, and why that one. */
export interface TypecheckScriptSelection {
    readonly script: string;
    readonly reason: string;
    /** False when the manifest does not define it; see manifestDefinesScript. */
    readonly definedInManifest: boolean;
}
/**
 * Which script type-checks this project.
 *
 * Resolved from the manifest rather than hardcoded, because `npm run type-check` was
 * welded in and any project using the equally-conventional `typecheck` got a
 * `tool-missing` failure for a type-check it does have. The frozen Apollo fixture in
 * this repo had a `type-check` script ADDED to it to work around exactly that.
 *
 * When no candidate exists this returns the conventional name anyway, so the provider
 * still runs it and still fails loudly with `tool-missing`. Returning "nothing to run"
 * would turn a missing type-check into an unmeasured dimension, which for a ceiling
 * rule is the vacuous pass.
 */
export declare function detectTypecheckScript(projectRoot: string): TypecheckScriptSelection;
/**
 * Which package manager a stored cache entry was measured by, read strictly.
 *
 * ABSENT means npm, and that is an inference rather than a lenient default: every entry
 * written before the field existed came from a version with npm hardcoded at each spawn
 * site, so npm is genuinely what measured it. That soundness is what lets the field be
 * added without a schema bump -- no pre-existing entry is ambiguous.
 *
 * Anything that is not exactly `npm` or `bun` returns undefined, which equals no
 * current manager, so the caller refuses the entry. That covers an explicit JSON
 * `null` -- which a plain `?? 'npm'` would have read AS npm -- a manager a future
 * version knows and this one does not, and a hand-edited or externally-written cache
 * file. The last is not hypothetical: `setCacheEntry` and `saveCache` are public
 * exports and `isValidCacheSchema` validates no entry fields, so "only this CLI writes
 * the cache" is not an invariant this function may assume.
 *
 * Lives here rather than in cache.ts because both the verdict path (`isCacheValid`, in
 * rules.ts) and the baseline path (`usableBaseline`, in cache.ts) must read the field
 * identically, and cache.ts already imports from rules.ts -- so the shared reader has
 * to sit somewhere neither depends on.
 */
export declare function readEntryManager(value: unknown): PackageManager | undefined;
/**
 * npm's and bun's wordings for a script that does not exist.
 *
 * npm 10: `Missing script: "type-check"`. bun 1.3.14: `error: Script not found
 * "type-check"`. Used only to LABEL a failure already established by the exit
 * code -- never to decide that one occurred -- so a reworded message degrades the
 * label and never the verdict.
 */
export declare const MISSING_SCRIPT_PATTERN: RegExp;
//# sourceMappingURL=runner.d.ts.map