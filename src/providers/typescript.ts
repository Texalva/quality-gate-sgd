/**
 * TypeScript Typecheck Provider
 * =============================
 * The existing type-check extraction, moved behind TypecheckProvider.
 *
 * Structurally the same move as the eslint provider, but the failure surface it
 * closes is worse. eslint at least emits JSON, so a broken run usually fails to
 * parse. Type-check output is REGEX-SCANNED, so there is no parse step to fail:
 * a crashed, killed, or missing type-check produces no `error TS` lines, the
 * scan finds nothing, and `{errors: 0}` reads as a perfectly clean project.
 * Both call sites did exactly that, with no exit-code check at all.
 *
 * Fidelity details preserved from the two implementations this replaces:
 *
 *   - The error TOTAL is `max(strictly parsed, loose 'error TSnnnn' matches)`,
 *     not the length of the issue list. tsc emits global diagnostics with no
 *     file/line prefix (TS18003 "No inputs were found", for one), and `--pretty`
 *     output puts the location on its own line in a shape the located regex
 *     cannot read. Those are real errors the issue list cannot represent, so the
 *     count and the list legitimately disagree and each is taken from where it
 *     is accurate.
 *
 *   - Root causes are distinct (file, code) pairs from the strictly parsed
 *     errors only, since a diagnostic with no file cannot be attributed to one.
 */

import { spawnSync } from 'child_process';
import path from 'path';

import type { LocatedIssue } from '../targets/types.js';
import type { TypescriptMetrics } from '../types.js';

import {
  MISSING_SCRIPT_PATTERN,
  PACKAGE_MANAGER_ENV_VAR,
  scriptCommand,
  TYPECHECK_SCRIPT_ENV_VAR,
} from '../runner.js';

import { buildEvidence, classifyProcessOutput, err, measurementFailure, ok } from './result.js';
import type {
  MeasurementContext,
  MeasurementFailure,
  Result,
  TypecheckProvider,
  TypecheckReading,
} from './types.js';

interface TypeScriptError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}


/**
 * Exit codes that mean "the type-check ran"; anything else means it did not.
 *
 * tsc's ExitStatus enum is 0 Success, 1 DiagnosticsPresent_OutputsSkipped,
 * 2 DiagnosticsPresent_OutputsGenerated, 3 InvalidProject_OutputsSkipped,
 * 4 ProjectReferenceCycle_OutputsSkipped.
 *
 * Verified against tsc 5, because the names alone are misleading: a plain
 * `tsc --noEmit` with type errors exits **2**, not 1, and exit 1 in practice
 * comes from CLI-level failures such as TS5023 "Unknown compiler option". Both
 * are admitted anyway -- exit 1 still emits a diagnostic, so it is counted and
 * fails the gate loudly, which is the right outcome for a broken invocation.
 *
 * 3 and 4 mean the project could not be built as configured, which is not a
 * measurement of it.
 */
const TYPECHECK_SUCCESS_EXIT_CODES = [0, 1, 2] as const;

/**
 * tsc colourises when it thinks it is on a terminal, and `--pretty` forces it
 * even through a pipe. The escape sequences land *between* "error" and the code
 * (`error\x1b[0m\x1b[90m TS2322`), so both scans below silently match nothing
 * against pretty output -- verified. Stripping first is what makes the loose
 * count honest for such a project.
 */
const ANSI_ESCAPE = /\[[0-9;]*m/g;

function parseTypescriptErrors(output: string): TypeScriptError[] {
  // Declared here rather than module-scope: /g regexes carry a mutable
  // lastIndex, and a fresh one per call cannot leak state between measurements
  // however this loop is later edited.
  const locatedDiagnostic = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
  const errors: TypeScriptError[] = [];

  let match;
  while ((match = locatedDiagnostic.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      code: match[4],
      message: match[5],
    });
  }

  return errors;
}

/**
 * How many diagnostics the run reported, located or not.
 *
 * Deliberately looser than the parse above: it catches the global diagnostics
 * that carry no file at all (TS18003 "No inputs were found", TS5023 "Unknown
 * compiler option"), and pretty-printed ones whose location sits on a separate
 * line in a format the located regex cannot read. Used to decide whether the
 * run produced diagnostics and to total them -- never to locate one.
 */
function countDiagnostics(output: string): number {
  return (output.replace(ANSI_ESCAPE, '').match(/error TS\d+/g) ?? []).length;
}

/**
 * Distinct (file, code) pairs.
 *
 * Cascading errors share a code within a file -- one missing property raises
 * TS2339 at every access -- so this counts things to fix rather than symptoms.
 */
function countRootCauses(errors: TypeScriptError[]): number {
  return new Set(errors.map((e) => `${e.file}:${e.code}`)).size;
}

function toIssues(errors: TypeScriptError[]): LocatedIssue[] {
  return errors.map((error): LocatedIssue => ({
    file: error.file,
    line: error.line,
    column: error.column,
    source: 'typescript',
    dimension: 'typescript.errors',
    code: error.code,
    impact: {
      dimension: 'typescript.errors',
      delta: -1,
      direction: 'lower-better',
    },
    message: error.message,
    context: `${error.code}: ${error.message}`,
  }));
}

export const typescriptTypecheckProvider: TypecheckProvider = {
  name: 'tsc',
  dimension: 'typescript',

  measure(context: MeasurementContext): Result<TypecheckReading, MeasurementFailure> {
    const { script, definedInManifest } = context.typecheckScript;
    const command = scriptCommand(script, context.packageManager);

    // Refused BEFORE spawning, and that ordering is the whole point. `bun run <name>`
    // does not fail on a missing script -- it falls through to a same-named binary in
    // node_modules/.bin, which for a `type-check` shim that prints nothing and exits 0
    // yields a genuine exit 0 with genuine empty output. The corroboration check below
    // cannot distinguish that from a clean project, because nothing about it is a
    // failure at the process level; something really did run successfully. It just was
    // not the project's type-check. Reproduced against bun 1.3.14.
    if (!definedInManifest) {
      return err(
        measurementFailure(
          'tool-missing',
          'typescript',
          `\`${command.display}\` was not run: package.json defines no \`${script}\` script, so ` +
            'there is nothing to type-check with. A configuration failure, not a clean project. ' +
            `That script was chosen because ${context.typecheckScript.reason} -- set ` +
            `${TYPECHECK_SCRIPT_ENV_VAR} to name the right one.`,
          // `via: 'report'` because this failure was established by READING the
          // manifest, not by running anything -- there is no exit code or byte count
          // to report, and claiming process evidence for a spawn that never happened
          // would be a lie in the one field an investigator trusts.
          {
            via: 'report',
            command: command.display,
            elapsedMs: 0,
            attempts: [
              {
                path: path.join(context.projectRoot, 'package.json'),
                existed: definedInManifest,
                bytesRead: null,
                modifiedMs: null,
                outcome: 'absent',
              },
            ],
          }
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

    const classified = classifyProcessOutput(spawn, {
      command: command.display,
      dimension: 'typescript',
      elapsedMs,
      timeoutMs: context.timeoutMs,
      maxBufferBytes: context.maxBufferBytes,
      successExitCodes: TYPECHECK_SUCCESS_EXIT_CODES,
    });

    if (!classified.ok) return classified;

    // Diagnostics land on stdout, npm's banner on stderr, and a wrapper script's
    // own complaints on either. Both are scanned, as they were before.
    const combined = (spawn.stdout ?? '') + (spawn.stderr ?? '');
    const errors = parseTypescriptErrors(combined);
    const diagnosticCount = countDiagnostics(combined);

    // The exit code and the output have to corroborate each other. A non-zero
    // exit means tsc says it found problems; finding none in the text means the
    // problems were not tsc's -- a missing binary, an OOM kill inside a wrapper,
    // a shell error. Reporting zero errors for that is the vacuous pass.
    //
    // The converse is deliberately NOT checked, and that leaves a real residual
    // worth naming rather than glossing:
    //
    //   A `type-check` script written as `tsc --noEmit || true` exits 0 with
    //   diagnostics, and the diagnostics are still correct, so counting them is
    //   right. But the same script exits 0 having emitted NOTHING when tsc is
    //   OOM-killed -- and so does `npm run --if-present` with no such script.
    //   Both look identical to a genuinely clean project from in here.
    //
    // No exit code, byte count, or output shape separates them, and inventing a
    // wall-time heuristic would be the provider vouching for itself, which the
    // MeasurementProvider contract explicitly rules out: a provider broken
    // enough to return nothing is broken enough to claim it ran. The harness's
    // liveness probe re-runs the tool from outside for exactly this reason, and
    // that is where the check belongs.
    if (spawn.status !== 0 && diagnosticCount === 0) {
      const missingScript = MISSING_SCRIPT_PATTERN.test(combined);
      return err(
        measurementFailure(
          missingScript ? 'tool-missing' : 'crashed',
          'typescript',
          missingScript
            ? `\`${command.display}\` cannot run: no \`${script}\` script is defined, so nothing ` +
              'was type-checked. A configuration failure, not a clean project. That script was ' +
              `chosen because ${context.typecheckScript.reason} -- set ` +
              `${TYPECHECK_SCRIPT_ENV_VAR} to name the right one. The runner was chosen because ` +
              `${context.packageManager.reason}; if that is the wrong package manager for this ` +
              `project, set ${PACKAGE_MANAGER_ENV_VAR}.`
            : `\`${command.display}\` exited ${spawn.status} but emitted no TypeScript ` +
              'diagnostics at all. Something other than a type error ended the run, and its ' +
              'output cannot be read as a measurement of zero errors.',
          buildEvidence(spawn, command.display, elapsedMs)
        )
      );
    }

    const metrics: TypescriptMetrics = {
      errors: Math.max(errors.length, diagnosticCount),
      warnings: 0, // tsc has no warning severity.
      rootCauses: countRootCauses(errors),
    };

    return ok({ metrics, issues: toIssues(errors) });
  },
};
