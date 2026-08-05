/**
 * Custom Dimensions
 * =================
 * Support for user-defined metrics via script extractors.
 *
 * Users configure custom dimensions in quality-gate.config.ts:
 *
 * ```typescript
 * export const customDimensions: CustomDimensionConfig[] = [
 *   {
 *     path: 'custom.anyCount',
 *     displayName: 'TypeScript "any" Usage',
 *     description: 'Count of "any" type annotations',
 *     direction: 'lower-better',
 *     continuity: 'discrete',
 *     defaultWeight: 0.03,
 *     extractor: {
 *       type: 'script',
 *       command: 'grep -r "any" src/ --include="*.ts" | wc -l',
 *       // grep exits 1 when it matches nothing, and extractors run with
 *       // `pipefail`, so a genuine count of zero has to be declared as success.
 *       // See EXTRACTOR_SHELL for why pipefail is not optional.
 *       successExitCodes: [0, 1],
 *     }
 *   }
 * ];
 * ```
 *
 * WHERE THEY RUN. In the project root -- `config.projectRoot`, the same directory
 * every other dimension is measured against -- and not in whatever directory the CLI
 * was invoked from. So a relative path in a command (`src/`, `./marker.txt`) resolves
 * against the project, and the reading does not change with the caller's shell.
 *
 * If an extractor was written against the old behaviour, the failure to look for is
 * not a crash. A command whose paths are missing in the project root fails loudly, and
 * a failed extractor is a reported measurement failure. The quiet one is a command
 * whose paths exist in BOTH trees: `find . -name "*.ts" | wc -l` counts more files
 * from a repository root than from a package root, so a ceiling calibrated against one
 * number is now graded against another with nothing to say why. Prefer paths anchored
 * inside the project to `..` or to absolute paths outside it.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  buildEvidence,
  classifyProcessOutput,
  DEFAULT_MEASUREMENT_LIMITS,
  err,
  measurementFailure,
  ok,
} from '../providers/result.js';
import type {
  MeasurementDimension,
  MeasurementFailure,
  Result,
} from '../providers/types.js';
import { registerDimension, type DimensionDef, type DimensionDirection, type DimensionContinuity } from './registry.js';

// =============================================================================
// Types
// =============================================================================

export interface ScriptExtractor {
  type: 'script';
  /** Command to run (can use shell syntax) */
  command: string;
  /** How to parse the output (default: 'number' - extract first number from output) */
  parseOutput?: 'number' | 'json' | 'regex';
  /** JSONPath expression if parseOutput is 'json' (e.g., '$.summary.total') */
  jsonPath?: string;
  /** Regex pattern with capture group if parseOutput is 'regex' */
  regex?: string;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
  /**
   * Exit codes that mean the command ran and its output can be trusted
   * (default: `[0]`).
   *
   * Needed because a non-zero exit is now a gate failure rather than a silent
   * zero, and some perfectly good extractors exit non-zero by design:
   * `grep -c pattern file` exits 1 when the count is 0, and `diff` exits 1 when
   * files differ. Those used to throw and score 0, which happened to be the
   * right answer for grep and the wrong one for everything else.
   *
   * Declaring `[0, 1]` is strictly better than the obvious workaround of
   * appending `|| true` to the command: it keeps grep's exit 2 ("an actual
   * error") a failure, whereas `|| true` makes every failure invisible again.
   */
  successExitCodes?: readonly number[];
}

export interface CustomDimensionConfig {
  /** Must start with "custom." */
  path: string;
  /** Human-readable name */
  displayName: string;
  /** Description for MCP/LLM context */
  description?: string;
  /** Optimization direction */
  direction: DimensionDirection;
  /** SGD suitability */
  continuity?: DimensionContinuity;
  /** Weight for fitness function (default: 0.01) */
  defaultWeight?: number;
  /** How to extract the metric value */
  extractor: ScriptExtractor;
}

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Possible config file names, in order of preference.
 */
const CONFIG_FILE_NAMES = [
  'quality-gate.config.ts',
  'quality-gate.config.js',
  'quality-gate.config.mjs',
  'quality-gate.config.cjs',
];

/**
 * What a config file had to say about custom dimensions.
 *
 * The distinction is the point. "This file does not declare any" is an ordinary
 * state -- a config file may exist to hold other settings entirely. "This file
 * declares some and they could not be read" is a broken build. Both used to
 * produce an empty array.
 */
type ConfigLoad =
  | { readonly kind: 'declared'; readonly declared: readonly unknown[] }
  | { readonly kind: 'absent' };

/**
 * Load custom dimensions from the project's config file.
 * Returns an empty array if no config file exists.
 *
 * THROWS when a config file exists, declares custom dimensions, and they cannot
 * be read -- rather than returning the empty array it used to.
 *
 * Returning `[]` there was the quietest failure in this tool. `custom.*`
 * dimensions are gated by ceilings alone, and `evaluateCeilings` skips a metric
 * it cannot find without a word, so an unloadable config did not merely lose the
 * dimensions: it deleted every rule that referred to them and the gate went
 * green having enforced strictly less than it was configured to. A syntax error
 * in a config file became a weaker quality gate.
 *
 * Throwing rather than reporting a MeasurementFailure because this is not a
 * measurement that failed -- it is a tool that cannot be configured, and no
 * per-dimension reading exists to attach the failure to. `main()` in cli.ts
 * turns it into a message and exit 1.
 *
 * @param basePath - Directory to search for config file (default: cwd)
 */
export async function loadCustomDimensions(basePath?: string): Promise<CustomDimensionConfig[]> {
  const dir = basePath ?? process.cwd();

  for (const fileName of CONFIG_FILE_NAMES) {
    const configPath = resolve(dir, fileName);
    if (!existsSync(configPath)) continue;

    // For TypeScript files, we need to use dynamic import with tsx or ts-node
    // For JS files, we can import directly
    const loaded = fileName.endsWith('.ts')
      ? await loadTypeScriptConfig(configPath)
      : await loadModuleConfig(configPath);

    if (loaded.kind === 'declared') {
      return validateCustomDimensions(loaded.declared, configPath);
    }

    // Readable, and simply does not declare any. Try the next candidate name.
  }

  return [];
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Import a `.js` / `.mjs` / `.cjs` config.
 *
 * A failed import here is unambiguous -- node can execute these natively, so if
 * it will not load, it is broken.
 */
async function loadModuleConfig(configPath: string): Promise<ConfigLoad> {
  let configModule: { customDimensions?: unknown };

  try {
    // ES modules or CommonJS
    configModule = (await import(configPath)) as { customDimensions?: unknown };
  } catch (error) {
    throw new Error(
      `Failed to load quality gate config ${configPath}: ${describeCause(error)}. ` +
        'Refusing to continue as though it declared nothing -- that would silently drop every ' +
        'custom dimension it defines, and every ceiling that refers to them.'
    );
  }

  return asDeclared(configModule.customDimensions, configPath);
}

/**
 * Import a TypeScript config file.
 * Falls back to reading the file and extracting JSON if tsx/ts-node not available.
 */
async function loadTypeScriptConfig(configPath: string): Promise<ConfigLoad> {
  let imported: { customDimensions?: unknown } | undefined;
  let importError: unknown;

  try {
    // Try dynamic import (works under tsx/ts-node, and on a node new enough to
    // strip types natively)
    imported = (await import(configPath)) as { customDimensions?: unknown };
  } catch (error) {
    // NOT an error yet, and the one place the old swallow was right: a node
    // without TypeScript support cannot import this file at all, which says
    // nothing about whether the file is sound. Fall through to reading it as
    // text -- but keep the cause, because if the text fallback ALSO fails then
    // this was the real reason and "install tsx" would be a misdiagnosis.
    importError = error;
  }

  // Deliberately outside the try. `asDeclared` throws when the export is the
  // wrong shape, and having that inside meant the catch above swallowed it and
  // fell through to the text fallback -- so a config exporting
  // `customDimensions: {}` was diagnosed as a missing TypeScript loader.
  if (imported !== undefined) {
    return asDeclared(imported.customDimensions, configPath);
  }

  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Quality gate config ${configPath} exists but could not be read: ${describeCause(error)}.`
    );
  }

  // Checked textually rather than by whether the regex below matches, because
  // the regex is a heuristic and its failing is not evidence of absence. A file
  // that never mentions customDimensions is genuinely not declaring any.
  if (!content.includes('customDimensions')) {
    return { kind: 'absent' };
  }

  // This is a simple heuristic - will only work for literal arrays
  // For complex configs, users need tsx/ts-node
  const match = content.match(/export\s+const\s+customDimensions\s*[:=]\s*(\[[\s\S]*?\]);/);
  const arrayStr = match?.[1];

  if (arrayStr === undefined) {
    throw new Error(
      `Quality gate config ${configPath} mentions \`customDimensions\`, but this tool could not ` +
        'extract it. Install tsx or ts-node so the config can be imported properly, or move the ' +
        'dimensions into a .js config file. Continuing would drop every dimension it defines ' +
        `along with the ceilings that refer to them. Importing it failed with: ${describeCause(importError)}`
    );
  }

  // Try to evaluate as JSON (will fail for JS expressions)
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayStr) as unknown;
  } catch {
    throw new Error(
      `Quality gate config ${configPath} uses JavaScript expressions in \`customDimensions\`, ` +
        'which this tool can only read as literal JSON. Install tsx or ts-node for full support, ' +
        'or use a .js config file. Continuing would drop every dimension it defines along with ' +
        'the ceilings that refer to them.'
    );
  }

  return asDeclared(parsed, configPath);
}

function asDeclared(declared: unknown, configPath: string): ConfigLoad {
  if (declared === undefined || declared === null) {
    return { kind: 'absent' };
  }

  if (!Array.isArray(declared)) {
    throw new Error(
      `Quality gate config ${configPath} exports \`customDimensions\` as ${typeof declared}, ` +
        'but it has to be an array of dimension definitions.'
    );
  }

  return { kind: 'declared', declared };
}

/**
 * Validate and normalize custom dimension configs.
 *
 * Rejects the whole config rather than skipping the offending entry. Skipping
 * was the same hole as an unloadable file, one dimension at a time: a typo in
 * one definition removed its ceiling and the gate reported a pass for a rule it
 * had quietly stopped checking.
 */
function validateCustomDimensions(
  configs: readonly unknown[],
  configPath: string
): CustomDimensionConfig[] {
  const seen = new Set<string>();

  return configs.map((config, index) => {
    const at = `${configPath} custom dimension at index ${index}`;

    if (!isValidCustomDimensionConfig(config)) {
      throw new Error(
        `${at} is not a usable definition: ${JSON.stringify(config)}. Each one needs a \`path\`, ` +
          'a `displayName`, a `direction` of "higher-better" or "lower-better", and an ' +
          '`extractor` of `{type: "script", command: "..."}`.'
      );
    }

    if (!config.path.startsWith('custom.')) {
      throw new Error(
        `${at} has path '${config.path}', but custom dimension paths must start with "custom." ` +
          'so they cannot shadow a built-in dimension.'
      );
    }

    if (seen.has(config.path)) {
      throw new Error(
        `${at} repeats the path '${config.path}'. Only one of them would ever be measured, and ` +
          'which one is an accident of ordering.'
      );
    }
    seen.add(config.path);

    return {
      ...config,
      continuity: config.continuity ?? 'discrete',
      defaultWeight: config.defaultWeight ?? 0.01,
    };
  });
}

function isValidCustomDimensionConfig(config: unknown): config is CustomDimensionConfig {
  if (typeof config !== 'object' || config === null) return false;
  const c = config as Record<string, unknown>;

  return (
    typeof c.path === 'string' &&
    typeof c.displayName === 'string' &&
    (c.direction === 'higher-better' || c.direction === 'lower-better') &&
    typeof c.extractor === 'object' &&
    c.extractor !== null &&
    (c.extractor as { type?: string }).type === 'script' &&
    typeof (c.extractor as { command?: string }).command === 'string'
  );
}

// =============================================================================
// Metric Extraction
// =============================================================================

const DEFAULT_EXTRACTOR_TIMEOUT_MS = 30_000;

/**
 * Extractors run under bash with `pipefail`, not under `sh`.
 *
 * A shell pipeline reports only its LAST command's exit status, and the
 * documented extractor shape is a pipeline:
 *
 *     grep -r "any" src/ --include="*.ts" | wc -l
 *
 * Measured: `sh -c 'grep pattern missing-file | wc -l'` exits **0** and prints
 * **0**, because `wc` succeeded at counting nothing. Every check in this file
 * then passes it -- a clean exit and a parseable number -- and a lower-better
 * dimension records a perfect score for a search that never ran. That is the
 * original defect surviving inside the fix, reached through a pipe.
 *
 * `bash -c 'set -o pipefail; ...'` exits 2 for the same command.
 *
 * Consequence worth knowing before writing an extractor: pipefail also
 * propagates the BENIGN non-zero exits, and `grep` exiting 1 for "no matches"
 * is the common one. Declare `successExitCodes: [0, 1]` for those -- see
 * `ScriptExtractor.successExitCodes`.
 *
 * If bash is absent the spawn fails with ENOENT and the dimension reports
 * `tool-missing`, which is loud and wrong-sounding but not silent. Detecting
 * bash first and quietly degrading to `sh` was the alternative, and degrading
 * quietly into the exact false-pass above is not a trade worth making.
 */
const EXTRACTOR_SHELL = 'bash';
const PIPEFAIL_PREFIX = 'set -o pipefail; ';

/**
 * A string a human can paste into their own shell to get the same run.
 *
 * `MeasurementEvidenceBase.command` promises "the measurement as invoked, for
 * reproduction", and for this dimension it was neither: it carried
 * `extractor.command` verbatim, without the `set -o pipefail;` prefix and without the
 * directory. Both change the answer. Pipefail is why a broken pipeline stage is a
 * failure at all, and the working directory became load-bearing when extractors
 * stopped inheriting the caller's cwd (#26) -- so an adopter running the reported
 * command from their own shell could get a DIFFERENT result from the one the gate
 * reported, which is worse than no reproduction line, because it looks like the gate
 * was wrong.
 *
 * Single-quoted with `'` closed, escaped and reopened (`'\''`), which is the one
 * quoting that survives arbitrary content in `sh` and `bash` -- no expansion happens
 * inside single quotes, so nothing in a user's command can escape it. Verified to
 * round-trip through `bash -c`.
 */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function reproductionCommand(command: string, projectRoot: string): string {
  return `cd ${shellQuote(projectRoot)} && ${EXTRACTOR_SHELL} -c ${shellQuote(
    `${PIPEFAIL_PREFIX}${command}`
  )}`;
}

/**
 * A custom extractor is an arbitrary user command, so only a clean exit can be
 * assumed to mean it worked. Overridable per extractor -- see
 * `ScriptExtractor.successExitCodes`.
 */
const DEFAULT_SUCCESS_EXIT_CODES = [0] as const;

/** Enough output to diagnose a parse failure, not enough to flood the gate. */
const OUTPUT_EXCERPT_CHARS = 200;

function describeOutput(output: string): string {
  if (output.length === 0) return 'empty output';
  const excerpt = output.slice(0, OUTPUT_EXCERPT_CHARS);
  return `${JSON.stringify(excerpt)}${output.length > OUTPUT_EXCERPT_CHARS ? ' (truncated)' : ''}`;
}

/**
 * Which dimension a config names, for failure reporting.
 *
 * `validateCustomDimensions` rejects a path without the `custom.` prefix, so a
 * config arriving through the normal route always takes the first branch. The
 * fallback is for `extractCustomMetric` being called directly -- it is a public
 * export -- and yields a vague dimension rather than a false one.
 */
function dimensionOf(config: CustomDimensionConfig): MeasurementDimension {
  return config.path.startsWith('custom.') ? (config.path as `custom.${string}`) : 'custom';
}

/**
 * Extract a custom metric by running its extractor.
 *
 * Returns a failure rather than `0` when the command cannot run or its output
 * cannot be read. Zero was the wrong answer in the most dangerous possible
 * direction: `custom.*` dimensions are gated by ceilings and never by floors,
 * every `lower-better` dimension is at its BEST at zero, and a missing ceiling
 * metric is skipped in silence. So a broken extractor did not merely lose a
 * reading -- it reported a perfect score, and the more thoroughly the command
 * failed the better the project looked.
 *
 * @param config - Custom dimension config
 */
export function extractCustomMetric(
  config: CustomDimensionConfig,
  // The directory to run the extractor IN. Required rather than defaulted, because a
  // default is what the defect was: the command inherited whatever directory the CLI
  // was invoked from, so `wc -l < marker.txt` measured a different tree depending on
  // where the adopter happened to be standing. Every other dimension is measured
  // against `config.projectRoot`, and a reading that silently depends on the caller's
  // shell is not comparable with the ones that do not.
  //
  // A parameter rather than a `getConfig()` call inside, matching how the other
  // providers take a MeasurementContext: this is a public export and a library caller
  // may be measuring a directory that is not the singleton's project root.
  projectRoot: string
): Result<number, MeasurementFailure> {
  const extractor = config.extractor;
  const timeoutMs = extractor.timeout ?? DEFAULT_EXTRACTOR_TIMEOUT_MS;
  const maxBufferBytes = DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes;
  const dimension = dimensionOf(config);

  // Built once, and used for EVERY failure this function can return: the evidence
  // `command` is a reproduction instruction, so all of them have to be the same
  // instruction. See reproductionCommand.
  const reproduce = reproductionCommand(extractor.command, projectRoot);

  const startedAt = Date.now();
  // `shell: true` reproduces execSync's semantics, which the documented
  // examples depend on -- `grep -r ... | wc -l` is a pipeline, not a program.
  //
  // spawnSync rather than execSync so the run can be handed to the shared
  // classifier. execSync signals every distinct failure -- non-zero exit,
  // timeout kill, buffer overflow -- as one indistinguishable throw, and the
  // catch that used to receive it could do nothing better than guess.
  //
  // `cwd`, which used to be absent -- preserved from execSync rather than endorsed.
  // eslint and tsc are measured against `config.projectRoot` while custom extractors
  // were measured against whatever directory the CLI was invoked from, so two
  // dimensions in one reading could describe different trees.
  //
  // The failure mode that made this worth fixing is not the crash. An extractor whose
  // paths do not exist in the CLI's directory fails loudly now (a failed extractor is
  // a MeasurementFailure), and that is the easy case. The dangerous one is an
  // extractor whose paths exist in BOTH trees: `find . -name "*.ts" | wc -l` run from
  // a repository root instead of a package root returns a larger number, silently,
  // and a ceiling calibrated against the package then fails for a reason nothing
  // reports. Renumbering, not crashing, is the cost.
  const spawn = spawnSync(`${PIPEFAIL_PREFIX}${extractor.command}`, {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: timeoutMs,
    // execSync's default was 1 MiB, and overflow THROWS rather than truncating,
    // so a chatty extractor scored 0 on volume alone.
    maxBuffer: maxBufferBytes,
    shell: EXTRACTOR_SHELL,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const elapsedMs = Date.now() - startedAt;

  // A cwd that does not exist is an ENOENT from spawn with nothing to do with the
  // command, and the generic classifier below reads ENOENT as "`<command>` could not
  // be found" -- blaming a command that is fine and sending the reader off to debug
  // the wrong thing. Same reasoning as the missing-shell case below it, and checked
  // FIRST because it is the more specific claim.
  //
  // `QUALITY_PROJECT_ROOT` is named only when it is actually set: this function is a
  // public export whose root is a parameter, so pointing a library caller at an
  // environment variable they never used would be a false lead.
  if (
    (spawn.error as { code?: string } | undefined)?.code === 'ENOENT' &&
    !existsSync(projectRoot)
  ) {
    return err(
      measurementFailure(
        'crashed',
        dimension,
        'the extractor could not be run because its working directory does not exist: ' +
          `${projectRoot}. Custom extractors run in the project root, so that they ` +
          'measure the same tree every other dimension does' +
          `${process.env.QUALITY_PROJECT_ROOT ? ' (QUALITY_PROJECT_ROOT is set -- check it)' : ''}.`,
        buildEvidence(spawn, reproduce, elapsedMs)
      )
    );
  }

  // A missing SHELL and a missing COMMAND both end the run, need different
  // advice, and are cleanly distinguishable -- measured:
  //
  //   bash absent            -> spawn error ENOENT, status null
  //   command bash can't find -> no spawn error, status 127
  //
  // Worth separating because the generic classifier reads ENOENT as "`<command>`
  // could not be found", which for an absent bash blames a command that is
  // perfectly fine and sends the reader off to debug the wrong thing.
  if ((spawn.error as { code?: string } | undefined)?.code === 'ENOENT') {
    return err(
      measurementFailure(
        'tool-missing',
        dimension,
        `Custom extractors run under \`${EXTRACTOR_SHELL}\`, which is not installed or not on ` +
          `PATH, so ${config.path} could not be measured. The command itself may be fine. ` +
          `${EXTRACTOR_SHELL} is required because a plain POSIX shell cannot report a failing ` +
          'stage of a pipeline, and reading that as a successful measurement is the defect this ' +
          'whole path exists to prevent.',
        buildEvidence(spawn, reproduce, elapsedMs)
      )
    );
  }

  const classified = classifyProcessOutput(spawn, {
    command: reproduce,
    dimension,
    elapsedMs,
    timeoutMs,
    maxBufferBytes,
    successExitCodes: extractor.successExitCodes ?? DEFAULT_SUCCESS_EXIT_CODES,
  });

  if (!classified.ok) return classified;

  const parsed = parseOutput(classified.value.trim(), extractor);
  if (parsed.ok) return parsed;

  return err(
    measurementFailure(
      'unparseable-output',
      dimension,
      `the extractor ran, but its output could not be read as a value for ` +
        `${config.path}: ${parsed.error}. Re-run it with: ${reproduce}`,
      buildEvidence(spawn, reproduce, elapsedMs)
    )
  );
}

/**
 * Parse the output of a script extractor into a number, or say why not.
 *
 * Every branch that used to `return 0` now returns a reason. The old shape was
 * unable to distinguish "the command counted zero occurrences" from "the command
 * printed a stack trace", and reported both as zero.
 */
function parseOutput(output: string, extractor: ScriptExtractor): Result<number, string> {
  const mode = extractor.parseOutput ?? 'number';

  switch (mode) {
    case 'number': {
      const numMatch = output.match(/-?\d+\.?\d*/);
      if (!numMatch) {
        return err(`expected a number somewhere in the output, found none in ${describeOutput(output)}`);
      }
      return ok(parseFloat(numMatch[0]));
    }

    case 'json': {
      let json: unknown;
      try {
        json = JSON.parse(output) as unknown;
      } catch (error) {
        return err(
          `output is not valid JSON (${error instanceof Error ? error.message : String(error)}): ` +
            describeOutput(output)
        );
      }

      if (extractor.jsonPath === undefined) {
        return typeof json === 'number'
          ? ok(json)
          : err(
              'no jsonPath is configured, so the whole document has to be a number, and it is ' +
                `${json === null ? 'null' : typeof json}`
            );
      }

      const value = extractJsonPath(json, extractor.jsonPath);
      if (value === undefined) {
        return err(`jsonPath '${extractor.jsonPath}' matched nothing in ${describeOutput(output)}`);
      }
      return toNumber(value, `the value at jsonPath '${extractor.jsonPath}'`);
    }

    case 'regex': {
      if (extractor.regex === undefined || extractor.regex === '') {
        return err('parseOutput is "regex" but no regex pattern is configured');
      }

      let regex: RegExp;
      try {
        regex = new RegExp(extractor.regex);
      } catch (error) {
        return err(
          `regex pattern ${JSON.stringify(extractor.regex)} does not compile: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }

      const match = output.match(regex);
      if (!match) {
        return err(`regex ${JSON.stringify(extractor.regex)} matched nothing in ${describeOutput(output)}`);
      }
      if (match[1] === undefined) {
        return err(
          `regex ${JSON.stringify(extractor.regex)} matched, but has no capture group to read the ` +
            'value from -- wrap the number in parentheses'
        );
      }
      return toNumber(match[1], 'the regex capture group');
    }

    default:
      // Reachable despite the union: configs are loaded from a file, and
      // `isValidCustomDimensionConfig` does not check `parseOutput`. An
      // unrecognised mode used to score 0 for every commit thereafter.
      return err(`unknown parseOutput mode '${String(mode)}' -- expected 'number', 'json' or 'regex'`);
  }
}

/**
 * A JSON value or capture group as a number, or why it is not one.
 *
 * `Number` rather than `parseFloat`: parseFloat reads a leading number out of
 * arbitrary prose, so `"42 issues remaining"` became 42 and `"error"` became
 * NaN, which `|| 0` then turned into a perfect score. Only a string that is
 * ENTIRELY a number is accepted.
 *
 * The type check is explicit because `Number` is far too accommodating on its
 * own: `Number(null)`, `Number(false)` and `Number([])` are all 0, and
 * `Number('')` is 0 as well.
 */
function toNumber(value: unknown, description: string): Result<number, string> {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? ok(value) : err(`${description} is ${String(value)}`);
  }

  if (typeof value !== 'string') {
    return err(`${description} is ${value === null ? 'null' : typeof value}, not a number`);
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return err(`${description} is an empty string`);
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed)
    ? ok(parsed)
    : err(`${description} is ${JSON.stringify(value)}, which is not a number`);
}

/**
 * Simple JSONPath extractor for paths like "$.summary.total" or "summary.total".
 */
function extractJsonPath(obj: unknown, path: string): unknown {
  // Strip leading "$." if present
  const cleanPath = path.startsWith('$.') ? path.slice(2) : path;
  const parts = cleanPath.split('.');

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;

    // Handle array indexing like "items[0]"
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const index = parseInt(arrayMatch[2], 10);
      current = (current as Record<string, unknown>)[key];
      if (Array.isArray(current)) {
        current = current[index];
      } else {
        return undefined;
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register all custom dimensions from config.
 * Should be called early in the CLI lifecycle.
 *
 * @param basePath - Directory to search for config file
 */
export async function registerCustomDimensions(basePath?: string): Promise<CustomDimensionConfig[]> {
  const configs = await loadCustomDimensions(basePath);

  for (const config of configs) {
    const def: DimensionDef = {
      path: config.path,
      displayName: config.displayName,
      description: config.description ?? `Custom metric: ${config.displayName}`,
      unit: 'count',
      direction: config.direction,
      continuity: config.continuity ?? 'discrete',
      defaultWeight: config.defaultWeight ?? 0.01,
      category: 'custom',
    };

    try {
      registerDimension(def);
    } catch (error) {
      console.error(`Warning: Failed to register custom dimension ${config.path}:`, error);
    }
  }

  return configs;
}

/**
 * The readings that succeeded, and the failures for those that did not.
 *
 * Both halves are load-bearing and neither is sufficient. A failed dimension is
 * ABSENT from `metrics` rather than zero, which stops it satisfying a ceiling;
 * but absence alone is quiet, since `evaluateCeilings` skips a metric it cannot
 * find. The `failures` are what make it loud.
 */
export interface CustomMetricsReading {
  readonly metrics: Record<string, number>;
  readonly failures: readonly MeasurementFailure[];
}

/**
 * Extract all custom metrics.
 *
 * One broken extractor does not stop the others: a run that reports every
 * dimension it could measure alongside every dimension it could not is more
 * useful than one that stops at the first failure.
 *
 * @param configs - Custom dimension configs (from loadCustomDimensions)
 * @param projectRoot - The directory the extractors run in. See extractCustomMetric.
 */
export function extractAllCustomMetrics(
  configs: readonly CustomDimensionConfig[],
  projectRoot: string
): CustomMetricsReading {
  const metrics: Record<string, number> = {};
  const failures: MeasurementFailure[] = [];

  for (const config of configs) {
    const reading = extractCustomMetric(config, projectRoot);
    if (reading.ok) {
      metrics[config.path.replace('custom.', '')] = reading.value;
    } else {
      failures.push(reading.error);
    }
  }

  return { metrics, failures };
}
