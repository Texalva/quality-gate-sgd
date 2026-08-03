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
import type { TypecheckProvider } from './types.js';
export declare const typescriptTypecheckProvider: TypecheckProvider;
//# sourceMappingURL=typescript.d.ts.map