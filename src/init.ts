/**
 * LLM-Guided Initialization
 * ==========================
 * Uses Claude to analyze your repo and suggest a quality topology.
 *
 * Flow:
 * 1. Analyze repo structure (package.json, configs, test files)
 * 2. Ask LLM to suggest geometry (which dimensions to measure)
 * 3. Interactive interview about available tooling
 * 4. Run initial metrics to calibrate "barely passing" thresholds
 * 5. Generate rules.json + explanatory QUALITY.md
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { loadConfig } from './config.js';
import { getDimensionsByCategory } from './dimensions/index.js';
import { eslintLintProvider } from './providers/eslint.js';
import { DEFAULT_MEASUREMENT_LIMITS } from './providers/result.js';
import { typescriptTypecheckProvider } from './providers/typescript.js';
import {
  detectPackageManager,
  detectTypecheckScript,
  scriptCommand,
  type RunnerSelection,
} from './runner.js';

// =============================================================================
// Types
// =============================================================================

/** One npm script `init` would consider running to measure coverage. */
export interface TestScriptCandidate {
  readonly name: string;
  /** Whether the script's name or body says it writes a coverage report. */
  readonly writesCoverage: boolean;
}

export interface RepoAnalysis {
  packageJson: Record<string, unknown> | null;
  hasTypeScript: boolean;
  hasJest: boolean;
  hasVitest: boolean;
  hasMocha: boolean;
  hasEslint: boolean;
  hasSonarConfig: boolean;
  hasDocker: boolean;
  testCommand: string | null;
  /**
   * Whether `testCommand` looks like it writes a coverage report.
   *
   * The generated config gates coverage.unit.* with floors AND relies on the
   * gate to run `testCommand`. If that script writes no coverage, the floors are
   * graded against whatever report is on disk -- from an earlier generation of
   * the code, and the gate has no way to tell (backlog #39). Recorded so the
   * interview can say so instead of the adopter shipping a config whose numbers
   * nothing refreshes.
   */
  testCommandWritesCoverage: boolean;
  /** The candidates `testCommand` was chosen from, in the order they were ranked. */
  testScriptCandidates: readonly TestScriptCandidate[];
  /**
   * EVERY script in package.json that looks like it writes coverage, not just
   * the four this module would pick from.
   *
   * A project whose only coverage-writing script is called something like
   * `ci:coverage` is invisible to the candidate list, so without this the
   * "your test command writes no coverage" warning could not name the thing the
   * adopter should have used instead.
   */
  coverageWritingScripts: readonly string[];
  srcDir: string;
  estimatedSloc: number;
  /**
   * Which package manager runs this project.
   *
   * On the analysis rather than passed separately, because it IS a fact discovered
   * by looking at the repository, and because everything that formats advice for the
   * adopter already receives the analysis. The alternative -- a parameter threaded
   * to each -- is how some of those messages end up saying `npm run test` while the
   * gate runs `bun run test`, which is the divergence this whole indirection is for.
   */
  packageManager: RunnerSelection;
}

export interface GeometrySuggestion {
  dimensions: string[];
  rationale: string;
  coverageTarget: number;
  recommendSonarQube: boolean;
}

export interface InitOptions {
  yes: boolean; // -y flag: accept all defaults
  noDocker: boolean; // --docker=no: skip SonarQube
  verbose: boolean;
}

export interface GeneratedConfig {
  rules: {
    version: string;
    description: string;
    rules: {
      floors: Record<string, number>;
      ceilings: Record<string, number>;
      monotonic: Array<{ direction: 'up' | 'down'; metrics: string[] }>;
      requiredScripts: string[];
    };
  };
  explanation: string;
}

// =============================================================================
// Repo Analysis
// =============================================================================

/**
 * Test-script names in preference order -- the SECONDARY ranking key.
 *
 * The PRIMARY key is whether the script writes a coverage report, and the
 * ordering here is only a tie-break among scripts that are equal on it. Ranking
 * by name alone put `test:unit` above `test`, which inverts the intended
 * priority in exactly the case the coverage-aware pick exists to fix: for
 * `{"test": "jest --coverage", "test:unit": "jest test/unit"}` a name-ordered
 * list picks the script that writes nothing and then pairs it with coverage
 * floors. `test` sits above `test:unit` here because that was the original
 * priority and nothing about coverage argues for changing it.
 */
const TEST_SCRIPT_CANDIDATES = ['test:coverage', 'coverage', 'test', 'test:unit'] as const;

/**
 * A script that looks like it writes a coverage report.
 *
 * A heuristic on the name and the body, and deliberately only used for RANKING
 * and for advice. Whether a report was actually written is established by
 * measurement -- `collectCalibrationMetrics` stats the report before and after
 * running the script -- because the name of a script is not evidence about its
 * filesystem effects.
 */
const COVERAGE_WRITING_SCRIPT = /(^|:)cov|--coverage/;

export function scriptWritesCoverage(name: string, body: string): boolean {
  return COVERAGE_WRITING_SCRIPT.test(`${name} ${body}`);
}

/** The scripts declared in package.json, as strings only. */
function scriptsOf(packageJson: Record<string, unknown> | null): Record<string, string> {
  const scripts = (packageJson?.scripts as Record<string, unknown>) || {};
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

export function analyzeRepo(projectRoot: string): RepoAnalysis {
  const analysis: RepoAnalysis = {
    packageJson: null,
    hasTypeScript: false,
    hasJest: false,
    hasVitest: false,
    hasMocha: false,
    hasEslint: false,
    hasSonarConfig: false,
    hasDocker: false,
    testCommand: null,
    testCommandWritesCoverage: false,
    testScriptCandidates: [],
    coverageWritingScripts: [],
    srcDir: 'src',
    estimatedSloc: 0,
    packageManager: detectPackageManager(projectRoot),
  };

  // Read package.json
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      analysis.packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const pkg = analysis.packageJson as Record<string, unknown>;

      // Check dependencies
      const allDeps = {
        ...(pkg.dependencies as Record<string, string> || {}),
        ...(pkg.devDependencies as Record<string, string> || {}),
      };

      analysis.hasTypeScript = 'typescript' in allDeps;
      analysis.hasJest = 'jest' in allDeps;
      analysis.hasVitest = 'vitest' in allDeps;
      analysis.hasMocha = 'mocha' in allDeps;
      analysis.hasEslint = 'eslint' in allDeps;

      // Check scripts for test command.
      //
      // A COVERAGE-WRITING script is preferred, because the generated config
      // pairs `requiredScripts: [testCommand]` with coverage.unit.* floors --
      // and if that script writes no coverage report, the gate grades those
      // floors against whatever generation of the code last wrote one. Picking
      // plain `test` first (which for vitest and jest usually means no
      // `--coverage`) installed exactly that defect in every project init ever
      // generated.
      //
      // MEASURED, vitest 4 + @vitest/coverage-v8 on a throwaway project with
      // `{"test": "vitest run", "test:coverage": "vitest run --coverage"}`:
      // `npm run test` created no coverage/ directory at all, `npm run
      // test:coverage` wrote coverage/coverage-summary.json. The distinction is
      // real, not stylistic.
      const scripts = scriptsOf(pkg);
      const candidates: TestScriptCandidate[] = TEST_SCRIPT_CANDIDATES.filter(
        (name) => name in scripts
      ).map((name) => ({ name, writesCoverage: scriptWritesCoverage(name, scripts[name]) }));

      // `find` keeps the name order WITHIN the coverage-writing group, which is
      // what makes this a two-key sort rather than a rewrite of the priority.
      const chosen = candidates.find((c) => c.writesCoverage) ?? candidates[0];

      analysis.testScriptCandidates = candidates;
      analysis.coverageWritingScripts = Object.keys(scripts).filter((name) =>
        scriptWritesCoverage(name, scripts[name])
      );
      if (chosen) {
        analysis.testCommand = chosen.name;
        analysis.testCommandWritesCoverage = chosen.writesCoverage;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check for config files
  analysis.hasTypeScript = analysis.hasTypeScript || fs.existsSync(path.join(projectRoot, 'tsconfig.json'));
  analysis.hasEslint = analysis.hasEslint ||
    fs.existsSync(path.join(projectRoot, '.eslintrc.js')) ||
    fs.existsSync(path.join(projectRoot, '.eslintrc.json')) ||
    fs.existsSync(path.join(projectRoot, 'eslint.config.js'));
  analysis.hasSonarConfig = fs.existsSync(path.join(projectRoot, 'sonar-project.properties'));

  // Check for Docker
  try {
    const dockerCheck = spawnSync('docker', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    analysis.hasDocker = dockerCheck.status === 0;
  } catch {
    analysis.hasDocker = false;
  }

  // Estimate SLOC
  const srcPath = path.join(projectRoot, 'src');
  if (fs.existsSync(srcPath)) {
    analysis.srcDir = 'src';
    analysis.estimatedSloc = estimateSloc(srcPath);
  }

  return analysis;
}

function estimateSloc(dir: string): number {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) {
        count += estimateSloc(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        count += content.split('\n').filter(line => line.trim() && !line.trim().startsWith('//')).length;
      }
    }
  } catch {
    // Ignore errors
  }
  return count;
}

// =============================================================================
// LLM Integration
// =============================================================================

function checkClaudeCli(): boolean {
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function checkAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function callClaude(prompt: string): Promise<string> {
  // Try Claude CLI first
  if (checkClaudeCli()) {
    const result = spawnSync('claude', ['-p', prompt], {
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout;
    }
  }

  // Fall back to API if key exists
  if (checkAnthropicKey()) {
    // Use curl for simplicity (avoids adding SDK dependency)
    const result = spawnSync('curl', [
      '-s',
      '-X', 'POST',
      'https://api.anthropic.com/v1/messages',
      '-H', 'Content-Type: application/json',
      '-H', `x-api-key: ${process.env.ANTHROPIC_API_KEY}`,
      '-H', 'anthropic-version: 2023-06-01',
      '-d', JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    ], {
      encoding: 'utf-8',
      timeout: 60000,
    });

    if (result.stdout) {
      try {
        const response = JSON.parse(result.stdout) as { content?: Array<{ text?: string }> };
        return response.content?.[0]?.text || '';
      } catch {
        // Ignore parse errors
      }
    }
  }

  throw new Error('No LLM available. Install Claude CLI or set ANTHROPIC_API_KEY.');
}

async function suggestGeometry(analysis: RepoAnalysis): Promise<GeometrySuggestion> {
  // Get valid dimension paths grouped by category
  const coverageDims = getDimensionsByCategory('coverage').map(d => d.path);
  const errorDims = getDimensionsByCategory('errors').map(d => d.path);
  const qualityDims = getDimensionsByCategory('quality').map(d => d.path);

  const prompt = `You are helping configure a code quality gate system. Analyze this repository profile and suggest which quality dimensions to measure.

Repository Profile:
- TypeScript: ${analysis.hasTypeScript}
- Test Framework: ${analysis.hasJest ? 'Jest' : analysis.hasVitest ? 'Vitest' : analysis.hasMocha ? 'Mocha' : 'Unknown'}
- ESLint: ${analysis.hasEslint}
- Has SonarQube config: ${analysis.hasSonarConfig}
- Docker available: ${analysis.hasDocker}
- Estimated SLOC: ${analysis.estimatedSloc}
- Test command: ${analysis.testCommand || 'none found'}

## VALID DIMENSIONS (you MUST only use dimensions from this list)

Coverage dimensions:
${coverageDims.map(d => `  - ${d}`).join('\n')}

Error dimensions:
${errorDims.map(d => `  - ${d}`).join('\n')}

Quality dimensions (requires SonarQube):
${qualityDims.map(d => `  - ${d}`).join('\n')}

## INSTRUCTIONS

1. Select dimensions from the VALID DIMENSIONS list above
2. For coverage, prefer "coverage.unit.*" if there's a single test suite
3. For TypeScript projects, include "typescript.errors"
4. For ESLint projects, include "eslint.errors"
5. Only include SonarQube dimensions if Docker is available and you'll recommend it

Respond with ONLY a JSON object (no markdown, no explanation outside JSON):
{
  "dimensions": ["list of dimension paths from VALID DIMENSIONS above"],
  "rationale": "brief explanation of why these dimensions",
  "coverageTarget": <number between 50-90, appropriate for this project size>,
  "recommendSonarQube": <true if Docker available and project is >500 SLOC, false otherwise>
}`;

  try {
    const response = await callClaude(prompt);
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as GeometrySuggestion;
    }
  } catch {
    // Fall back to defaults
  }

  // Default suggestion
  return {
    dimensions: analysis.hasTypeScript
      ? ['coverage.branches', 'coverage.statements', 'typescript.errors', 'eslint.errors']
      : ['coverage.branches', 'coverage.statements', 'eslint.errors'],
    rationale: 'Standard quality dimensions for a TypeScript project',
    coverageTarget: analysis.estimatedSloc > 5000 ? 60 : 70,
    recommendSonarQube: analysis.hasDocker && analysis.estimatedSloc > 500,
  };
}

// =============================================================================
// Interactive Interview
// =============================================================================

/**
 * Reads one line, returning EXACTLY what the user typed -- '' for a bare Enter.
 *
 * Separate from the default-substituting `askQuestion` below because conflating the
 * two is what inverted every yes/no prompt: `askQuestion` returns the DISPLAY string
 * when the input is empty, and for a no-default prompt that display string is
 * `'y/N'`, which starts with `y`.
 */
async function promptForLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askQuestion(question: string, defaultAnswer: string): Promise<string> {
  const typed = await promptForLine(`${question} [${defaultAnswer}]: `);
  return typed || defaultAnswer;
}

/**
 * Which answer a typed line represents, or `undefined` for "the user did not say".
 *
 * A named function over a string rather than a branch inside the prompt, because the
 * whole defect was that the decision was being made on a value that had already had
 * the default substituted into it. Here the empty string is a distinguishable input,
 * which is the only way the caller can honour its own printed default.
 */
export function interpretYesNo(typed: string): boolean | undefined {
  const answer = typed.trim().toLowerCase();
  if (YES_ANSWERS.has(answer)) return true;
  if (NO_ANSWERS.has(answer)) return false;
  return undefined;
}

/**
 * Closed sets rather than a `startsWith` prefix test, and the prompt text is why.
 *
 * `'y/N'.toLowerCase().startsWith('y')` is TRUE. That is not a hypothetical -- it is
 * precisely the bug being fixed, where the display string reached the interpreter and
 * was read as a yes. A prefix test leaves that landmine armed for the next caller who
 * passes something other than a typed line, so the reading is exact.
 *
 * Matches how `QUALITY_COVERAGE_REQUIRED` is parsed in config.ts: a closed set of
 * recognised words, with everything else falling to the safe answer rather than being
 * guessed at. Here the safe answer is the default the prompt printed.
 */
const YES_ANSWERS = new Set(['y', 'yes']);
const NO_ANSWERS = new Set(['n', 'no']);

/**
 * A yes/no prompt whose default is the one it prints.
 *
 * It printed `[y/N]` and answered YES on a bare Enter. `askQuestion` returns
 * `answer.trim() || defaultAnswer`, where `defaultAnswer` was the display string
 * `'y/N'` -- so pressing Enter returned the literal `"y/N"`, and
 * `"y/n".startsWith('y')` is true. The `Y/n` branch was correct only by accident,
 * since `!"y/n".startsWith('n')` is also true.
 *
 * Not a cosmetic prompt bug. Both call sites change what the generated config
 * CONTAINS: `Enable strict mode? (zero tolerance for type/lint errors)` writes
 * `typescript.errors: 0` and `eslint.errors: 0`, so an adopter who read `[y/N]` as
 * "the safe default is no" and pressed Enter got the zero-tolerance ruleset anyway
 * -- from a command whose entire purpose is to write a configuration the gate can
 * actually satisfy. The other enables SonarQube, which then needs a server.
 *
 * An unrecognised line ("maybe", "1") also takes the default, deliberately: the
 * default is printed on the same line, so falling back to it is the answer the user
 * can already see, rather than a guess at what they meant.
 */
async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const typed = await promptForLine(`${question} [${defaultYes ? 'Y/n' : 'y/N'}]: `);
  return interpretYesNo(typed) ?? defaultYes;
}

export interface InterviewAnswers {
  useSonarQube: boolean;
  coverageTarget: number;
  testCommand: string;
  strictMode: boolean;
}

/**
 * Says out loud what the test-command choice means for coverage.
 *
 * Called from `conductInterview` ABOVE the `options.yes` early return, which is
 * the entire fix: the warning used to sit below it, so the one adopter who never
 * sees a prompt -- and therefore cannot correct the choice interactively -- was
 * the only adopter who never got the warning. `-y` is also the path CI uses.
 *
 * Emitted BEFORE the test-command question so an interactive adopter can answer
 * it differently.
 */
export function reportTestCommandChoice(analysis: RepoAnalysis): void {
  if (!analysis.testCommand) return;

  if (analysis.testCommandWritesCoverage) {
    // Only worth saying when the coverage-writing script was NOT the
    // name-preferred one, i.e. when the two-key ranking actually changed the
    // pick. Otherwise it is noise.
    const skipped = analysis.testScriptCandidates
      .slice(0, analysis.testScriptCandidates.findIndex((c) => c.name === analysis.testCommand))
      .map((c) => c.name);
    if (skipped.length > 0) {
      console.error(
        `\nUsing \`${analysis.packageManager.manager} run ${analysis.testCommand}\` as the test command: it writes a coverage ` +
          `report, and \`${skipped.join('`, `')}\` do${skipped.length === 1 ? 'es' : ''} not. ` +
          'The generated coverage floors are graded against the report the gate itself produces.'
      );
    }
    return;
  }

  console.error(
    `\nNote: \`${analysis.packageManager.manager} run ${analysis.testCommand}\` does not appear to write a coverage report, ` +
      'so the gate cannot measure coverage on the commit it is grading.'
  );

  const better = analysis.coverageWritingScripts.filter((name) => name !== analysis.testCommand);
  if (better.length > 0) {
    console.error(
      `      \`${better.join('`, `')}\` look${better.length === 1 ? 's' : ''} like it writes one -- ` +
        'prefer that, or no coverage floors will be generated.'
    );
  } else {
    console.error(
      '      No script in this package.json looks like it writes one, so no coverage floors will ' +
        'be generated. Add e.g. "test:coverage": "vitest run --coverage" and re-run init.'
    );
  }
}

export async function conductInterview(
  analysis: RepoAnalysis,
  suggestion: GeometrySuggestion,
  options: InitOptions
): Promise<InterviewAnswers> {
  reportTestCommandChoice(analysis);

  if (options.yes) {
    // Accept all defaults
    return {
      useSonarQube: !options.noDocker && suggestion.recommendSonarQube,
      coverageTarget: suggestion.coverageTarget,
      testCommand: analysis.testCommand || 'test',
      strictMode: false,
    };
  }

  console.error('\n--- Quality Gate Configuration ---\n');
  console.error(`LLM Analysis: ${suggestion.rationale}\n`);

  const useSonarQube = options.noDocker
    ? false
    : await askYesNo(
        `Use SonarQube for deep analysis? (requires Docker)`,
        suggestion.recommendSonarQube && analysis.hasDocker
      );

  const coverageInput = await askQuestion(
    `Target branch coverage percentage`,
    String(suggestion.coverageTarget)
  );
  const coverageTarget = parseInt(coverageInput, 10) || suggestion.coverageTarget;

  const testCommand = await askQuestion(
    `Test command (npm script name)`,
    analysis.testCommand || 'test'
  );

  const strictMode = await askYesNo(
    `Enable strict mode? (zero tolerance for type/lint errors)`,
    false
  );

  return { useSonarQube, coverageTarget, testCommand, strictMode };
}

// =============================================================================
// Metrics Collection (for calibration)
// =============================================================================

/**
 * What running the project's own test script told us about coverage.
 *
 * A discriminated union rather than two nullable numbers because the four
 * outcomes want four different configs, and `number | null` collapsed the two
 * that matter most into one value:
 *
 *   'measured'         a report was written by THIS run and read. A `null`
 *                      dimension means the report has a ZERO denominator for it,
 *                      i.e. the dimension does not exist in this codebase.
 *   'measured-nothing' every denominator was zero: the coverage tool
 *                      instrumented nothing at all. The gate reports this as a
 *                      `measured-nothing` measurement failure.
 *   'unreadable'       a report exists but is not an istanbul summary, or has a
 *                      non-numeric pct over a non-zero denominator. The gate
 *                      reports this as `unparseable-output`.
 *   'not-written'      the run left no fresh report behind. Usually because the
 *                      script writes no coverage -- and the gate running that
 *                      same script will not notice, it will grade whatever report
 *                      is already on disk (backlog #39). Which is why init
 *                      refuses to calibrate from one and says so.
 */
export type CoverageCalibration =
  | {
      readonly kind: 'measured';
      readonly reportPath: string;
      readonly branches: number | null;
      readonly statements: number | null;
    }
  | { readonly kind: 'measured-nothing'; readonly detail: string }
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'not-written'; readonly detail: string };

/**
 * A finding count init can calibrate a ceiling from, or the reason it cannot.
 *
 * A plain `number` was the shape here, initialised to 0 and left there when the
 * measurement failed -- so a crashed linter wrote `eslint.errors: 0` into the
 * generated rules. That is the permanently-red build the coverage calibration
 * above goes to such lengths to avoid, arrived at by a different route: the gate
 * later measures eslint successfully, finds the project's real findings, and
 * fails against a ceiling that was never a reading of anything.
 *
 * Same discriminated shape as CoverageCalibration, for the same reason: the
 * decision "should this dimension be graded at all" cannot be made from a number
 * that has lost the distinction between zero and unknown.
 */
export type CountCalibration =
  | { readonly kind: 'measured'; readonly errors: number }
  | { readonly kind: 'unmeasurable'; readonly detail: string };

export interface CalibrationMetrics {
  coverage: CoverageCalibration;
  typescript: CountCalibration;
  eslint: CountCalibration;
}

/** The four dimensions an istanbul `total` reports, in report order. */
const COVERAGE_DIMENSIONS = ['statements', 'branches', 'functions', 'lines'] as const;

type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

/**
 * Reads a coverage `total` the way the GATE reads it.
 *
 * Deliberately duplicates the denominator logic in
 * `src/providers/coverage.ts:extractFromTotal` instead of calling the provider,
 * for one reason: the provider now reports a zero-denominator dimension as
 * **100** (0 of 0 branches covered is complete coverage), so by the time a number
 * comes out of it a vacuous 100 and a real 100 are indistinguishable. Init needs
 * the denominators themselves, because "this codebase has no branches" and "this
 * codebase's branches are fully covered" call for different configs -- the first
 * gets no branches floor at all.
 *
 * Three things `?? null` used to wave through here, all measured:
 *
 *   - the STRING "Unknown", which istanbul's `blankSummary` emits for a report
 *     with no file entries. It survived `?? null`, then threw
 *     `TypeError: coverageBranches?.toFixed is not a function` -- so `init`
 *     crashed rather than calibrating.
 *   - NaN, which `Math.round` preserves and `JSON.stringify` writes into the
 *     generated rules.json as `null`. A floor of null is PERMANENTLY satisfied
 *     (`0 < null` is false), so init could commit a coverage floor that can
 *     never fail.
 *   - a vacuous 100 from a zero denominator, which pinned the generated floor to
 *     exactly `coverageTarget` and was then cleared by the same vacuous 100.
 */
export function classifyCoverageTotal(total: unknown, reportPath: string): CoverageCalibration {
  const entryOf = (dimension: CoverageDimension) =>
    ((total ?? {}) as Record<string, unknown>)[dimension] as
      | { total?: unknown; pct?: unknown }
      | undefined;

  const denominators = COVERAGE_DIMENSIONS.map((dimension) => ({
    dimension,
    denominator: entryOf(dimension)?.total,
  }));

  const malformed = denominators.filter(
    (d) => typeof d.denominator !== 'number' || !Number.isFinite(d.denominator)
  );
  if (malformed.length > 0) {
    return {
      kind: 'unreadable',
      detail:
        `${reportPath} has no numeric denominator for ` +
        `${malformed.map((d) => `total.${d.dimension}.total`).join(', ')}, so it cannot be read ` +
        'as an istanbul coverage summary.',
    };
  }

  if (denominators.every((d) => d.denominator === 0)) {
    return {
      kind: 'measured-nothing',
      detail:
        `${reportPath} reports 0 statements, 0 branches, 0 functions and 0 lines, so the ` +
        "coverage tool instrumented nothing. Check the tool's include/exclude patterns.",
    };
  }

  const read: Partial<Record<CoverageDimension, number | null>> = {};
  for (const { dimension, denominator } of denominators) {
    if (denominator === 0) {
      // Not an error, and not a number either. istanbul renders 0/0 as 100%, so
      // any floor calibrated from it is cleared by the same vacuous 100.
      read[dimension] = null;
      continue;
    }
    const pct = entryOf(dimension)?.pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) {
      return {
        kind: 'unreadable',
        detail:
          `${reportPath} reports total.${dimension}.pct as ${JSON.stringify(pct)} over ` +
          `${String(denominator)} ${dimension}, which is not a percentage.`,
      };
    }
    read[dimension] = pct;
  }

  return {
    kind: 'measured',
    reportPath,
    branches: read.branches ?? null,
    statements: read.statements ?? null,
  };
}

/**
 * The coverage summaries the GATE will read, in the order init tries them.
 *
 * From the same config the gate uses, so that `QUALITY_COVERAGE_UNIT_DIR` moves
 * both readers together. `coverage-unit/` is kept as a second candidate because
 * it was hardcoded here before this config existed.
 */
function coverageSummaryCandidates(projectRoot: string): readonly string[] {
  const { unitDir, summaryFile } = loadConfig().coverage;
  const candidates = [
    path.join(projectRoot, unitDir, summaryFile),
    path.join(projectRoot, 'coverage-unit', summaryFile),
  ];
  return Array.from(new Set(candidates));
}

function mtimeMsOf(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function collectCalibrationMetrics(
  projectRoot: string,
  testCommand: string,
  hasTypeScript: boolean,
  selection: RunnerSelection
): CalibrationMetrics {
  // Both counts start UNMEASURABLE rather than at zero. The old initialiser was 0,
  // and every path that failed to overwrite it -- a project with no TypeScript, a
  // crashed linter -- silently contributed a calibrated ceiling of zero.
  const metrics: CalibrationMetrics = {
    coverage: { kind: 'not-written', detail: 'coverage was not measured' },
    typescript: { kind: 'unmeasurable', detail: 'the type-check was not run' },
    eslint: { kind: 'unmeasurable', detail: 'the linter was not run' },
  };

  console.error('\nCollecting current metrics for calibration...');

  // Run the script EXACTLY as the gate will run it -- no appended `--coverage`.
  //
  // init used to run `npm run <test> -- --coverage` while the gate runs
  // `npm run <test>`, so for any project whose script is a plain `vitest run`
  // init measured coverage that the gate could never reproduce, and then wrote
  // floors for it. MEASURED on a throwaway vitest 4 project: `npm run test --
  // --coverage` wrote coverage/coverage-summary.json, and the following plain
  // `npm run test` left that file's mtime byte-identical -- 1785813628.932283583
  // before and after. Calibrating from a report the gate cannot refresh is how
  // init shipped a config its own gate rejects.
  const coveragePaths = coverageSummaryCandidates(projectRoot);
  const mtimesBefore = new Map(coveragePaths.map((p) => [p, mtimeMsOf(p)]));

  // "Exactly as the gate will" now includes WHICH RUNNER. Hardcoding npm here while
  // the gate resolves bun would calibrate from one toolchain and grade with another,
  // which is the same class of mismatch as the `-- --coverage` bug above.
  const test = scriptCommand(testCommand, selection);
  console.error(`  Running \`${test.display}\` (exactly as the gate will)...`);
  const testRun = spawnSync(test.executable, [...test.args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: 300000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Freshness by mtime, not by existence, and this is init's own rule rather than
  // the gate's: the gate does not judge a report's age at all (backlog #39). What
  // init must not do is write floors calibrated from a report THIS run did not
  // produce, because those floors would be a claim about code nobody measured.
  // The comparison is sound here in a way it was not as a gate rule -- init took
  // the `before` stat itself, seconds earlier, in this process.
  const refreshed = coveragePaths.filter((p) => {
    const after = mtimeMsOf(p);
    if (after === null) return false;
    const before = mtimesBefore.get(p) ?? null;
    return before === null || after > before;
  });

  if (refreshed.length === 0) {
    const stale = coveragePaths.filter((p) => mtimesBefore.get(p) !== null);
    metrics.coverage = {
      kind: 'not-written',
      detail:
        `\`${test.display}\` exited ${String(testRun.status)} and wrote no coverage ` +
        `report to ${coveragePaths.join(' or ')}.` +
        (stale.length > 0
          ? ` ${stale.join(', ')} exists but was not rewritten by this run, so it describes an ` +
            'earlier generation of the code and cannot be calibrated from.'
          : ''),
    };
    console.error(`  Coverage: not measured -- ${metrics.coverage.detail}`);
  } else {
    const reportPath = refreshed[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    } catch (error) {
      parsed = undefined;
      metrics.coverage = {
        kind: 'unreadable',
        detail: `${reportPath} is not valid JSON (${String(error)}).`,
      };
    }
    if (parsed !== undefined) {
      metrics.coverage = classifyCoverageTotal(
        (parsed as { total?: unknown }).total,
        reportPath
      );
    }

    const { coverage } = metrics;
    if (coverage.kind === 'measured') {
      const show = (dimension: string, pct: number | null) =>
        pct === null ? `no ${dimension} in this codebase` : `${pct.toFixed(1)}% ${dimension}`;
      console.error(
        `  Coverage: ${show('branches', coverage.branches)}, ` +
          `${show('statements', coverage.statements)}`
      );
    } else {
      console.error(`  Coverage: ${coverage.kind} -- ${coverage.detail}`);
    }
  }

  // Both dimensions now go through the SAME providers the gate uses, rather than
  // init's own second implementation of each. That duplication was not merely
  // untidy, it disagreed with the gate in three measured ways:
  //
  //   - it ran `npx tsc --noEmit` where the gate runs the project's `type-check`
  //     script, so a project whose script passes flags (a different tsconfig, a
  //     project reference) was calibrated against a DIFFERENT type-check than the
  //     one that would grade it;
  //   - it parsed eslint with `JSON.parse(stdout || '[]')`, the exact fallback the
  //     lint provider was fixed to remove: a crashed eslint became zero findings,
  //     and zero findings became a `eslint.errors: 0` ceiling;
  //   - it hardcoded npm, so on a bun project init measured with a runner the gate
  //     would not use.
  //
  // A provider returns a MeasurementFailure instead of a number when it cannot
  // measure, which is what makes the `unmeasurable` case below expressible at all.
  const context = {
    projectRoot,
    maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
    packageManager: selection,
    typecheckScript: detectTypecheckScript(projectRoot),
  };

  if (hasTypeScript) {
    console.error('  Checking TypeScript...');
    const reading = typescriptTypecheckProvider.measure({
      ...context,
      timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
    });
    metrics.typescript = reading.ok
      ? { kind: 'measured', errors: reading.value.metrics.errors }
      : { kind: 'unmeasurable', detail: reading.error.message };
    console.error(
      metrics.typescript.kind === 'measured'
        ? `  TypeScript errors: ${metrics.typescript.errors}`
        : `  TypeScript: could not measure -- ${metrics.typescript.detail}`
    );
  }

  console.error('  Checking ESLint...');
  const lint = eslintLintProvider.measure({
    ...context,
    timeoutMs: DEFAULT_MEASUREMENT_LIMITS.lintTimeoutMs,
  });
  metrics.eslint = lint.ok
    ? { kind: 'measured', errors: lint.value.metrics.errors }
    : { kind: 'unmeasurable', detail: lint.error.message };
  console.error(
    metrics.eslint.kind === 'measured'
      ? `  ESLint errors: ${metrics.eslint.errors}`
      : `  ESLint: could not measure -- ${metrics.eslint.detail}`
  );

  return metrics;
}

// =============================================================================
// Config Generation
// =============================================================================

/**
 * The coverage floors and ratchets this project can actually be graded on.
 *
 * Every omission here is a dimension the gate would refuse to grade, and writing
 * a floor for one of those is not strictness -- it is a permanently red build
 * with no edit that clears it. The four cases:
 *
 *   a MEASURED dimension          -> floor at current minus a small buffer.
 *   a ZERO-DENOMINATOR dimension  -> NO floor and NO ratchet. The gate now
 *     reports 0-of-0 as 100% (a file with no branches IS fully branch-covered),
 *     so a floor here would technically pass -- but it would be calibrated from a
 *     measurement of nothing, and worse, RATCHETING it at 100 fails the build the
 *     day someone writes the codebase's first `if`. MEASURED on a branchless
 *     vitest 4 project: `total.branches` was `{total: 0, covered: 0, pct: 100}`,
 *     and adding a single ternary made it `{total: 2, covered: 1, pct: 50}` -- so
 *     the first real branch is a 50-point "regression" against the vacuous
 *     baseline. Not gating a dimension the codebase does not have costs nothing,
 *     because there is nothing to regress.
 *   a report the gate cannot READ (`measured-nothing`, `unparseable-output`)
 *     -> no floors. The gate reports the broken report either way; adding floors
 *     only converts a diagnosable warning into a build nobody can fix from here.
 *   NO report written by the test script -> no floors, UNLESS the script looks
 *     like it writes coverage, in which case this is the day-one repo (a
 *     `test:coverage` script and no tests yet) and floors from the interview
 *     target are the long-standing, legitimate behaviour.
 */
export function calibrateCoverageRules(
  analysis: RepoAnalysis,
  answers: InterviewAnswers,
  calibration: CoverageCalibration
): {
  readonly floors: Record<string, number>;
  readonly ratchet: readonly string[];
  readonly notes: readonly string[];
} {
  const floors: Record<string, number> = {};
  const notes: string[] = [];

  if (calibration.kind === 'measured') {
    // "Barely passing": current value minus a small buffer, capped by the target.
    if (calibration.branches !== null) {
      floors['coverage.unit.branches'] = Math.round(
        Math.min(Math.max(calibration.branches - 5, 0), answers.coverageTarget)
      );
    } else {
      notes.push(
        'No `coverage.unit.branches` floor was generated: the coverage report has 0 branches, so ' +
          'this codebase has none to cover. The gate reports 0-of-0 as 100%; a floor calibrated ' +
          'from that measures nothing, and a ratchet on it would fail the first time a real ' +
          'branch appears.'
      );
    }

    if (calibration.statements !== null) {
      floors['coverage.unit.statements'] = Math.round(
        Math.min(Math.max(calibration.statements - 5, 0), answers.coverageTarget + 10)
      );
    } else {
      notes.push(
        'No `coverage.unit.statements` floor was generated: the coverage report has 0 statements ' +
          'to cover.'
      );
    }
  } else if (
    calibration.kind === 'not-written' &&
    scriptWritesCoverage(
      answers.testCommand,
      scriptsOf(analysis.packageJson)[answers.testCommand] ?? ''
    )
  ) {
    // No report YET, but the script the gate will run is the kind that writes
    // one. Floors from the interview target, as init has always done.
    floors['coverage.unit.branches'] = Math.round(Math.max(answers.coverageTarget - 10, 30));
    floors['coverage.unit.statements'] = Math.round(Math.max(answers.coverageTarget, 40));
    notes.push(
      `Coverage floors are derived from your target of ${answers.coverageTarget}%, not from a ` +
        `measurement: ${calibration.detail}. Re-run init once \`${analysis.packageManager.manager} run ${answers.testCommand}\` ` +
        'produces a report, or adjust them by hand.'
    );
  } else {
    notes.push(
      `No coverage floors were generated: ${'detail' in calibration ? calibration.detail : ''} ` +
        'A floor the gate cannot measure fails forever, so init writes none. Add a ' +
        'coverage-writing script (e.g. "test:coverage": "vitest run --coverage"), put it in ' +
        '`requiredScripts`, and re-run init.'
    );
  }

  return {
    floors,
    // Ratchet exactly the dimensions that got a floor: same evidence, same
    // eligibility. A monotonic rule on an unmeasurable dimension is skipped
    // silently by the gate, which is the "passes as a skipped rule" shape this
    // whole change exists to stop generating.
    ratchet: Object.keys(floors),
    notes,
  };
}

export function generateConfig(
  analysis: RepoAnalysis,
  suggestion: GeometrySuggestion,
  answers: InterviewAnswers,
  metrics: CalibrationMetrics
): GeneratedConfig {
  const coverage = calibrateCoverageRules(analysis, answers, metrics.coverage);
  for (const note of coverage.notes) {
    console.error(`  ${note}`);
  }

  const rules: GeneratedConfig['rules'] = {
    version: '1.0.0',
    description:
      `Quality gates for ${path.basename(process.cwd())} - Generated by quality-gate-sgd init` +
      (coverage.ratchet.length > 0
        ? `. The coverage floors are graded against the report \`${analysis.packageManager.manager} run ${answers.testCommand}\` ` +
          'writes, which is why that script is in requiredScripts: replace it with another and ' +
          'the floors are graded against whatever generation of the code last wrote coverage.'
        : ''),
    rules: {
      floors: coverage.floors,
      ceilings: {},
      monotonic:
        coverage.ratchet.length > 0
          ? [{ direction: 'up', metrics: [...coverage.ratchet] }]
          : [],
      requiredScripts: [answers.testCommand],
    },
  };

  // A ceiling at the CURRENT count needs a current count. When the measurement
  // failed, there is no honest number to put here, and the old code's `0` was the
  // worst possible choice: the gate measures the dimension successfully on the next
  // run, finds the project's real findings, and fails against a ceiling that was
  // never a reading -- a red build with no edit that clears it. Omitting the rule
  // leaves the dimension ungraded, which the gate reports loudly on every run until
  // someone adds a rule, and that is the outcome that converges.
  //
  // `strictMode` is exempt because a ceiling of 0 there is the USER'S stated intent
  // rather than a calibration, so it needs no measurement to justify it.
  const gradeCount = (
    dimension: 'typescript.errors' | 'eslint.errors',
    calibration: CountCalibration
  ) => {
    if (answers.strictMode) {
      rules.rules.ceilings[dimension] = 0;
      return;
    }
    if (calibration.kind !== 'measured') return;
    rules.rules.ceilings[dimension] = calibration.errors;
    rules.rules.monotonic.push({ direction: 'down', metrics: [dimension] });
  };

  if (analysis.hasTypeScript) gradeCount('typescript.errors', metrics.typescript);
  if (analysis.hasEslint) gradeCount('eslint.errors', metrics.eslint);

  // Add SonarQube rules if enabled
  if (answers.useSonarQube) {
    rules.rules.ceilings['sonarqube.blocker'] = 0;
    rules.rules.ceilings['sonarqube.critical'] = 0;
    rules.rules.monotonic.push({
      direction: 'down',
      metrics: ['sonarqube.bugs', 'sonarqube.vulnerabilities'],
    });
  }

  // Generate explanation
  const explanation = generateExplanation(analysis, suggestion, answers, metrics, rules);

  return { rules, explanation };
}

function generateExplanation(
  analysis: RepoAnalysis,
  suggestion: GeometrySuggestion,
  answers: InterviewAnswers,
  metrics: CalibrationMetrics,
  rules: GeneratedConfig['rules']
): string {
  const lines: string[] = [
    '# Quality Gate Configuration',
    '',
    '> Generated by `quality-gate-sgd init`',
    '',
    '## Overview',
    '',
    'This project uses deterministic quality gates to create consistent improvement',
    'pressure on code quality. The gates are calibrated to your current metrics,',
    'ensuring you can pass immediately while requiring monotonic improvement.',
    '',
    '## Quality Dimensions',
    '',
    '| Dimension | Current | Floor/Ceiling | Monotonic |',
    '|-----------|---------|---------------|-----------|',
  ];

  // Coverage.
  //
  // Driven by what the config ACTUALLY gates rather than by what was measured:
  // a dimension with no floor used to print `≥undefined%`, and a dimension the
  // codebase does not have used to print nothing at all, so QUALITY.md silently
  // disagreed with rules.json in both directions.
  const coverageRow = (label: string, dimension: 'branches' | 'statements'): void => {
    const floor = rules.rules.floors[`coverage.unit.${dimension}`];
    const measured =
      metrics.coverage.kind === 'measured' ? metrics.coverage[dimension] : undefined;
    const current =
      measured === undefined
        ? 'not measured'
        : measured === null
          ? `none in this codebase (0 ${dimension})`
          : `${measured.toFixed(1)}%`;
    lines.push(
      floor === undefined
        ? `| ${label} | ${current} | not gated | - |`
        : `| ${label} | ${current} | ≥${floor}% | ↑ |`
    );
  };
  coverageRow('Branch Coverage', 'branches');
  coverageRow('Statement Coverage', 'statements');

  // An unmeasurable dimension gets a row that says so, rather than a number sitting
  // beside a ceiling that was never written. The old shape printed `0 | ≤undefined`.
  const countRow = (label: string, dimension: string, calibration: CountCalibration) => {
    if (calibration.kind !== 'measured') {
      lines.push(`| ${label} | not measured | (no rule written) | -- |`);
      return;
    }
    lines.push(`| ${label} | ${calibration.errors} | ≤${rules.rules.ceilings[dimension]} | ↓ |`);
  };
  if (analysis.hasTypeScript) {
    countRow('TypeScript Errors', 'typescript.errors', metrics.typescript);
  }
  if (analysis.hasEslint) countRow('ESLint Errors', 'eslint.errors', metrics.eslint);

  lines.push('');
  for (const note of calibrateCoverageRules(analysis, answers, metrics.coverage).notes) {
    lines.push(`> ${note}`);
    lines.push('');
  }
  lines.push('## Measuring Coverage');
  lines.push('');
  lines.push(
    `The coverage numbers above are read from the report that \`${analysis.packageManager.manager} run ${answers.testCommand}\` ` +
      'writes, which is why that script is in `requiredScripts`. The gate reads the report AFTER ' +
      'running those scripts, so if you replace it with a script that writes no coverage report, ' +
      'the floors below are graded against whatever report was last left in the coverage ' +
      'directory -- and the gate cannot tell that it is grading older code.'
  );
  lines.push('');
  lines.push('## How It Works');
  lines.push('');
  lines.push('1. **Floors**: Minimum acceptable values (coverage must stay above)');
  lines.push('2. **Ceilings**: Maximum acceptable values (errors must stay below)');
  lines.push('3. **Monotonic**: Values can only improve, never regress');
  lines.push('');
  lines.push('The monotonic rules create a "ratchet" effect: once quality improves,');
  lines.push('it cannot go back. This creates consistent descent toward higher quality.');
  lines.push('');
  lines.push('## Usage');
  lines.push('');
  lines.push('```bash');
  lines.push('# Run quality gate');
  lines.push('npx quality-gate-sgd');
  lines.push('');
  lines.push('# View trajectory (after multiple runs)');
  lines.push('npx quality-gate-sgd trajectory');
  lines.push('```');
  lines.push('');

  if (answers.useSonarQube) {
    lines.push('## SonarQube');
    lines.push('');
    lines.push('This configuration uses SonarQube for deep analysis. Ensure Docker is running:');
    lines.push('');
    lines.push('```bash');
    lines.push('# Start SonarQube');
    lines.push('docker run -d --name sonarqube -p 9000:9000 sonarqube:latest');
    lines.push('```');
    lines.push('');
  }

  lines.push('## Theory');
  lines.push('');
  lines.push('This system is based on the principle that deterministic quality gates');
  lines.push('create gradient descent-like behavior from stochastic agents (like LLMs).');
  lines.push('See the [quality-gate-sgd documentation](https://github.com/your-org/quality-gate-sgd)');
  lines.push('for the theoretical foundation.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*Calibrated on ${new Date().toISOString().split('T')[0]} with SLOC ≈ ${analysis.estimatedSloc}*`);

  return lines.join('\n');
}

// =============================================================================
// Main Init Function
// =============================================================================

export async function runInit(args: string[]): Promise<void> {
  const options: InitOptions = {
    yes: args.includes('-y') || args.includes('--yes'),
    noDocker: args.includes('--docker=no') || args.includes('--no-docker'),
    verbose: args.includes('-v') || args.includes('--verbose'),
  };

  const projectRoot = process.cwd();

  console.error('Quality Gate SGD - Initialization');
  console.error('==================================\n');

  // Check for LLM availability
  const hasClaudeCli = checkClaudeCli();
  const hasApiKey = checkAnthropicKey();

  if (!hasClaudeCli && !hasApiKey) {
    console.error('Warning: No LLM available for intelligent topology suggestion.');
    console.error('  Install Claude CLI: npm install -g @anthropic-ai/claude-cli');
    console.error('  Or set ANTHROPIC_API_KEY environment variable');
    console.error('  Proceeding with default configuration...\n');
  } else {
    console.error(`LLM: ${hasClaudeCli ? 'Claude CLI' : 'Anthropic API'}\n`);
  }

  // Analyze repository
  console.error('Analyzing repository...');
  const analysis = analyzeRepo(projectRoot);

  if (options.verbose) {
    console.error(`  TypeScript: ${analysis.hasTypeScript}`);
    console.error(`  Test framework: ${analysis.hasJest ? 'Jest' : analysis.hasVitest ? 'Vitest' : 'Unknown'}`);
    console.error(`  ESLint: ${analysis.hasEslint}`);
    console.error(`  Docker: ${analysis.hasDocker}`);
    console.error(`  SLOC: ~${analysis.estimatedSloc}`);
  }

  // Get geometry suggestion from LLM
  console.error('Getting topology suggestion...');
  const suggestion = await suggestGeometry(analysis);

  if (options.verbose) {
    console.error(`  Suggested dimensions: ${suggestion.dimensions.join(', ')}`);
    console.error(`  Rationale: ${suggestion.rationale}`);
  }

  // Conduct interview (or use defaults with -y)
  const answers = await conductInterview(analysis, suggestion, options);

  // Taken from the analysis, not detected again here. One detection per run means
  // the advice printed above and the measurement below cannot disagree.
  console.error(
    `\nRunner: ${analysis.packageManager.manager} (${analysis.packageManager.reason})`
  );

  const metrics = collectCalibrationMetrics(
    projectRoot,
    answers.testCommand,
    analysis.hasTypeScript,
    analysis.packageManager
  );

  // Generate configuration
  console.error('\nGenerating configuration...');
  const config = generateConfig(analysis, suggestion, answers, metrics);

  // Write rules.json
  const rulesPath = path.join(projectRoot, 'rules.json');
  fs.writeFileSync(rulesPath, JSON.stringify(config.rules, null, 2));
  console.error(`  Created: rules.json`);

  // Write QUALITY.md
  const qualityMdPath = path.join(projectRoot, 'QUALITY.md');
  fs.writeFileSync(qualityMdPath, config.explanation);
  console.error(`  Created: QUALITY.md`);

  // Create sonar-project.properties if using SonarQube and doesn't exist
  if (answers.useSonarQube && !analysis.hasSonarConfig) {
    const sonarConfig = [
      `sonar.projectKey=${path.basename(projectRoot)}`,
      'sonar.sources=src',
      'sonar.tests=src',
      'sonar.test.inclusions=**/*.test.ts,**/*.test.tsx,**/*.spec.ts',
      'sonar.javascript.lcov.reportPaths=coverage/lcov.info',
      'sonar.typescript.lcov.reportPaths=coverage/lcov.info',
    ].join('\n');
    fs.writeFileSync(path.join(projectRoot, 'sonar-project.properties'), sonarConfig);
    console.error(`  Created: sonar-project.properties`);
  }

  console.error('\n✓ Initialization complete!\n');

  // The one thing the adopter cannot discover from rules.json, because it is an
  // ABSENCE: coverage is not being gated, and why.
  if (Object.keys(config.rules.rules.floors).length === 0) {
    console.error(
      'Coverage is NOT gated by this configuration. A floor on a dimension the gate cannot ' +
        `measure fails on every run with no edit that clears it, so init wrote none. \`npm run ` +
        `${answers.testCommand}\` is what the gate will run; give it a --coverage flag, or add a ` +
        'script that has one and re-run init, to get coverage floors.\n'
    );
  }

  console.error('Next steps:');
  console.error('  1. Review rules.json and adjust thresholds if needed');
  console.error('  2. Run: npx quality-gate-sgd');
  if (answers.useSonarQube) {
    console.error('  3. Start SonarQube: docker run -d --name sonarqube -p 9000:9000 sonarqube:latest');
  }
  console.error('');
}
