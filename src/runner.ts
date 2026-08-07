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

import { existsSync, readFileSync } from 'fs';
import path from 'path';

/** Managers this tool actually spawns. See the module comment on pnpm/yarn. */
export type PackageManager = 'npm' | 'bun';

const SUPPORTED_MANAGERS = new Set<string>(['npm', 'bun']);

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
export const PACKAGE_MANAGER_ENV_VAR = 'QUALITY_PACKAGE_MANAGER';

/**
 * Lockfiles, in the order they are consulted.
 *
 * bun before npm, and that ordering is a real decision rather than an accident:
 * a `package-lock.json` left behind by a migration to bun is common and harmless,
 * while a `bun.lock` in a project that genuinely runs npm is not something that
 * happens by drift -- you only get one by running bun. So when both are present,
 * the bun lockfile is the more recent statement of intent.
 *
 * `bun.lockb` is the pre-1.2 binary format, still present in older projects.
 */
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/**
 * package.json as an object, or undefined when it is absent or unreadable.
 *
 * A manifest this tool cannot parse is not this function's problem to report.
 * Detection falls through to its filesystem signals, and whatever is wrong with the
 * manifest surfaces from the tool that actually needs to read it -- which will be
 * every one of them, loudly.
 */
function readManifest(projectRoot: string): Record<string, unknown> | undefined {
  const manifest = path.join(projectRoot, 'package.json');
  if (!existsSync(manifest)) return undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The `scripts` block, with only the string-valued entries. */
function scriptsOf(projectRoot: string): Record<string, string> {
  const scripts = readManifest(projectRoot)?.scripts;
  if (typeof scripts !== 'object' || scripts === null) return {};
  return Object.fromEntries(
    Object.entries(scripts as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

/**
 * The `packageManager` field, when it names something this tool spawns.
 *
 * Corepack's format is `name@version`; the version is irrelevant here. A field
 * naming pnpm or yarn returns undefined and detection falls through to the
 * lockfiles rather than refusing -- see the module comment.
 */
function readDeclaredManager(projectRoot: string): PackageManager | undefined {
  const declared = readManifest(projectRoot)?.packageManager;
  if (typeof declared !== 'string') return undefined;

  const name = declared.split('@')[0]?.trim();
  return name === 'bun' || name === 'npm' ? name : undefined;
}

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
export function detectPackageManager(projectRoot: string): RunnerSelection {
  const override = process.env[PACKAGE_MANAGER_ENV_VAR]?.trim();
  if (override) {
    if (!SUPPORTED_MANAGERS.has(override)) {
      throw new Error(
        `${PACKAGE_MANAGER_ENV_VAR} is set to "${override}", which this tool cannot run. ` +
          `Supported values are ${[...SUPPORTED_MANAGERS].join(' and ')}. Unset it to detect ` +
          'the manager from the project, or set it to one of those. Refusing to fall back to ' +
          'npm, because you asked for something specific and npm is not it.'
      );
    }
    return {
      manager: override as PackageManager,
      reason: `${PACKAGE_MANAGER_ENV_VAR}=${override}`,
    };
  }

  const declaredRaw = readManifest(projectRoot)?.packageManager;
  const declared = readDeclaredManager(projectRoot);
  if (declared) {
    return { manager: declared, reason: `packageManager field names ${declared}` };
  }

  // A declaration this tool cannot honour is reported rather than dropped in silence.
  // Falling through is deliberate -- `npm run <script>` reads scripts out of
  // package.json and works in a pnpm or yarn workspace, so refusing would break
  // projects that work today -- but "your stated package manager was ignored" is
  // something the adopter has to be able to see, and the run banner prints this.
  const ignoredDeclaration =
    typeof declaredRaw === 'string' && declaredRaw.trim() !== ''
      ? `packageManager names ${declaredRaw.split('@')[0]}, which this tool does not spawn; `
      : '';

  for (const [lockfile, manager] of LOCKFILES) {
    if (existsSync(path.join(projectRoot, lockfile))) {
      return { manager, reason: `${ignoredDeclaration}${lockfile} present` };
    }
  }

  // Last: bunfig.toml is bun's config, and a project carrying one is running bun
  // even before it has installed anything. Below the lockfiles because config can
  // outlive the choice it configured.
  if (existsSync(path.join(projectRoot, 'bunfig.toml'))) {
    return { manager: 'bun', reason: `${ignoredDeclaration}bunfig.toml present` };
  }

  return {
    manager: 'npm',
    reason: `${ignoredDeclaration}no bun lockfile, manifest field, or bunfig.toml`,
  };
}

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

function resolved(executable: string, args: readonly string[]): ResolvedCommand {
  return { executable, args, display: `${executable} ${args.join(' ')}` };
}

/**
 * Run a script from package.json.
 *
 * Both managers spell this `<manager> run <script>`, exit non-zero when the script
 * is missing, and forward the script's own exit code otherwise -- verified against
 * npm 10 and bun 1.3.14. The wording of the missing-script message differs, which
 * matters only where a failure is being labelled.
 */
export function scriptCommand(script: string, selection: RunnerSelection): ResolvedCommand {
  return resolved(selection.manager, ['run', script]);
}

/**
 * Run a binary installed in the project's node_modules.
 *
 * `npx` for npm, `bunx` for bun. Not `node_modules/.bin/<bin>` directly, which was
 * the obvious-looking unification: those shims start with a `#!/usr/bin/env node`
 * shebang, so executing them requires node on PATH and defeats the point on a
 * machine that has bun and nothing else. `bunx` runs the same package under bun's
 * own runtime.
 */
export function binaryCommand(
  binary: string,
  args: readonly string[],
  selection: RunnerSelection
): ResolvedCommand {
  const launcher = selection.manager === 'bun' ? 'bunx' : 'npx';
  return resolved(launcher, [binary, ...args]);
}

/** Set to run a differently-named script for the typescript dimension. */
export const TYPECHECK_SCRIPT_ENV_VAR = 'QUALITY_TYPECHECK_SCRIPT';

/**
 * Script names that mean "type-check this project", in precedence order.
 *
 * `type-check` stays first because it is the name this tool has always run, so no
 * project's measurement changes by adding the others -- they only rescue projects
 * that previously got a `tool-missing` failure. Apollo Client is the case in point
 * and also the reason the order is load-bearing rather than arbitrary: it ships BOTH
 * names, and they are not the same check. Its `type-check` is
 * `tsc --noEmit -p tsconfig.json`; its `typecheck` runs three commands including a
 * nested `npm run test` in a sub-package. Picking the wrong one would silently change
 * what "the typescript dimension" means for that project.
 *
 * Deliberately short. `tsc`, `check-types` and `lint:types` were considered and left
 * out: each widens the guessing for a project that could simply set the env var, and a
 * wrong guess here does not fail loudly -- it measures the wrong thing successfully.
 */
const TYPECHECK_SCRIPT_CANDIDATES = ['type-check', 'typecheck'] as const;

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
export function manifestDefinesScript(projectRoot: string, script: string): boolean {
  return definesScript(scriptsOf(projectRoot), script);
}

/**
 * `Object.hasOwn`, not `in`. `in` walks the prototype chain, so `'constructor' in
 * scripts` and `'toString' in scripts` are both TRUE for any plain object -- which
 * would make this existence check answer yes for a script no manifest declares, and
 * then spawn `bun run constructor`. Caught by its own test.
 */
function definesScript(scripts: Record<string, string>, script: string): boolean {
  return Object.hasOwn(scripts, script);
}

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
export function detectTypecheckScript(projectRoot: string): TypecheckScriptSelection {
  const scripts = scriptsOf(projectRoot);

  const override = process.env[TYPECHECK_SCRIPT_ENV_VAR]?.trim();
  if (override) {
    // An override is still checked for existence. Naming a script that is not there
    // is a configuration mistake, and under bun it would otherwise run whatever
    // binary happens to share the name.
    return {
      script: override,
      reason: `${TYPECHECK_SCRIPT_ENV_VAR}=${override}`,
      definedInManifest: definesScript(scripts, override),
    };
  }

  const found = TYPECHECK_SCRIPT_CANDIDATES.find((name) => definesScript(scripts, name));
  if (found) {
    const others = TYPECHECK_SCRIPT_CANDIDATES.filter(
      (n) => n !== found && definesScript(scripts, n)
    );
    return {
      script: found,
      // Naming the runners-up matters: a project with both gets one of them measured,
      // and which one is not something the adopter should have to infer.
      reason:
        others.length > 0
          ? `package.json defines ${found} (also has ${others.join(', ')}; ${TYPECHECK_SCRIPT_ENV_VAR} overrides)`
          : `package.json defines ${found}`,
      definedInManifest: true,
    };
  }

  return {
    script: TYPECHECK_SCRIPT_CANDIDATES[0],
    reason: `package.json defines none of ${TYPECHECK_SCRIPT_CANDIDATES.join(', ')}`,
    definedInManifest: false,
  };
}

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
export function readEntryManager(value: unknown): PackageManager | undefined {
  if (value === undefined) return 'npm';
  return value === 'npm' || value === 'bun' ? value : undefined;
}

/**
 * npm's and bun's wordings for a script that does not exist.
 *
 * npm 10: `Missing script: "type-check"`. bun 1.3.14: `error: Script not found
 * "type-check"`. Used only to LABEL a failure already established by the exit
 * code -- never to decide that one occurred -- so a reworded message degrades the
 * label and never the verdict.
 */
export const MISSING_SCRIPT_PATTERN = /missing script|script not found/i;
