# Refactor harness

Differential-testing rig for the provider refactor. It answers one question:
**did a change to this tool alter what it measures?**

It is deliberately *not* wired into the tool's own quality gate. The gate's
semantics are the subject under test here; using it to judge its own refactor
would collapse the independence that makes the answer worth anything.

## Why the liveness checks exist

A comparison that comes back "identical" proves nothing if neither side
measured anything. That is not hypothetical — it is this tool's dominant
failure mode:

```ts
const output = result.stdout || '[]';   // crash, timeout, or truncation
const results = JSON.parse(output);     // ...parses fine, yields zero findings
```

A linter that never ran reports `{errors: 0}`, which reads as a clean project.
The very first golden capture taken with this harness came back byte-identical
across two runs with **zero** eslint findings, because the subject's output had
crossed `spawnSync`'s 1 MiB `maxBuffer` and been truncated. Only the liveness
gate stopped that being recorded as a valid baseline.

So every dimension carries independent evidence that it actually ran — exit
status, output size, wall time, parse success — captured by a probe that does
not consult the tool's own reported counts. `stdoutBytes` and `elapsedMs` are
the load-bearing fields; a dimension reporting zero findings *and* no evidence
of work is `not-measured`, never `measured`.

## The scripts

| script | purpose | exit codes |
|---|---|---|
| `capture.mjs <tool-dir> <subject-dir> <out.json>` | Dump every pipeline layer raw and unsorted, plus liveness probes | — |
| `compare.mjs <a.json> <b.json>` | Is the tool reproducible? Separates ordering noise from content drift | 0 stable / 1 unstable / 2 vacuous |
| `verify-fixture.mjs [--write]` | Is the subject still the one the baseline was taken against? | 0 verified / 1 drifted |
| `accept-refactor.mjs <baseline.json> <candidate.json>` | Did the refactor preserve behaviour? | 0 accepted / 1 regression / 2 vacuous |

Captures are dumped **unsorted on purpose**. Sorting inside `capture.mjs` would
hide emission-order nondeterminism, which is one of the things being checked.

## Running it

```bash
node tools/refactor-harness/verify-fixture.mjs                     # subject unchanged?
node tools/refactor-harness/capture.mjs . ~/scratch/qg-fixtures/apollo-client cand.json
node tools/refactor-harness/accept-refactor.mjs \
     tools/refactor-harness/golden-A.json cand.json
```

Nothing may touch the subject while a capture runs — a concurrent lint or build
contaminates the reading.

## The frozen baseline

`golden-A.json` / `golden-B.json` are two byte-identical captures against
apollographql/apollo-client at `359f3e63`, pinned by `fixture-manifest.json`.

| dimension | baseline |
|---|---|
| eslint | 1038 findings across 5 rules — `{errors: 640, warnings: 398}` |
| coverage | 279 findings — 23.86% statements / 2.18% branches |
| typescript | 0 errors (measured, not absent) |
| sonarqube | ungated by decision; tripwire fires if it ever produces findings |

The subject's eslint config is **instrumented**, and must stay that way. Stock
Apollo emits 587 findings from a single rule at a single severity, and a
baseline containing no warnings cannot detect a lint adapter that drops or
misclassifies them — which is exactly the adapter the refactor introduces. Four
extra rules at mixed severities were added for that reason; `fixture-manifest.json`
hashes the config so the instrumentation cannot silently revert.

The subject itself is too large to vendor (793 MB with `node_modules`). It needs
three patches to be measurable at all: a `type-check` script alias (Apollo ships
`typecheck`), a stubbed `docs/public/canonical-references.json` (gitignored, so
no fresh clone can lint), and removal of a git-protocol devDependency.

## Judging lint

`accept-refactor.mjs` keys lint findings by **rule ID + severity**, not
`file:line`. A refactor moves code; a position-keyed comparison would report
that movement as regression and bury the real signal.

Losses fail. Additions are surfaced for review rather than failed, since a
refactor that finds *more* has not lost coverage of the subject — but it has
changed behaviour and someone should look.

`tool-lint-baseline.json` is a separate record of *this repo's own* lint state,
used to check that refactor commits do not introduce new errors. It is not part
of the golden comparison.
