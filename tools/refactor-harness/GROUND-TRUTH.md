# Ground truth: the synthetic subject

`synthetic-subject/` is a tiny TypeScript project broken in known, counted
ways. `verify-ground-truth.mjs` asserts the tool reads it exactly as designed
and **holds the numbers** — this file explains why each one is what it is.

## Why a second subject exists

The apollo-client golden baseline answers *"did this change alter what the tool
measures?"* That is a relative question, and its answer is the tool's own prior
output. It cannot answer *"is the measurement correct?"* — nothing self-derived
can. Two consequences drive the refactor:

**A replacement lint backend has no "before".** When biome replaces eslint, the
findings are differently named and differently counted by construction, so
differential testing against the golden baseline is not merely unreliable, it is
undefined. Only ground truth can validate it.

**apollo-client type-checks clean.** `typescript.errors` is `0` and
`issues.typescript` is empty, so `parseTypescriptOutput()` has never once run
against real tsc output. A refactor could break tsc parsing outright and the
golden comparison would still report ACCEPTED. `src/type-errors.ts` closes that
hole.

The two subjects are complements: Apollo is realistic but only self-relative;
the synthetic subject is artificial but externally correct. It also captures in
**~8s against Apollo's ~188s**, so it is the fast inner loop — Apollo stays the
final gate.

## What each file contributes

| file | purpose |
|---|---|
| `src/classify.ts` | Partially covered. Coverage strictly between 0% and 100% — a subject at either extreme cannot distinguish a working coverage adapter from one returning a constant. |
| `src/orphan.ts` | Imported by nothing. Negative control for `all: true`: without that flag it drops out of the denominator and every ratio silently flatters the subject. |
| `src/type-errors.ts` | Three tsc errors at three distinct codes. Exercises a parser the golden baseline never touches. |
| `src/lint-issues.ts` | Four rules at **both** severities. A subject reporting only errors cannot detect an adapter that drops warnings or reports them as errors. |

## The numbers, and where they come from

**ESLint — 2 errors, 4 warnings, 4 rules.** All in `lint-issues.ts`:
`eqeqeq` (error) on `a == b`, `prefer-const` (error) on `let sum`,
`no-explicit-any` (warning) ×2 on the two `any` parameters, `no-console`
(warning) ×2 on `console.log` and `console.warn`. Asserted by **rule ID and
severity**, not by count — a count-only check passes an adapter that keeps every
finding but reports all of them as errors.

**TypeScript — 3 errors, 3 codes.** TS2322 (number not assignable to string),
TS2554 (wrong argument count), TS2339 (property does not exist). Each is also
asserted to carry a valid line and column, so a parser that recovers the codes
but loses locations still fails.

**Coverage — 25% statements / 40% branches / 14.28% functions / 21.42% lines.**
Derived by hand rather than recorded from a run:

- *Branches, 4 of 10.* `classify` contributes 6 (two `if`s and a ternary),
  `neverCalled` 2, `orphaned` 2. Covered: both arms of `n < 0`, the false arm of
  `n === 0`, and the "odd" arm of the ternary.
- *Functions, 1 of 7.* `classify`, `neverCalled`, `orphaned`, `takesOne`,
  `logValue`, `looseEquals`, `total` — only `classify` is ever called.
- *Statements, 4 of 16.* `classify.ts` 6, `type-errors.ts` 4, `lint-issues.ts`
  5, `orphan.ts` 1; the 4 covered are all in `classify`.

Note istanbul reports a file with **no** branches as 100%, not 0% — which is why
`lint-issues.ts` and `type-errors.ts` show `branches: 100`. That is a reporting
convention, not coverage.

## Running it

```bash
node tools/refactor-harness/verify-ground-truth.mjs
```

Exit `0` ground truth holds, `1` a value drifted, `2` a dimension did not
measure at all. Requires `bun install` (or `npm install`) inside
`synthetic-subject/` first; `node_modules/` and `coverage/` are gitignored.

Negative controls confirmed: adding one lint violation, fixing one type error,
and breaking the eslint config are each detected — the last as VACUOUS rather
than as a false "0 findings", since a linter that cannot run must never be
mistaken for a clean project.

## Keeping it honest

If you change anything under `synthetic-subject/src/`, the expected values in
`verify-ground-truth.mjs` must be **re-derived from the source**, not copied
from the new run. Copying makes the check tautological: it would then assert
only that the tool agrees with itself, which is precisely the property the
golden baseline already provides and the reason this subject exists.
