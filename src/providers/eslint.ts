/**
 * ESLint Lint Provider
 * ====================
 * The existing eslint extraction, moved behind LintProvider unchanged.
 *
 * This is a structural change only. The parsing below is deliberately
 * identical to what previously lived in metrics.ts and targets/extract.ts,
 * including the parts that look redundant, because the whole point of this
 * step is that the frozen apollo-client baseline still reports ACCEPTED
 * afterwards. Improvements belong in later steps where their diffs can be
 * reviewed on their own.
 *
 * The PARSING is still that untouched move. The INVOCATION is not: the pre-flight
 * refusal and the launcher-refusal relabelling below were added later, for backlog #47,
 * and are the one part of this file that is not like-for-like.
 *
 * Two fidelity details worth naming, since both look like things to tidy up:
 *
 *   - Totals come from eslint's own `errorCount`/`warningCount` per file, NOT
 *     from counting `messages`. Those can differ -- fatal parse errors bump the
 *     count without producing an ordinary message -- so deriving one from the
 *     other would quietly change the numbers.
 *
 *   - `|| '[]'` on empty stdout is preserved. It is half of the original
 *     silent-failure bug and step 6 removes it; it survives here only because
 *     classifyProcessOutput now catches the dangerous cases (a dead, killed,
 *     or truncated process) before parsing is ever reached.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

import {
  binaryInvocation,
  installAdvice,
  NO_INSTALL_REFUSAL_PATTERN,
  PACKAGE_MANAGER_ENV_VAR,
} from '../runner.js';
import type { LocatedIssue } from '../targets/types.js';
import type { EslintMetrics } from '../types.js';

import { buildEvidence, classifyProcessOutput, err, measurementFailure, ok } from './result.js';
import type {
  LintProvider,
  LintReading,
  MeasurementContext,
  MeasurementFailure,
  ReportEvidence,
  Result,
} from './types.js';

/** One finding, as emitted by `eslint --format json`. */
export interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/** One file's worth of findings, as emitted by `eslint --format json`. */
export interface EslintFileResult {
  filePath: string;
  errorCount: number;
  warningCount: number;
  messages: EslintMessage[];
}

/**
 * `src/` is hardcoded on purpose -- see src/layout.ts. It is how a project says
 * which code the ratchet governs, and `assertSupportedLayout` refuses to run
 * against a project laid out otherwise rather than letting this lint a subset.
 */
const ESLINT_ARGS = ['--format', 'json', 'src/'] as const;

/**
 * Config filenames that mean "this project intends to be linted by eslint".
 *
 * Read for ONE purpose: to word a refusal. When the binary is missing, a project with a
 * config is one install away from being measurable, and a project with neither has
 * nothing here to measure at all -- and telling a Biome or oxlint project to install a
 * linter it rejected on purpose is exactly the not-quite-right advice that trains an
 * adopter to stop reading the loud channel.
 *
 * Duplicated from the eslint entries in MEASUREMENT_INPUTS rather than derived from
 * them, because the two lists answer different questions: that one is the cache
 * identity, where ADDING a name changes every stored verdict, and this one is a
 * message. Importing it would also drag the config module into a provider.
 *
 * Root-level only, and deliberately does not read package.json's legacy `eslintConfig`
 * field -- so the message says which paths were looked at rather than claiming the
 * project has no config anywhere.
 */
const ESLINT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yml',
  '.eslintrc.yaml',
] as const;

/** eslint's own severity encoding: 2 is an error, 1 a warning, 0 disabled. */
const SEVERITY_ERROR = 2;

/**
 * 0 is clean and 1 means findings -- both are successful measurements. 2 means
 * the eslint command itself failed, and its report must not be read as one.
 *
 * The common shape is a broken config: eslint exits 2 having linted nothing and
 * printing NO stdout, which the old code turned into `[]` and reported as a
 * clean project satisfying an `eslint.errors: 0` ceiling. Verified against a
 * deliberately malformed config.
 *
 * Exit 2 does not always mean empty output, though -- eslint prints results
 * before some post-run checks, so a stale-suppressions failure can emit a
 * complete report and still exit 2. Refusing it is still right (eslint is
 * saying the run was not valid), which is why the diagnosis below talks about
 * a failed run rather than claiming nothing was produced.
 */
const ESLINT_SUCCESS_EXIT_CODES = [0, 1] as const;

/**
 * eslint's JSON is an array of per-file objects, each carrying numeric counts
 * and a `messages` array of objects with numeric severities.
 *
 * Validated rather than asserted because parse and iteration used to share one
 * try/catch, so a well-formed-JSON-but-wrong-shape payload landed on the
 * failure path; guarding only the parse let a TypeError escape `measure()`.
 *
 * EVERY field the code below reads is checked, not just the outer shape. A
 * shallower version of this function still admitted three defects:
 *
 *   - `messages: [null]` passed, then threw on `msg.severity`.
 *   - Absent `errorCount` silently became 0 via `|| 0`, so a malformed report
 *     read as a clean one.
 *   - `errorCount: "7"` made `errors` the STRING "07" by concatenation, which
 *     rules.ts then rejected as non-numeric and skipped -- and a skipped
 *     ceiling passes. A wrong type became a green build.
 */
function asEslintResults(parsed: unknown): EslintFileResult[] | null {
  if (!Array.isArray(parsed)) return null;

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return null;

    const file = entry as Partial<EslintFileResult>;
    if (!Number.isFinite(file.errorCount) || !Number.isFinite(file.warningCount)) return null;
    if (!Array.isArray(file.messages)) return null;

    for (const msg of file.messages) {
      if (typeof msg !== 'object' || msg === null) return null;
      // Severity decides error-vs-warning for both the counts and the issue
      // list; a non-number silently classifies everything as a warning.
      if (!Number.isFinite((msg as Partial<EslintMessage>).severity)) return null;
    }
  }

  return parsed as EslintFileResult[];
}

/**
 * Distinct (file, rule) pairs among errors only.
 *
 * Warnings are excluded and this is not a message count: twelve instances of
 * one rule in one file are one thing to fix, and the gate uses this to reward
 * fixing causes rather than symptoms.
 */
function countRootCauses(results: EslintFileResult[]): number {
  const rootCauses = new Set<string>();

  for (const fileResult of results) {
    for (const msg of fileResult.messages) {
      if (msg.severity === SEVERITY_ERROR && msg.ruleId) {
        rootCauses.add(`${fileResult.filePath}:${msg.ruleId}`);
      }
    }
  }

  return rootCauses.size;
}

function toMetrics(results: EslintFileResult[]): EslintMetrics {
  let errors = 0;
  let warnings = 0;

  for (const r of results) {
    errors += r.errorCount || 0;
    warnings += r.warningCount || 0;
  }

  return { errors, warnings, rootCauses: countRootCauses(results) };
}

function toIssues(results: EslintFileResult[]): LocatedIssue[] {
  const issues: LocatedIssue[] = [];

  for (const fileResult of results) {
    for (const msg of fileResult.messages) {
      const isError = msg.severity === SEVERITY_ERROR;
      const dimension = isError ? 'eslint.errors' : 'eslint.warnings';

      issues.push({
        file: fileResult.filePath,
        line: msg.line,
        column: msg.column,
        endLine: msg.endLine,
        endColumn: msg.endColumn,
        source: 'eslint',
        dimension,
        code: msg.ruleId || 'unknown',
        severity: isError ? 'major' : 'minor',
        impact: {
          dimension,
          delta: -1,
          direction: 'lower-better',
        },
        message: msg.message,
        context: msg.ruleId ? `Rule: ${msg.ruleId}` : undefined,
      });
    }
  }

  return issues;
}

export const eslintLintProvider: LintProvider = {
  name: 'eslint',
  dimension: 'eslint',

  measure(context: MeasurementContext): Result<LintReading, MeasurementFailure> {
    const invocation = binaryInvocation(
      'eslint',
      ESLINT_ARGS,
      context.packageManager,
      context.projectRoot
    );
    const command = invocation.command;
    const launcher = command.executable;

    // Both refusals below happen BEFORE the spawn, for the same reason the typecheck
    // provider refuses a script package.json does not define: the launcher does not FAIL
    // on an absent binary, it SUBSTITUTES one. Reproduced in a directory holding nothing
    // but a package.json, an eslint.config.mjs and src/a.js, with no eslint installed
    // anywhere above it:
    //
    //   npx eslint --format json src/               -> exit 0, complete per-file report,
    //                                                  errorCount 0, from eslint v10.8.1
    //   npx --no-install eslint --format json src/  -> exit 0, the SAME clean report
    //   bunx --no-install eslint --format json src/ -> exit 0, the SAME clean report
    //
    // Nothing at the process level is wrong there: something genuinely ran, exited 0 and
    // emitted a well-formed report. It just was not this project's linter -- v10.8.1 came
    // out of ~/.npm/_npx/<hash> and /tmp/bunx-<uid>-eslint@latest, which `--no-install`
    // does not disable. So the flag is the belt and this check is the fix.
    //
    // A nonexistent project root is separated out first because it is the more specific
    // claim, the same ordering `dimensions/custom.ts` uses for a nonexistent cwd. A walk
    // over directories that are not there finds no eslint anywhere, and "install eslint"
    // is confidently wrong advice for a mistyped path.
    if (invocation.kind === 'root-missing') {
      return err(
        measurementFailure(
          'tool-missing',
          'eslint',
          `\`${command.display}\` was not run: the project root does not exist -- ` +
            `${invocation.projectRoot}. Every dimension is measured in that directory, so ` +
            'there is no tree here to look for eslint in, and nothing about this project ' +
            'could be read' +
            `${process.env.QUALITY_PROJECT_ROOT ? ' (QUALITY_PROJECT_ROOT is set -- check it)' : ''}` +
            '. Reported as a configuration failure rather than as a missing eslint, because ' +
            'installing eslint would not fix a path that is not there.',
          {
            via: 'report',
            command: command.display,
            elapsedMs: 0,
            attempts: [
              {
                path: invocation.projectRoot,
                existed: false,
                bytesRead: null,
                modifiedMs: null,
                outcome: 'absent',
              },
            ],
          }
        )
      );
    }

    if (invocation.kind === 'absent') {
      const configured = ESLINT_CONFIG_FILES.some((name) =>
        existsSync(path.join(context.projectRoot, name))
      );
      const remedy = installAdvice('eslint', context.packageManager, context.projectRoot);

      // `via: 'report'` for the reason the typecheck provider gives: this failure was
      // established by READING the filesystem, and claiming an exit code for a spawn that
      // never happened would be a lie in the one field an investigator trusts.
      //
      // Every candidate is listed rather than capped. The whole point of walking up is
      // that a monorepo adopter has to be able to see WHICH parents were consulted, and a
      // truncated list is exactly the evidence that makes "eslint is not installed" read
      // as a lie to someone looking at a root node_modules.
      const searchEvidence: ReportEvidence = {
        via: 'report',
        command: command.display,
        elapsedMs: 0,
        attempts: invocation.searched.map((candidate) => ({
          path: candidate,
          existed: false,
          bytesRead: null,
          modifiedMs: null,
          outcome: 'absent' as const,
        })),
      };

      return err(
        measurementFailure(
          'tool-missing',
          'eslint',
          `\`${command.display}\` was not run: this project has no eslint of its own. Looked ` +
            `for \`node_modules/.bin/eslint\` in ${context.projectRoot} and in every parent ` +
            `directory up to the filesystem root -- ${invocation.searched.length} candidate ` +
            `path(s) -- and found none. ` +
            (configured
              ? `It does have an eslint config, so it is one step from measurable: ${remedy}.`
              : `It has no eslint config either (looked for ` +
                `${ESLINT_CONFIG_FILES.join(', ')} in the project root), so there is nothing ` +
                `here for the eslint dimension to measure. That does not fail the gate unless ` +
                `rules.json actually grades \`eslint.*\` -- but it IS reported every run and it ` +
                `stops the run being cached, and this tool has no way to switch the eslint ` +
                `dimension off, so for a project that lints with something else that noise is ` +
                `the standing cost. If it should lint with eslint, add a config, then: ` +
                `${remedy}.`) +
            ` Refusing rather than measuring: left to itself \`${launcher}\` answers a missing ` +
            `linter by supplying one from the registry or from its own machine-global cache, ` +
            `and a finding count from an eslint this project does not use is not a measurement ` +
            `of this project. Binaries are resolved through node_modules/.bin only, so a Yarn ` +
            `PnP tree has none for this to find however eslint is installed there. The launcher ` +
            `was chosen because ${context.packageManager.reason}; set ${PACKAGE_MANAGER_ENV_VAR} ` +
            `to npm or bun if that is the wrong one here (those are the only two this tool ` +
            `spawns).`,
          searchEvidence
        )
      );
    }

    const startedAt = Date.now();
    const spawn = spawnSync(command.executable, [...command.args], {
      cwd: context.projectRoot,
      encoding: 'utf-8',
      shell: true,
      timeout: context.timeoutMs,
      maxBuffer: context.maxBufferBytes,
    });
    const elapsedMs = Date.now() - startedAt;

    const output = classifyProcessOutput(spawn, {
      command: command.display,
      dimension: 'eslint',
      elapsedMs,
      timeoutMs: context.timeoutMs,
      maxBufferBytes: context.maxBufferBytes,
      successExitCodes: ESLINT_SUCCESS_EXIT_CODES,
    });

    if (!output.ok) return output;

    const unparseable = (detail: string) =>
      err(
        measurementFailure(
          'unparseable-output',
          'eslint',
          `\`${command.display}\` ${detail}, so no finding count can be derived from it.`,
          buildEvidence(spawn, command.display, elapsedMs)
        )
      );

    // No `|| '[]'` fallback. eslint's JSON formatter is literally
    // `JSON.stringify(results)`, and even a wholly clean project emits a full
    // per-file report -- so empty stdout is never a legitimate zero-finding
    // result, only a run that produced nothing. The old fallback turned exactly
    // that case into a clean bill of health.
    if (output.value.trim() === '') {
      // Both launchers refuse with exit **1**, which is inside ESLINT_SUCCESS_EXIT_CODES
      // because 1 is also how eslint reports findings -- so no exit-code check can catch
      // this and the run lands here, one step from being called a formatter problem.
      //
      // The pre-flight above found a shim, so reaching this means either the shim vanished
      // between the check and the exec, or the launcher does not resolve from where this
      // tool looked. Naming the shim it DID find is the whole diagnostic value.
      //
      // Kept inside the empty-stdout guard on purpose, not hoisted above it: a future
      // launcher that prints its refusal while ALSO emitting something on stdout should
      // fall through to the ordinary parse rather than let this pattern relabel a real
      // report. That is loud either way; the ordering is what keeps it from being wrong.
      if (NO_INSTALL_REFUSAL_PATTERN.test(spawn.stderr ?? '')) {
        return err(
          measurementFailure(
            'tool-missing',
            'eslint',
            `\`${command.display}\` linted nothing: ${launcher} refused to run eslint because it ` +
              `could not find one it was allowed to use, and this tool passes \`--no-install\` so ` +
              `it will not download one. This tool DID find a shim at ${invocation.shimPath} ` +
              `before spawning, so either it disappeared mid-run or it is not one ${launcher} ` +
              `resolves from ${context.projectRoot}. Re-install this project's dependencies, or: ` +
              `${installAdvice('eslint', context.packageManager, context.projectRoot)}.`,
            buildEvidence(spawn, command.display, elapsedMs)
          )
        );
      }

      return unparseable('produced no output at all, though eslint always emits a JSON report');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(output.value);
    } catch {
      return unparseable('produced output that is not valid JSON');
    }

    const results = asEslintResults(parsed);
    if (results === null) {
      return unparseable('produced valid JSON that is not an eslint report');
    }

    return ok({ metrics: toMetrics(results), issues: toIssues(results) });
  },
};
