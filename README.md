# quality-gate-sgd

> Deterministic quality gates for stochastic gradient descent behavior from LLM agents

## The Core Insight

**The way to get deterministic results from a stochastic work unit (like an LLM) is to make the exit gate on the process (more) deterministic.**

This package provides quality gates that create **gradient descent-like behavior** for LLM coding agents. When an agent iteratively fixes code to pass quality gates, it naturally descends toward higher quality solutions-without explicit optimization algorithms.

## Why This Works

For gradient descent behavior to emerge from deterministic gates, three properties must hold:

1. **Quantitative Measurement** - Metrics must be numeric with a clear "good" direction
   - Coverage: higher is better
   - Bug count: lower is better

2. **Pure Function** - Same code state → same metric values
   - No randomness in measurement
   - Reproducible results

3. **Local Continuity** - Small code changes → small metric changes
   - No discontinuous cliffs
   - Following feedback improves scores

When these properties hold, an LLM agent iterating against quality gates exhibits **stochastic gradient descent** behavior-the agent's inherent randomness provides exploration, while the deterministic gates provide the descent direction.

## Installation

```bash
npm install quality-gate-sgd
```

### What it shells out to

The gate measures by running other programs, so these have to be present. They are
listed because a missing one is a *failed measurement*, not a silent zero — the gate
will tell you, but it is cheaper to know first.

| Needed | For | If absent |
|-----|-----|-----|
| `git` | the cache key and baseline resolution | the run refuses rather than guessing the tree state |
| `npm` | `requiredScripts`, and the `type-check` script | that script reports `tool-missing` |
| `npx eslint`, `tsc` | the eslint and typescript dimensions | those dimensions report a failure |
| **`bash`** | **every custom dimension extractor** | **each one reports `tool-missing`** |
| `curl` | SonarQube, and `init`'s LLM call | that dimension / that step fails |
| `claude` CLI **or** `ANTHROPIC_API_KEY` | `init`'s threshold suggestion only | `init` falls back to built-in defaults |

**`bash` specifically, not `sh`.** Custom extractors run as
`bash -c 'set -o pipefail; <your command>'`, and `pipefail` is not optional: without
it, `broken-tool | wc -l` exits **0** and prints `0`, so a `lower-better` dimension
gated by a ceiling reports a perfect score for a tool that never ran. That is the
exact failure this gate exists to prevent, so a POSIX `sh` fallback would be trading
the tool's whole purpose for portability. On a machine without bash the dimension
fails loudly instead.

Every extractor failure reports a command you can paste into your own shell to get
the same run, including the working directory and the pipefail prefix.

## Quick Start

### 1. Create Rules Configuration

The easy path calibrates the thresholds from your current metrics and picks a
coverage-writing test script for you:

```bash
npx quality-gate-sgd init
```

To write it by hand instead, start from the template:

```bash
# Copy the template
cp node_modules/quality-gate-sgd/templates/rules.template.json rules.json
```

Then **replace `test:coverage` in `requiredScripts` with the script in your
`package.json` that actually writes the coverage report** - see
[Pairing coverage floors with a coverage-writing script](#pairing-coverage-floors-with-a-coverage-writing-script)
below for why that pairing matters.

Edit `rules.json` for your project:

```json
{
  "version": "1.0.0",
  "description": "My Project Quality Rules",
  "rules": {
    "floors": {
      "coverage.unit.branches": 70
    },
    "ceilings": {
      "sonarqube.blocker": 0,
      "sonarqube.critical": 0
    },
    "monotonic": [
      { "direction": "up", "metrics": ["coverage.unit.branches"] },
      { "direction": "down", "metrics": ["sonarqube.bugs"] }
    ],
    "requiredScripts": ["test:coverage", "lint"]
  }
}
```

`test:coverage` here stands for whatever your coverage-writing script is called;
`test` is deliberately **not** used, because for vitest and jest the default
`test` script writes no coverage report.

### 2. Run the Quality Gate

```bash
npx quality-gate-sgd
```

### 3. View SonarQube Issues

```bash
npx quality-gate-sgd list-issues -severity=MAJOR
```

## Rule Types

### Floors
Minimum thresholds that must be met:
```json
"floors": {
  "coverage.unit.branches": 70,
  "coverage.unit.statements": 80
}
```

### Ceilings
Maximum thresholds that must not be exceeded:
```json
"ceilings": {
  "sonarqube.blocker": 0,
  "sonarqube.critical": 0,
  "sonarqube.major": 10
}
```

### Monotonic (Ratcheting)
Metrics that must not regress:
```json
"monotonic": [
  { "direction": "up", "metrics": ["coverage.unit.branches"] },
  { "direction": "down", "metrics": ["sonarqube.bugs", "sonarqube.vulnerabilities"] }
]
```

### Required Scripts
npm scripts that must pass:
```json
"requiredScripts": ["test:coverage", "lint", "build"]
```

#### Pairing coverage floors with a coverage-writing script

The gate runs `requiredScripts` and *then* reads the coverage report, so if you
have any `coverage.*` floor, ceiling or monotonic rule, one of your
`requiredScripts` must be the script that writes that report.

For vitest and jest, the default `test` script does not. Measured with vitest 4
and `@vitest/coverage-v8`: `npm run test` on `"test": "vitest run"` created no
`coverage/` directory at all, while `"vitest run --coverage"` wrote
`coverage/coverage-summary.json`. Pairing coverage floors with a `test` script
like that means the floors are graded against whatever generation of the code
last wrote a report.

**The gate does not detect that.** It reads the report on disk and grades it,
whether the report was written by this run, by a CI step five minutes ago, or by
a checkout last week. There is no age check: one was built (compare the report's
mtime against the newest source file) and removed, because it was inert on any
project whose sources are not under a literal top-level `src/` and it false-failed
mtime-preserving archive restores, branch switches and clock skew. Getting the
pairing right is therefore on you, and it is the reason `init` picks a
coverage-writing script.

## Available Metrics

### Coverage Metrics
- `coverage.unit.*` - Unit test coverage
- `coverage.lambda.*` - Integration/Lambda test coverage
- `coverage.union.*` - Merged coverage from all suites

Each suite has: `branches`, `statements`, `functions`, `lines`

### SonarQube Metrics
- `sonarqube.bugs`, `sonarqube.vulnerabilities`, `sonarqube.codeSmells`
- `sonarqube.blocker`, `sonarqube.critical`, `sonarqube.major`, `sonarqube.minor`, `sonarqube.info`
- `sonarqube.coverage`, `sonarqube.duplications`

### TypeScript & ESLint
- `typescript.errors`, `typescript.warnings`
- `eslint.errors`, `eslint.warnings`

## The SGD Framework

### Metric Classification

Not all metrics are equal for gradient descent. We classify them by their role:

| Category | Creates Gradient? | Examples |
|-----|----------|-----|
| **Objective Metrics** | Yes | coverage, bugs, codeSmells |
| **Weighting Metrics** | No | impact, degree, severity |

**Objective metrics** are what you optimize-they form the loss function.

**Weighting metrics** focus the optimization-they tell you *where* to optimize first.

### Smoothness Ranking

Metrics with higher granularity create smoother gradients:

| Tier | Metric | Why |
|---|----|---|
| 1 | `coverage.lines` | N=thousands, ~0.03% per line |
| 1 | `duplications %` | Gradual refactoring |
| 2 | `coverage.branches` | N=hundreds, ~0.5% per branch |
| 3 | `sonarqube.blocker` | N<10, discrete cliffs |

Prefer percentage-based metrics with large denominators for smoother descent.

### Priority Function

For LLM agent guidance, we compute file priority as:

```
priority = w_cov × coverageGap + w_ease × easeOfTesting + w_impact × importance + w_sev × severityScore
```

Where:
- **coverageGap** = 1 - coverage (needs more tests)
- **easeOfTesting** = 1 / (1 + degree) (leaf nodes are easier)
- **importance** = indirectDependents / max (critical code)
- **severityScore** = weighted sum of violations

This creates a unified priority that balances what needs testing, what's easy to test, and what's most important to test.

## Programmatic API

```typescript
import {
  loadRules,
  evaluateRules,
  extractAllMetrics,
  buildDependencyGraph,
  prioritizeFiles,
} from 'quality-gate-sgd';

// Run quality gate. The scripts run BEFORE the reports are read, so the one
// that writes coverage has to be in this list for the coverage numbers to
// describe the current code.
const rules = loadRules();
const metrics = extractAllMetrics(['test:coverage', 'lint']);
const result = evaluateRules(rules, metrics);

console.log(result.status); // 'pass' or 'fail'
console.log(result.failedRules); // Array of failures

// Analyze dependencies for test prioritization
const graph = buildDependencyGraph();
const prioritized = prioritizeFiles(graph, result.failedRules);

console.log(prioritized[0].file.path); // Highest priority file
console.log(prioritized[0].priority);  // Priority score
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|-----|-----|-------|
| `SONARQUBE_URL` | `http://localhost:9000` | SonarQube server |
| `SONARQUBE_PROJECT_KEY` | Auto-detected | Project key |
| `QUALITY_RULES_FILE` | `rules.json` | Rules file path |
| `QUALITY_CODE_PATHSPECS` | `src/,tests/,scripts/` | Paths for cache hashing |
| `QUALITY_CACHE_FILE` | `.quality-gate-cache.json` | Cache file |
| `QUALITY_COVERAGE_UNIT_DIR` | `coverage` | Directory holding the coverage summary |
| `QUALITY_COVERAGE_SUMMARY_FILE` | `coverage-summary.json` | Summary filename within it |
| `QUALITY_COVERAGE_REQUIRED` | `true` | Whether a missing coverage report is an error |

### Projects with no coverage

The gate treats a missing `coverage/coverage-summary.json` as a **failed
measurement**, not as zero coverage and not as nothing at all. The reason is an
asymmetry between the rule kinds: a floor on a metric that is absent fails loudly
(`Metric 'coverage.unit.branches' not available`), but a **ceiling or a monotonic
ratchet on an absent value is silently skipped**. So a project whose only coverage
rule is a ratchet used to lose coverage enforcement entirely, and permanently, the
moment its test script stopped writing a report — while still reporting a pass and
caching it. A script can exit 0 having written nothing, so nothing has to look
broken for that to happen.

What you see depends on whether you gate coverage:

- **You have coverage rules.** The gate fails, naming the file it looked for and
  the setting that produced the path. Fix it by running the script that passes
  `--coverage` before the gate and listing it in `requiredScripts`.
- **You have no coverage rules.** The gate still passes — a measurement no rule
  reads cannot change a verdict — but it prints an advisory every run and does not
  write a cache entry, because an incomplete reading is not worth remembering.

If the project genuinely has no coverage and never will, say so once:

```bash
QUALITY_COVERAGE_REQUIRED=false
```

That silences the advisory and restores caching. Only `false`, `0`, `no` and `off`
disable it; anything else — including an empty value — leaves it on, deliberately,
so a typo cannot quietly reopen the hole.

**The opt-out cannot switch off a coverage rule you wrote.** It is honoured only
when no rule reads coverage, directly or through `coverage.union`. A configuration
that sets the variable *and* grades coverage has contradicted itself, and the gate
resolves that by measuring: otherwise setting one environment variable would
silently disable a ratchet, which is the defect the requirement exists to close.
The narrow reading is also why toggling the variable does not invalidate a cached
entry — it can only ever suppress an advisory, never change a verdict.

### Coverage suites

`QUALITY_COVERAGE_UNIT_DIR` is the main suite. `QUALITY_COVERAGE_LAMBDA_DIR`
declares a second one (integration, e2e, lambda — the name is historical), read
into `coverage.lambda.*`, with `coverage.union.*` summed across both.

A suite you **name** must produce a report: if you set
`QUALITY_COVERAGE_LAMBDA_DIR` and nothing writes a summary there, that is a failed
measurement even when the main suite is healthy. A suite you did not name is not
required — the second suite has a default path that almost no project has, so
failing on its absence would fail nearly everyone. This is also why a project whose
only coverage lives in a named second suite is fine: the main suite's absence is
not faulted when another suite produced a report.

### SonarQube Setup

1. Start SonarQube (Docker recommended):
   ```bash
   docker-compose -f docker-compose.sonarqube.yml up -d
   ```

2. Create a project and generate a token

3. Save token:
   ```bash
   echo "your-token" > .sonarqube-token
   ```

4. Create `sonar-project.properties`:
   ```properties
   sonar.projectKey=my-project
   sonar.sources=src
   sonar.tests=tests
   sonar.javascript.lcov.reportPaths=coverage/lcov.info
   ```

## Caching

The quality gate uses intelligent caching:

- **Clean working tree**: Cache key = commit hash
- **Uncommitted changes**: Cache key = `wip:` + SHA256 of code diffs
- **Rules change**: Cache invalidated when rules.json changes

Cache stores metrics and evaluation results to avoid redundant runs.

**A reading that reported a failed measurement is never cached.** If any dimension
could not be measured — a crashed linter, a type-check script that does not exist,
an unreadable coverage report — this run is not stored, whether or not a rule grades
that dimension, and the next run measures again. A cached pass exits 0 without
measuring anything and without re-reading the stored metrics, so an entry recording
a failed measurement would report that failure exactly once and never again. The
cost is that a project with, say, a stray `coverage-lambda/` directory re-measures
every run; the gate prints what could not be measured on every one of those runs,
and says how to make it stop.

Three known gaps in that guarantee, all pre-existing and tracked rather than fixed:
`sonarqube` has no failure channel, so losing that dimension entirely still caches
as clean; the cache key covers tracked content only, so a coverage report corrupted
*after* a clean entry was written is not re-read; and if your code lives outside
`QUALITY_CODE_PATHSPECS` (default `src/,tests/,scripts/`) the uncommitted-changes
key is a constant, so an entry is served for arbitrarily different code until the
commit changes. If your layout is not `src/`-based, set `QUALITY_CODE_PATHSPECS`.

A measurement failure **fails the gate** only when some rule reads that dimension —
including through a dimension derived from it, so a floor on `coverage.union.*` is
gated by the `coverage.unit` and `coverage.lambda` measurements the union is summed
from. Anything else is reported without failing the build, since a number nothing
compares against cannot change a verdict.

## For LLM Agent Authors

If you're building an LLM coding agent, this package provides:

1. **Deterministic gates** that create gradient direction
2. **Priority computation** to guide which files to work on
3. **Dependency analysis** to understand code structure
4. **Severity weights** to prioritize violations

The key insight: *Your agent's inherent stochasticity provides exploration; our gates provide the descent direction.*

See [docs/CONCEPT.md](docs/CONCEPT.md) for the full mathematical framework.

---

## Academic Paper (WORKING DRAFT)

The theoretical foundations are documented in a LaTeX paper: **[paper/quality-gate-sgd.tex](paper/quality-gate-sgd.tex)**

⚠️ **Draft status**: Not peer-reviewed. Novel claims await empirical validation.

Covers: Quality Geometry, Convergence Theorem, Discrete Differentiability, Metric Topology, Empirical Validation Plan (RQ1-RQ6).

Claim inventory: [docs/theory/CLAIMS.md](docs/theory/CLAIMS.md)

## License

Apache-2.0
