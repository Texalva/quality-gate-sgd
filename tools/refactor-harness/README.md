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
| `verify-gate.mjs [--verbose]` | Is `accept-refactor.mjs` still capable of rejecting? | 0 verified / 1 too weak |
| `verify-ground-truth.mjs [tool-dir]` | Are the numbers *correct*, against hand-derived expectations? | 0 ok / 1 violated / 2 vacuous |
| `verify-vacuous-pass.mjs [tool-dir]` | When a measurement genuinely breaks, does the gate say so? | 0 all caught / 1 a break passed |

Captures are dumped **unsorted on purpose**. Sorting inside `capture.mjs` would
hide emission-order nondeterminism, which is one of the things being checked.

`capture.mjs` refuses to run when `src/` is newer than `dist/`. It imports the
compiled output, so without that check, editing a provider and forgetting
`npm run build` produced a candidate that ran the *previous* implementation and
was duly ACCEPTED — the harness certifying code it never executed.

Every capture records the SHA-256 of `capture.mjs` itself. Two captures taken by
different versions of the instrument are refused as *vacuous* rather than
compared, because their differences belong to the instrument and not to the tool
under test. Editing `capture.mjs` — including its comments — therefore obliges a
re-capture of the golden. That is cheap, and the alternative is deciding by eye
which edits could have moved a reading.

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

## Judging a candidate

**The bar is byte-identity.** The subject is frozen and the tool is
deterministic against it, so exact equality is not an aspiration — it is the
demonstrated normal state, and any deviation is a behaviour change that needs
explaining. `accept-refactor.mjs` compares every section of the capture except
`liveness` (meta-evidence, inherently timing-noisy) and `captureSha` (checked as
a precondition instead).

It also cross-checks the tool's own finding counts against the liveness probe's
independent counts, **on both captures**. That check exists for the case section
comparison structurally cannot cover: once a broken reading is adopted *as* the
golden, a golden-to-candidate diff goes quiet, because the witness is inside the
thing being questioned. The probe's is outside both.

An earlier version keyed lint findings by rule ID and severity, reasoning that
"a refactor moves code, so position keying would report movement as regression."
That reasoning was wrong — the refactor moves code in the **tool**, not in the
frozen subject the findings point at. The tolerance bought nothing and cost a
great deal: `verify-gate.mjs` mutates the golden every way a broken refactor
plausibly could, and eleven of the first twenty-one cases were accepted,
including every lint finding relocated to a fabricated file with rewritten
messages.

Those mutations are kept permanently rather than deleted once fixed. A gate is
the only thing standing between a refactor and a silent behaviour change, so its
capability to fail has to be executable, not assumed. Run `verify-gate.mjs`
after touching `accept-refactor.mjs`.

Re-baselining is the deliberate escape hatch and should feel like one: a
rejection names every differing section precisely, so adopting a new golden
means writing down a reason for each.

### What the golden cannot judge

The golden answers a purely relative question — *did this change alter what the
tool measures?* Two things it structurally cannot cover, both delegated to the
synthetic subject instead:

**Correctness.** The baseline is the tool's own former output, so it ratifies a
wrong number as readily as a right one. `verify-ground-truth.mjs` checks against
values hand-derived from the source (see `GROUND-TRUTH.md`).

**Dimensions that measure zero.** Apollo type-checks clean, so `typescript` is
0 on both sides of every comparison and `0 === 0` holds however broken the
adapter is — an adapter hardcoded to return nothing stays byte-identical and
passes the probe cross-check too. `accept-refactor.mjs` now prints
`NO DISCRIMINATING POWER` for any such dimension rather than letting it look
covered. The synthetic subject has three hand-derived type errors, which is
where that coverage actually lives.

**Breakage.** Neither the golden nor the mocked unit tests break a real tool.
`verify-vacuous-pass.mjs` does: it copies the synthetic subject, deletes the
`type-check` script, points it at a missing binary, corrupts the eslint config,
and asserts the gate FAILS each time with the right `MeasurementFailure` kind.
Its unsabotaged control has to measure cleanly, or a chain that called every run
broken would score a perfect result.

`tool-lint-baseline.json` is a separate record of *this repo's own* lint state,
used to check that refactor commits do not introduce new errors. It is not part
of the golden comparison.
