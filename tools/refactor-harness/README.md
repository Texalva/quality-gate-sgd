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
| `verify-vacuous-pass.mjs [tool-dir]` | When a measurement genuinely breaks, does the gate say so? | 0 all 20 cases held / 1 a break passed, or a control went red / 2 fixture inert |
| `verify-baseline-resolution.mjs [tool-dir]` | Does baseline resolution survive a real shallow clone? | 0 correct / 1 wrong / 2 fixture inert |

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

`golden-A.json` is a capture against apollographql/apollo-client at `359f3e63`,
pinned by `fixture-manifest.json`.

It has a twin that is deliberately **not** committed. Every re-baseline takes two
back-to-back captures and diffs them; the pair must differ in nothing but
`liveness.*.elapsedMs`, which is what earns the byte-identity bar below. At the
last re-baseline that diff was exactly two fields — `46711/34198` and
`41683/26216` ms — and nothing else. Only `golden-A.json` is kept, because the
second capture was read by no script: `verify-gate.mjs` opens `golden-A.json`,
and `accept-refactor.mjs` names the `liveness` and `captureSha` exclusions
outright rather than inferring them from an A-vs-B comparison. Carrying a second
670 KB / 22,487-line artefact to record a four-line result is a bad trade, and
the result is reproducible on demand:

```bash
node tools/refactor-harness/capture.mjs . ~/scratch/qg-fixtures/apollo-client /tmp/b.json
diff tools/refactor-harness/golden-A.json /tmp/b.json   # expect: elapsedMs only
```

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
breaks a custom extractor four ways, and asserts the gate FAILS each time with the
right `MeasurementFailure` kind. Its unsabotaged control has to measure cleanly,
or a chain that called every run broken would score a perfect result — and a
working custom dimension rides along with each sabotage, so a chain that gave up
at the first failure cannot pass either.

Its summary line counts three categories rather than two, because they are three
different results: breakages that must fail the gate, breakages that must be
REPORTED without failing it (a dimension no rule grades), and controls that must
measure cleanly. Calling any of them "a broken measurement that failed the gate"
would overstate what the run demonstrates. As of this revision that is **20
results: 14 breakages, 2 ungated breakages, 4 controls** — the three controls with
a `SABOTAGES` entry plus the unsabotaged one, which has no entry and is counted
separately.

Each case also names the RULE that grades the dimension it breaks (`gateCeiling`,
or a `rules.json` for the two cases that run the shipped CLI). A measurement failure
becomes a failed rule only when some rule reads that dimension, so a case whose
dimension the coverage-only defaults never mention has to supply one -- which is
the project its `stands_for` already describes, since a `custom.*` dimension is
gated by a ceiling and by nothing else. Measured discrimination: removing those
ceilings makes all four custom cases escape.

`gateRules` is the other half of that, and it replaces `rules.rules` rather than
adding to it, because two cases are about a rule that is **absent** — the project
that gates its type-checker and its linter and never asked for coverage — and an
absence is not expressible by adding a ceiling. Its thresholds are the subject's
own hand-derived numbers (3 tsc errors, 2 eslint errors), since a case asserting
the gate comes back `pass` cannot afford to fail for an unrelated reason.

Seven of its cases exercise the *coverage* reading rather than a subprocess, and
they are the only checks anywhere that let a coverage report be written by the run
being graded. Three break it:

- **`coverage.include` pointed at source that does not exist.** The suite passes,
  the run writes the report itself, and every denominator in it is 0. Measured
  output from vitest 3.2.7 + `@vitest/coverage-istanbul`:
  `{"total":{"lines":{"total":0,...,"pct":"Unknown"},...}}` beside an empty
  `coverage-final.json`. istanbul computes `pct` as `percent(covered, total)`,
  which returns **100** for 0/0, so passing `total.<dim>.pct` through reported a
  project that measured nothing as fully covered. Measured discrimination:
  restoring that pass-through in `dist/providers/coverage.js` (copy
  `total.<dim>.pct` verbatim, no denominator check and no numeric check) makes this
  case, and only this case, escape — and what it escapes with is
  `coverage.unit={"statements":"Unknown","branches":"Unknown","functions":"Unknown","lines":"Unknown"}`,
  four strings in a `number` field, reaching the floors as a clean reading.
- **A half-written report under a floor.** A truncated `coverage-summary.json`
  with one coverage floor configured: `unparseable-output`, and the gate fails on
  it.
- **A failed suite under a UNION floor.** The subject's unit suite is measured
  cleanly by this run (25%) while a truncated `coverage-lambda/` summary sits
  beside it, and the only coverage rule is `coverage.union.statements >= 20`.
  `coverage.union` is *computed* from both summaries, so `mergeCoverageReports`
  sums it from the unit suite alone and the number passes its floor — while the
  failure is on `coverage.lambda`, which no rule names. It must fail anyway,
  through the derivation edge in `isMeasurementUnderRule`. Measured
  discrimination: dropping that edge in `dist/rules.js`
  (`measurementsBehind` reduced to `[metricPath]`) makes this case, and only this
  case, escape — `gate=pass, failedRuleTypes=[]` with the failure still listed in
  `metrics.measurementFailures`.

Three more are the cases a *too aggressive* reading fails, and they exist because
each of the three above is satisfiable by a rule that simply always says no:

- **A report from the previous run, with a script that rewrites it.** Asserts the
  graded number is the one this run produced (25%) and never the planted
  generation's (10%). This is the ordering fix: `extractAllMetrics` built its
  result as one object literal, so `coverage:` read the report before `scripts:`
  ran the npm scripts that rewrite it. Measured discrimination: moving the coverage
  read back above `runScripts` in `dist/metrics.js` makes **three** cases escape,
  and this is the only one whose escape value is checkout-independent — it grades
  the planted `10`, a number no generation of the subject produces. The other two
  are the empty-config and branchless cases, which depend on the run's own report
  and so read whatever the copy carried instead: with the subject's gitignored
  `coverage/` present they both saw the stale `{statements:25,branches:40,...}`;
  with it removed (the fresh-clone shape) they both saw `coverage.unit=null`. Both
  variants measured. The fixture probes stay quiet through all of it, correctly —
  the run *did* rewrite the report, the tool read it at the wrong time.
- **A codebase with no branches at all.** `include` narrowed to the subject's one
  branchless module, plus a test covering 2 of its 5 statements, so the report is a
  live partial measurement with an empty branch denominator. Measured, and matching
  the hand-derivation: `statements {5, 2, pct 40}`, `functions {3, 1, pct 33.33}`,
  `branches {0, 0, pct 100}`. Asserting the 40 beside the 100 is what stops a chain
  that answers 100 to everything from passing. Measured discrimination in both
  directions: dropping a zero-denominator dimension (the previous revision) makes
  it report `{statements:40, functions:33.33, lines:40}` with `branches` absent;
  refusing any report with a zero denominator as `measured-nothing` makes it report
  `coverage.unit=null` and fail. Only this case moves either way.
- **The same half-written report that no rule grades.** The other half of the
  gating pair, and neither half is evidence alone. This is critical (ii)'s project
  — a truncated `coverage-summary.json` in a stray gitignored directory, with rules
  that name only `typescript.errors` and `eslint.errors` — and it must come back
  `pass` while still REPORTING `unparseable-output` on `coverage.unit`. Measured
  discrimination: deleting the scoping filter in `dist/rules.js` makes this one
  escape with `failedRuleTypes=[measurement]`, and takes the two-run case below
  down with it — that one reports that its *first* run exited 1 and so never
  reached the exit it is about, which is a diagnosis rather than a false pass in
  either direction. Making `isMeasurementUnderRule` answer `false` for everything
  makes the *floored* half escape (`failedRuleTypes=[floor]`, no measurement rule)
  while this one stays green — along with twelve other cases, 13 in total
  (re-measured at this revision, unchanged), which is the cost that rule would
  quietly impose on every project that does gate what it measures. The two-run case
  is deliberately NOT among those 13: cache suppression is unconditional on
  gating, so it holds either way.

The seventh asks a question none of the others can, because it is about the run
*after* this one:

- **The same ungated failure on a second run.** A truncated `coverage-lambda/`
  summary, a `rules.json` that gates only the build, and the shipped `dist/cli.js`
  invoked TWICE against one commit. The advisory is the only report an ungated
  failure ever gets, and it was a one-shot: run 1 wrote a cache entry carrying the
  failure and run 2 took the cached-pass exit, which prints `✓ Quality gate PASSED
  (cached)` and exits 0 without reading `metrics.measurementFailures` at all.
  Measured discrimination: reintroducing both halves of the fix in `dist/` —
  scoping cache suppression to gated failures in `cli.js`, and dropping
  `isCacheValid`'s refusal of entries that record a failure in `rules.js` — makes
  this case, and only this case, escape, with run 2 printing exactly
  `Using cached result from …` / `✓ Quality gate PASSED (cached)` and nothing else.
  The cached entry was inspected directly: `status pass`,
  `failures ["coverage.lambda:unparseable-output"]`.

  Its ruleset is load-bearing in three ways, each of which would otherwise let it
  pass against that defect: no coverage rule (or the derivation edge would gate the
  lambda failure and the gate would never pass), `requiredScripts: []` (nothing
  rewrites a report mid-run, so the tree stays clean and both runs key on the
  commit), and no monotonic rule (`monotonicSkipped` suppresses caching too, and
  would suppress it whether or not measurement failures did).

There is deliberately **no case asserting that the gate notices a report no script
it ran wrote**. Three cases here used to: a `stale-report` breakage, its
zero-config twin, and a CI-shape control demanding a report newer than every
source file. The rule they tested compared the summary's mtime against the newest
file under `codePathspecs`, and it was removed for being inert on any project whose
sources are not under a literal top-level `src/` while false-failing
mtime-preserving archive restores, `git checkout` round-trips, clock skew and any
bulk tree write longer than its tolerance. The residual hole — coverage generated
outside the gate is graded on whatever is on disk — is open and filed as backlog
 #39, and no case here asserts either that it is closed or that it should stay open.

Each of those seven re-reads the subject after the run and exits **2** if its
fixture has stopped reproducing the condition — the rule
`verify-baseline-resolution.mjs` applies to its `--depth 1` clone. For the controls
the probe's condition is inverted: the ordering case demands a report the run
actually rewrote, the branchless case demands an empty branch denominator beside
covered statements, the gating pair demands a report that still does not parse, and
the union case demands BOTH — an unparseable lambda summary and a live 25% unit
report, since a union floor that was failing on its own would make the verdict say
nothing about the derivation edge.

The two-run case's probe is the only one whose condition is not entirely on disk,
which is why probes take the run result as a second argument. It checks the planted
lambda summary the way the gating pair does, and then something no file records:
that both runs asked the SAME question. The only evidence of that is the `Commit:` /
`WIP changes on …` line each run printed. If the key moved, run 2 re-measures for a
reason that has nothing to do with caching and the case passes against a broken
build. Measured, not hypothetical: with `QUALITY_CACHE_FILE` inside the subject
directory the untracked cache file dirtied the tree, run 1 keyed on `0692f2d` and
run 2 on `wip:e3b0c44`, and the case reported `ok` against a `dist/` with the
defect reintroduced. The file is written to the throwaway root above the subject for
exactly that reason, and the probe holds the line if anyone moves it back.

None of this is decoration — every one of these paths has been made to fire, at
this revision:

| forced condition | result |
|---|---|
| subject's `test:coverage` changed to write nothing | exit 2, ordering case: *"the planted 10% report is still on disk after the run, so `npm run test:coverage` no longer writes coverage and reading it before or after the scripts is indistinguishable"* |
| planted lambda summary made valid JSON | exit 2, union case: *"parses after the run (70 bytes), so the lambda suite measured fine"*; two-run case: same, *"…nothing here exercises a failure that has to be repeated"* |
| planted unit summary made valid JSON | exit 2, gating pair: *"the planted report parsed after the run and reports 25% statements"* |
| branchless `include` pointed at a module with an `if` | exit 2: *"the report this run wrote has 8 branches in its denominator rather than 0"* |
| `QUALITY_CACHE_FILE` moved inside the subject | exit 2, two-run case: *"run 1 keyed on 6e05068 and run 2 on e3b0c44, so run 2 could not have hit the entry run 1 wrote"* |
| the `include:` pattern a sabotage rewrites removed | exit 2: *"no longer contains `include: [\"src/**/*.ts\"]`, so this case did not change the coverage configuration at all"* |

A fixture that no longer reproduces its condition can certify a false positive as
readily as it can miss a real one, and a sabotage that silently fails to apply is
the same species of hole: `pointCoverageAtNothing` and
`pointCoverageAtBranchlessSource` both return a reason rather than changing nothing
if the pattern they rewrite is gone.

**Whether the product does what the library does.** Two cases there run the
shipped `dist/cli.js` rather than calling into the library, and both earn their
keep. `extractAllMetricsAsync` is the only extraction path that loads custom
dimensions, and for the whole life of the tool nothing called it: the CLI used the
synchronous variant, so every configured `custom.*` ceiling was skipped for want of
a metric — not merely unmeasured, *never enforced*. Every library-level case in
this file passed throughout, because each one handed the dimensions in itself. A
check that only ever calls the function it is testing cannot notice that the
product calls a different one.

The cache is the second such surface, and a stronger one, because there is no
library function to call: whether a run is remembered, and what a remembered run
prints, is decided in `cli.ts` alone. `evaluateRules` cannot be asked whether the
NEXT run will report anything. That is why the two-run case invokes the binary
twice instead of asserting something about `metrics` — the defect lived entirely in
which of two exits the second run took.

**What the environment does, as opposed to what we assume it does.** Mocked tests
assert that a hand-written string parses the way its author expected, so they
cannot catch a wrong belief about the tool being mocked — and three such beliefs
have been wrong in this refactor. `spawnSync`'s `maxBuffer` turned out to be a
budget *shared* across stdout and stderr; output landing *exactly* on the limit
turned out not to be truncation; and `git log --format=%P` turned out to honour a
shallow graft where `git cat-file` does not. Each was stated confidently in a
comment and falsified by measurement. `verify-baseline-resolution.mjs` is the
answer for the git one: it builds real repositories, clones one at `--depth 1`,
and refuses to run (exit 2) if that clone is not actually shallow, since a
fixture that no longer reproduces the condition proves nothing while still
reporting success.

`tool-lint-baseline.json` is a separate record of *this repo's own* lint state at
the commit the refactor started from. It is not part of the golden comparison, and
despite what this paragraph used to say, **no script reads it** — it is a
historical snapshot for comparing the end state by hand, and it now carries that
end state alongside the starting one. If "no new lint errors" should be enforced
rather than remembered, that belongs in CI, not in a JSON file.
