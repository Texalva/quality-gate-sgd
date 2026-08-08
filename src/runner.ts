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
 * be closed above the spawn, not diagnosed after it.
 *
 * THE SAME ARGUMENT APPLIES TO BINARIES, and used to have no answer. `npx eslint` and
 * `bunx eslint` do not FAIL when the project has no eslint -- they SUPPLY one.
 * Reproduced in a directory holding nothing but a package.json, an eslint.config.mjs
 * and src/a.js: `npx eslint --format json src/` exited 0 with a complete per-file
 * report, errorCount 0, out of eslint v10.8.1. `{errors: 0}` satisfying an
 * `eslint.errors: 0` ceiling, measured by a linter the project never installed.
 *
 * Closed twice below. `binaryCommand` passes `--no-install`, and `binaryInvocation`
 * settles existence from `node_modules/.bin` BEFORE anything is spawned -- exactly what
 * `manifestDefinesScript` does for scripts, one layer out.
 *
 * `--no-install` ALONE would not have been enough, and that is worth recording because
 * it looks sufficient. Both launchers fall back to a machine-global cache the flag does
 * not disable: in that same directory `npx --no-install eslint --format json src/` and
 * `bunx --no-install eslint --format json src/` BOTH exited 0 with the same clean
 * errorCount-0 report, served out of `~/.npm/_npx/<hash>` and
 * `/tmp/bunx-<uid>-eslint@latest` left behind by earlier unrelated runs. npx
 * additionally resolves npm's global prefix bin; bunx additionally resolves anything on
 * PATH. So the pre-flight is the load-bearing half, and the flag's honest scope is
 * narrower than it looks: it protects a machine with a COLD cache, no global install and
 * nothing on PATH, and nothing else. It does NOT rescue a call site that skips the
 * pre-flight -- on any warm machine that call site gets the full vacuous pass back.
 *
 * Nor does it close the window between the check and the exec, which an earlier draft of
 * this comment claimed. If the shim vanishes after `existsSync` and before the spawn --
 * a concurrent install or prune -- the launcher falls back to the same warm cache and
 * emits the same clean report, and nothing downstream can tell that apart from the local
 * run. That residual is real and is NOT closed here: the fix would be to exec the
 * resolved shim, which `binaryCommand` deliberately does not do because those shims
 * start `#!/usr/bin/env node` and that breaks a bun-only machine. What IS caught is the
 * narrower case where the launcher has nothing to fall back to and refuses with empty
 * stdout, which the eslint provider relabels via NO_INSTALL_REFUSAL_PATTERN.
 *
 * One more residual, for the same reason it is not closed: the walk blesses ANY
 * `node_modules/.bin/<bin>` on the way up, including one outside the project. A stray
 * `/home/<user>/node_modules/.bin/eslint` satisfies the pre-flight for every project
 * under `$HOME`. Deliberate -- it is exactly what the launchers do, and refusing anything
 * above `projectRoot` false-fails hoisted monorepos and pnpm workspaces, which is the
 * class of error two earlier designs for this died of. Proving workspace membership would
 * mean parsing npm/pnpm/yarn workspace metadata, which this module explicitly does not do
 * (it does not even detect pnpm as a manager). The residual is a misconfigured machine,
 * not a project state.
 *
 * STILL OPEN, and the same defect one module over: custom dimensions run an arbitrary
 * extractor command through bash (`dimensions/custom.ts`) with no launcher awareness,
 * and the CLI's own help text seeds one -- `add-dimension "npx madge --circular --json
 * src/"`. A custom dimension is gated by a ceiling and by nothing else, and every
 * lower-better dimension is at its best at zero, so a foreign madge grading that
 * ceiling is the identical failure. Nothing here touches that path.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED. pnpm and yarn are not detected as distinct
 * managers. `npm run <script>` reads scripts out of package.json and works in a
 * pnpm or yarn workspace, so they fall through to the npm path and keep working;
 * claiming first-class support would imply this tool tests against their
 * node_modules layouts, and it does not.
 *
 * Binary resolution is a second and STRICTER dependency on that layout. A Yarn PnP
 * tree (`nodeLinker: pnp`) has no `node_modules/.bin` at all, so nothing can be
 * resolved there and the pre-flight refuses rather than measuring. That is the safe
 * direction and not a new loss -- `npm run <script>` does not work in a PnP tree
 * either -- but it does mean such a project gets a loud refusal where today it gets a
 * silent grade from a registry-supplied linter. A refusal has to be one the adopter can
 * actually resolve, and "install eslint" is not that for someone who already has it, so
 * `installAdvice` detects PnP by its `.pnp.cjs` loader and names the linker change
 * instead. `installAdvice` is the one place that names pnpm and yarn at all, and only to
 * word a remedy; it never picks a launcher.
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
 * The flag that stops a launcher inventing a binary the project does not have.
 *
 * `--no-install` on BOTH launchers -- npm 12.0.2 and bun 1.3.14 spell it identically,
 * verified by running each. Both then exit 1 rather than fetching:
 *   npx  -> `npm error npx canceled due to missing packages and no YES option:
 *            ["cowsay@1.6.0"]`
 *   bunx -> `error: Could not find an existing 'cowsay' binary to run. Stopping because
 *            --no-install was passed.`
 * and neither changes anything for a binary that IS installed: `npx qgprobe47`,
 * `npx --no-install qgprobe47` and `bunx --no-install qgprobe47` all ran the same
 * `node_modules/.bin` shim with the arguments forwarded verbatim.
 *
 * NOT npx's `--no`, which looks like the same flag and is a trap. Read out of npm 12.0.2's
 * own source: `--no` expands to `--no-yes` (`@npmcli/config/lib/definitions` shorthands),
 * and `no-yes` is in neither the `switches` nor the `opts` set of `bin/npx-cli.js` -- so
 * its argv preprocessor hits the final branch, treats the NEXT TOKEN as the flag's value
 * and skips over it. The next token is the binary name, so no positional argument is ever
 * found and no `--` is inserted. MEASURED: `npx --no eslint --version` printed `12.0.2`
 * and exited 0. It ran `npm --version`. A guard whose misspelling manufactures its own
 * vacuous pass is worse than no guard, so the spelling is pinned by a test.
 *
 * `--no-install` avoids all of that because npx-cli.js special-cases it by name,
 * rewriting it to `--yes=false` before npm ever sees it.
 *
 * Position matters too: before the binary name. After it, the launcher forwards the flag
 * to the binary instead of consuming it.
 */
const NO_INSTALL_FLAG = '--no-install';

/**
 * Run a binary installed in the project's node_modules.
 *
 * `npx` for npm, `bunx` for bun. Not `node_modules/.bin/<bin>` directly, which was
 * the obvious-looking unification: those shims start with a `#!/usr/bin/env node`
 * shebang, so executing them requires node on PATH and defeats the point on a
 * machine that has bun and nothing else. `bunx` runs the same package under bun's
 * own runtime.
 *
 * `resolveProjectBinary` below does resolve those same shim paths, and that is not a
 * contradiction: it reads them for EXISTENCE only and never execs one, so the
 * invocation still goes through the launcher and the bun-only machine still works.
 */
export function binaryCommand(
  binary: string,
  args: readonly string[],
  selection: RunnerSelection
): ResolvedCommand {
  const launcher = selection.manager === 'bun' ? 'bunx' : 'npx';
  return resolved(launcher, [NO_INSTALL_FLAG, binary, ...args]);
}

/**
 * Shim spellings to look for in a `.bin` directory.
 *
 * The bare name is what npm's cmd-shim and bun both write on POSIX. The Windows
 * spellings are NOT verified -- this repo has no Windows CI and nothing else in it
 * branches on platform -- and they are here only because a bare-name-only check would
 * report every Windows project's binary absent and refuse a measurement that would have
 * worked. Guessing wide costs one `existsSync` per name; guessing narrow costs a whole
 * platform's worth of false failures.
 */
const WINDOWS_SHIM_SUFFIXES = ['.cmd', '.ps1', '.exe', '.bunx'] as const;

/**
 * Whether the project has the binary, and everywhere the search looked.
 *
 * A union rather than `string | undefined` so each outcome carries its own evidence.
 * The absent arm has to be able to tell a monorepo adopter WHICH parents were
 * consulted, or "eslint is not installed" reads as a lie to someone who can see it in
 * the root `node_modules`. `root-missing` is separate for the reason
 * `dimensions/custom.ts` checks a nonexistent cwd before classifying an ENOENT: a walk
 * over directories that are not there finds no binary anywhere, and "install eslint"
 * is confidently wrong advice for a mistyped `QUALITY_PROJECT_ROOT`.
 */
export type BinaryResolution =
  | { readonly kind: 'resolved'; readonly shimPath: string; readonly searched: readonly string[] }
  | { readonly kind: 'absent'; readonly searched: readonly string[] }
  | { readonly kind: 'root-missing'; readonly projectRoot: string };

/** projectRoot and every ancestor, outward, ending at the filesystem root. */
function ancestorDirectories(from: string): readonly string[] {
  const chain: string[] = [];
  let directory = path.resolve(from);

  // Terminates at the fixed point of `dirname` rather than at a depth limit, because
  // that is where the launchers stop too -- see resolveProjectBinary.
  for (;;) {
    chain.push(directory);
    const parent = path.dirname(directory);
    if (parent === directory) return chain;
    directory = parent;
  }
}

/**
 * Find the binary in the project's own node_modules, walking up as node does.
 *
 * The walk goes all the way to the filesystem root, and that is matched to MEASURED
 * launcher behaviour rather than chosen for tidiness. With a shim at
 * `<top>/node_modules/.bin/qgwalk47` and the cwd five directories below it -- crossing
 * an intermediate package.json with no node_modules AND a `.git` directory -- both
 * `npx --no-install qgwalk47` and `bunx --no-install qgwalk47` resolved and ran that
 * shim. A pre-flight stopping at the `.git` root, or at the first package.json, would
 * refuse a hoisted monorepo the launcher serves perfectly well: a false failure invented
 * by the guard, which is the class of error this repo has rejected designs for before.
 *
 * `existsSync`, which FOLLOWS symlinks, and that is the point rather than an accident.
 * Every `.bin` entry is a symlink (`eslint -> ../eslint/bin/eslint.js`), so a shim whose
 * package is gone -- a partial install, a pruned CI cache -- is a dangling link.
 * Verified both ways against a deliberately broken link: `lstatSync` reports it present,
 * `existsSync` correctly reports it absent.
 *
 * Does NOT check that package.json declares the package. A binary can legitimately come
 * from a parent workspace or a preset, and demanding a declaration would refuse layouts
 * that work. The claim made here is exactly "the launcher will find something local",
 * not "this project depends on it".
 */
export function resolveProjectBinary(
  projectRoot: string,
  binary: string,
  platform: NodeJS.Platform = process.platform
): BinaryResolution {
  if (!existsSync(projectRoot)) return { kind: 'root-missing', projectRoot };

  const suffixes = platform === 'win32' ? ['', ...WINDOWS_SHIM_SUFFIXES] : [''];
  const candidates = ancestorDirectories(projectRoot).flatMap((directory) =>
    suffixes.map((suffix) => path.join(directory, 'node_modules', '.bin', `${binary}${suffix}`))
  );

  const shimPath = candidates.find((candidate) => existsSync(candidate));
  return shimPath === undefined
    ? { kind: 'absent', searched: candidates }
    : {
        kind: 'resolved',
        shimPath,
        // Truncated at the hit, so the evidence describes the search that happened
        // rather than the one that would have happened without it.
        searched: candidates.slice(0, candidates.indexOf(shimPath) + 1),
      };
}

/**
 * A binary invocation: the command, plus whether the binary is actually there.
 *
 * The union is the guard. `binaryCommand` will build a launcher line for anything, and
 * a caller that spawns one for a binary the project lacks gets a NUMBER back rather
 * than a failure -- see the reproduction in the module comment. Handing back a tagged
 * value means the only route to a spawn is a branch that has already been told the shim
 * exists.
 *
 * Every arm carries `command`, because the failure message for a refusal has to name
 * the command that was NOT run -- the same shape as the typecheck provider's
 * missing-script refusal.
 */
export type BinaryInvocation =
  | { readonly kind: 'runnable'; readonly command: ResolvedCommand; readonly shimPath: string }
  | {
      readonly kind: 'absent';
      readonly command: ResolvedCommand;
      readonly searched: readonly string[];
    }
  | {
      readonly kind: 'root-missing';
      readonly command: ResolvedCommand;
      readonly projectRoot: string;
    };

/**
 * The command to run a project binary, refused unless the project actually has it.
 *
 * `projectRoot` is REQUIRED, with no default, for the reason
 * `MeasurementContext.packageManager` is: an optional one falling back to `cwd` would
 * let a call site silently resolve against a different tree than the one being measured.
 */
export function binaryInvocation(
  binary: string,
  args: readonly string[],
  selection: RunnerSelection,
  projectRoot: string
): BinaryInvocation {
  const command = binaryCommand(binary, args, selection);
  const resolution = resolveProjectBinary(projectRoot, binary);

  if (resolution.kind === 'resolved') {
    return { kind: 'runnable', command, shimPath: resolution.shimPath };
  }
  if (resolution.kind === 'root-missing') {
    return { kind: 'root-missing', command, projectRoot: resolution.projectRoot };
  }
  return { kind: 'absent', command, searched: resolution.searched };
}

/**
 * How to install a package as a devDependency, in the manager this project uses.
 *
 * Here rather than in a provider because it is manager knowledge, and a refusal that
 * tells a bun project to run `npm install` is the kind of not-quite-right advice that
 * makes an adopter stop reading the loud channel.
 *
 * pnpm and yarn are named HERE and nowhere else. `detectPackageManager` folds both into
 * the npm launcher path on purpose (see the module comment) and this does not change
 * that -- but `npm install --save-dev eslint` run in a pnpm tree drops a
 * package-lock.json and a hoisted node_modules into it, and advice that damages the
 * project is worse than no advice. The tool still spawns `npx`.
 *
 * Gated on there being NO lockfile this tool understands, so the advice can never
 * contradict the launcher standing next to it: a project carrying both a `bun.lock` and
 * a `pnpm-lock.yaml` is measured with `bunx`, and `pnpm add` would then be advice about
 * a different tree than the one that just refused.
 *
 * The Yarn PnP branch is first and is not about installing at all. A PnP tree has no
 * `node_modules/.bin` for the pre-flight to find, so a project that DECLARES eslint,
 * HAS it, and lints fine with `yarn exec eslint` still gets refused -- and telling it to
 * `yarn add -D eslint` is advice that changes nothing, so re-running produces the same
 * refusal forever. An unresolvable refusal is the false failure this repo rejects designs
 * for, so the remedy has to name the thing that actually changes the outcome: the linker.
 * Detected by `.pnp.cjs` (Yarn 3+) or `.pnp.js` (Yarn 2), which PnP installs write at the
 * project root. NOT verified against a real PnP tree -- yarn is not installed on this
 * machine -- so this is a message, never a measurement decision.
 */
export function installAdvice(
  binary: string,
  selection: RunnerSelection,
  projectRoot: string
): string {
  const present = (name: string) => existsSync(path.join(projectRoot, name));

  if (present('.pnp.cjs') || present('.pnp.js')) {
    return (
      'set `nodeLinker: node-modules` in .yarnrc.yml and re-run `yarn install` -- this ' +
      `tool resolves binaries through node_modules/.bin, which a Yarn PnP tree does not ` +
      `have, so ${binary} cannot be found there however it is installed`
    );
  }

  if (!LOCKFILES.some(([lockfile]) => present(lockfile))) {
    // pnpm before yarn: a yarn.lock surviving a migration to pnpm is a thing that
    // happens, the reverse is not -- the same reasoning that orders LOCKFILES.
    if (present('pnpm-lock.yaml')) {
      // pnpm REFUSES a bare `add` at the root of a workspace
      // (ERR_PNPM_ADDING_TO_ROOT), so the workspace file changes the advice rather
      // than decorating it.
      return present('pnpm-workspace.yaml')
        ? `pnpm add -D -w ${binary}`
        : `pnpm add -D ${binary}`;
    }
    if (present('yarn.lock')) return `yarn add -D ${binary}`;
  }

  return selection.manager === 'bun'
    ? `bun add --dev ${binary}`
    : `npm install --save-dev ${binary}`;
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

/**
 * How each launcher says it refused to install the binary this tool asked for.
 *
 * Both wordings captured by running them against a package that exists on the registry
 * and is not installed here:
 *   npm 12.0.2  -> `npm error npx canceled due to missing packages and no YES option:
 *                   ["cowsay@1.6.0"]`, exit 1
 *   bun 1.3.14  -> `error: Could not find an existing 'cowsay' binary to run. Stopping
 *                   because --no-install was passed.`, exit 1
 *
 * Like MISSING_SCRIPT_PATTERN this only ever LABELS a failure already established -- the
 * eslint provider consults it solely once it knows the run produced no report -- so a
 * reworded message costs a label and never a verdict.
 *
 * Deliberately does NOT match npm's E404, which is what npx prints when the name is not
 * a package at all (verified: `npx --no-install qgabsent47zz` gives `npm error code
 * E404`, not the cancel message). For `eslint` that means a broken registry or mirror,
 * not something an adopter fixes by installing a devDependency, so it stays
 * `unparseable-output` with the 404 in the stderr excerpt.
 */
export const NO_INSTALL_REFUSAL_PATTERN =
  /npx canceled due to missing packages|Stopping because --no-install was passed/i;
