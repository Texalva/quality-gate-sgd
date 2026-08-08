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
import { detectPackageManager, detectTypecheckScript, scriptCommand, } from './runner.js';
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
const TEST_SCRIPT_CANDIDATES = ['test:coverage', 'coverage', 'test', 'test:unit'];
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
export function scriptWritesCoverage(name, body) {
    return COVERAGE_WRITING_SCRIPT.test(`${name} ${body}`);
}
/** The scripts declared in package.json, as strings only. */
function scriptsOf(packageJson) {
    const scripts = packageJson?.scripts || {};
    return Object.fromEntries(Object.entries(scripts).filter((entry) => typeof entry[1] === 'string'));
}
export function analyzeRepo(projectRoot) {
    const analysis = {
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
            const pkg = analysis.packageJson;
            // Check dependencies
            const allDeps = {
                ...(pkg.dependencies || {}),
                ...(pkg.devDependencies || {}),
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
            const candidates = TEST_SCRIPT_CANDIDATES.filter((name) => name in scripts).map((name) => ({ name, writesCoverage: scriptWritesCoverage(name, scripts[name]) }));
            // `find` keeps the name order WITHIN the coverage-writing group, which is
            // what makes this a two-key sort rather than a rewrite of the priority.
            const chosen = candidates.find((c) => c.writesCoverage) ?? candidates[0];
            analysis.testScriptCandidates = candidates;
            analysis.coverageWritingScripts = Object.keys(scripts).filter((name) => scriptWritesCoverage(name, scripts[name]));
            if (chosen) {
                analysis.testCommand = chosen.name;
                analysis.testCommandWritesCoverage = chosen.writesCoverage;
            }
        }
        catch {
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
    }
    catch {
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
function estimateSloc(dir) {
    let count = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) {
                count += estimateSloc(fullPath);
            }
            else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                count += content.split('\n').filter(line => line.trim() && !line.trim().startsWith('//')).length;
            }
        }
    }
    catch {
        // Ignore errors
    }
    return count;
}
// =============================================================================
// LLM Integration
// =============================================================================
/**
 * Which model the direct-API path asks, and why it is not a literal.
 *
 * A pinned id rots on a schedule nobody controls. When the API rejects an unknown
 * model, `suggestGeometry` falls back to its built-in defaults -- correct behaviour,
 * and until now an invisible one: an adopter with a key set believed they had an
 * LLM-suggested coverage target and had the hardcoded one. Reading it from the
 * environment makes the next deprecation a config change instead of a release, and
 * the disclosure below makes the fallback impossible to mistake for an answer.
 *
 * Only the direct-API path uses it. The Claude CLI picks its own model.
 */
export const INIT_MODEL_ENV_VAR = 'QUALITY_INIT_MODEL';
const DEFAULT_INIT_MODEL = 'claude-sonnet-5';
function initModel() {
    return process.env[INIT_MODEL_ENV_VAR] || DEFAULT_INIT_MODEL;
}
function checkClaudeCli() {
    try {
        const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 });
        return result.status === 0;
    }
    catch {
        return false;
    }
}
function checkAnthropicKey() {
    return !!process.env.ANTHROPIC_API_KEY;
}
/**
 * Every exit from here is either an answer or a stated reason, never an empty string.
 *
 * It used to return `''` when the API responded with something that had no
 * `content[0].text` -- which is exactly the shape of an API ERROR body, so an expired
 * key, a rejected model id or a rate limit all produced a successful-looking empty
 * answer. `suggestGeometry` then found no JSON in it and took its defaults, silently.
 * Throwing with the API's own `error.message` is the difference between "the LLM
 * suggested these numbers" and "the LLM said your key is invalid".
 */
async function callClaude(prompt) {
    const attempts = [];
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
        // A CLI that is installed and then fails is worth naming. `checkClaudeCli` runs
        // `claude --version` under a 5s timeout, so a slow-but-working CLI is reported as
        // absent -- and that verdict is now visible here rather than being the reason a
        // config quietly came from defaults.
        attempts.push(`claude CLI exited ${result.status ?? 'on a signal'}` +
            `${result.stderr ? `: ${String(result.stderr).trim().slice(0, 200)}` : ''}`);
    }
    else {
        attempts.push('claude CLI not on PATH (or `claude --version` took over 5s)');
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
                model: initModel(),
                max_tokens: 2048,
                messages: [{ role: 'user', content: prompt }],
            }),
        ], {
            encoding: 'utf-8',
            timeout: 60000,
        });
        if (result.stdout) {
            try {
                const response = JSON.parse(result.stdout);
                const text = response.content?.[0]?.text;
                if (text)
                    return text;
                attempts.push(response.error
                    ? `API (${initModel()}) returned ${response.error.type ?? 'an error'}: ` +
                        `${response.error.message ?? 'no message'}`
                    : `API (${initModel()}) returned no content`);
            }
            catch {
                attempts.push(`API (${initModel()}) returned a response that is not JSON`);
            }
        }
        else {
            attempts.push('curl produced no output (offline, or curl is not installed)');
        }
    }
    else {
        attempts.push('ANTHROPIC_API_KEY is not set');
    }
    throw new Error(`No LLM available. Install the Claude CLI or set ANTHROPIC_API_KEY. Tried: ` +
        `${attempts.join('; ')}. Set ${INIT_MODEL_ENV_VAR} to choose a different model ` +
        `(default ${DEFAULT_INIT_MODEL}).`);
}
async function suggestGeometry(analysis) {
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
    // Which of the two produced the numbers below, said out loud.
    //
    // The fallback itself is right -- init must work with no LLM. What was wrong is that
    // it was indistinguishable from an answer: the rationale read "Standard quality
    // dimensions for a TypeScript project" either way, `conductInterview` prints it as
    // `LLM Analysis:`, and the coverage target it suggests becomes the floor the gate
    // enforces. An adopter with a key set and a rejected model got the built-in numbers
    // presented as analysis of their repository.
    let why;
    try {
        const response = await callClaude(prompt);
        // Extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        why = 'the model replied with no JSON object';
    }
    catch (error) {
        why = error instanceof Error ? error.message : String(error);
    }
    console.error(`\nNo LLM suggestion -- using built-in defaults. Reason: ${why}`);
    // Default suggestion
    return {
        dimensions: analysis.hasTypeScript
            ? ['coverage.branches', 'coverage.statements', 'typescript.errors', 'eslint.errors']
            : ['coverage.branches', 'coverage.statements', 'eslint.errors'],
        // Names its own provenance, because this string is what `conductInterview` prints
        // under the label `LLM Analysis:`.
        rationale: 'Built-in defaults, not an LLM suggestion: standard quality dimensions for a ' +
            'TypeScript project',
        coverageTarget: analysis.estimatedSloc > 5000 ? 60 : 70,
        recommendSonarQube: analysis.hasDocker && analysis.estimatedSloc > 500,
    };
}
/**
 * ONE readline interface for the whole interview, and why that is the fix.
 *
 * A fresh `readline.Interface` per question is fine on a tty, where each one takes
 * over cleanly. On any other stdin it is not: the first interface buffers or consumes
 * what is left of the stream, and the next one is handed a stream that has already
 * ended, so its `rl.question` callback never fires. OBSERVED driving the interview
 * with `printf '\n\n\n\n' | node ...`: the first two prompts printed and consumed
 * input, then the process HUNG -- node reporting "Detected unsettled top-level await"
 * -- with no diagnostic and no fallback to defaults. A hang is the worst failure mode
 * to debug remotely, and CI is where it happens.
 *
 * End-of-input is answered rather than waited on. A caller that closes stdin mid
 * interview has stopped answering, and the honest response is to say so and stop --
 * NOT to fill the remaining questions with defaults, which would write a
 * configuration from questions nobody answered. That is the same shape as the
 * `[y/N]`-answers-yes defect: a value the user never supplied, presented as theirs.
 */
export function createPrompter(input) {
    const rl = readline.createInterface({ input, output: process.stderr });
    // Lines are QUEUED as they arrive rather than claimed one `rl.question` at a time,
    // and that is the second half of the fix. MEASURED with three answers piped into
    // three questions: readline drains a non-tty stream as fast as it is delivered, so
    // it had emitted every `line` event before question two was even asked -- the
    // unclaimed ones were dropped on the floor and the interview then waited for input
    // that had already gone past. Serving from a queue makes arrival order the only
    // thing that matters, which is true on a tty as well, where lines arrive one at a
    // time and the queue is simply always empty.
    const queued = [];
    let waiting;
    let ended = false;
    rl.on('line', (line) => {
        if (waiting) {
            const resolve = waiting;
            waiting = undefined;
            resolve(line);
        }
        else {
            queued.push(line);
        }
    });
    const pendingRejects = [];
    rl.on('close', () => {
        ended = true;
        waiting = undefined;
        for (const reject of pendingRejects.splice(0))
            reject(new Error(INPUT_ENDED));
    });
    // Through the interface while it is open, so a tty gets its line editing and echo;
    // straight to stderr once it is closed, because `rl.prompt` throws
    // ERR_USE_AFTER_CLOSE and a question still being answered from the queue should
    // still appear in the transcript.
    const showPrompt = (prompt) => {
        if (ended) {
            process.stderr.write(prompt);
            return;
        }
        rl.setPrompt(prompt);
        rl.prompt();
    };
    return {
        ask(prompt) {
            showPrompt(prompt);
            // Queued input is served even after close. A stream that delivered every answer
            // and then ended has answered the interview; rejecting on `ended` alone would
            // fail a caller that did everything right -- and `Readable.from` on a small
            // string closes the interface before the first question is even asked.
            const buffered = queued.shift();
            if (buffered !== undefined)
                return Promise.resolve(buffered.trim());
            if (ended)
                return Promise.reject(new Error(INPUT_ENDED));
            return new Promise((resolve, reject) => {
                waiting = (line) => resolve(line.trim());
                pendingRejects.push(reject);
            });
        },
        close() {
            rl.close();
        },
    };
}
const INPUT_ENDED = 'Input ended before the interview finished. Re-run with -y to accept every ' +
    'default without being asked, rather than having some of them answered for you.';
async function askQuestion(prompter, question, defaultAnswer) {
    const typed = await prompter.ask(`${question} [${defaultAnswer}]: `);
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
export function interpretYesNo(typed) {
    const answer = typed.trim().toLowerCase();
    if (YES_ANSWERS.has(answer))
        return true;
    if (NO_ANSWERS.has(answer))
        return false;
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
async function askYesNo(prompter, question, defaultYes) {
    const typed = await prompter.ask(`${question} [${defaultYes ? 'Y/n' : 'y/N'}]: `);
    return interpretYesNo(typed) ?? defaultYes;
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
export function reportTestCommandChoice(analysis) {
    if (!analysis.testCommand)
        return;
    if (analysis.testCommandWritesCoverage) {
        // Only worth saying when the coverage-writing script was NOT the
        // name-preferred one, i.e. when the two-key ranking actually changed the
        // pick. Otherwise it is noise.
        const skipped = analysis.testScriptCandidates
            .slice(0, analysis.testScriptCandidates.findIndex((c) => c.name === analysis.testCommand))
            .map((c) => c.name);
        if (skipped.length > 0) {
            console.error(`\nUsing \`${analysis.packageManager.manager} run ${analysis.testCommand}\` as the test command: it writes a coverage ` +
                `report, and \`${skipped.join('`, `')}\` do${skipped.length === 1 ? 'es' : ''} not. ` +
                'The generated coverage floors are graded against the report the gate itself produces.');
        }
        return;
    }
    console.error(`\nNote: \`${analysis.packageManager.manager} run ${analysis.testCommand}\` does not appear to write a coverage report, ` +
        'so the gate cannot measure coverage on the commit it is grading.');
    const better = analysis.coverageWritingScripts.filter((name) => name !== analysis.testCommand);
    if (better.length > 0) {
        console.error(`      \`${better.join('`, `')}\` look${better.length === 1 ? 's' : ''} like it writes one -- ` +
            'prefer that, or no coverage floors will be generated.');
    }
    else {
        console.error('      No script in this package.json looks like it writes one, so no coverage floors will ' +
            'be generated. Add e.g. "test:coverage": "vitest run --coverage" and re-run init.');
    }
}
/**
 * Refuses to interview a caller that cannot answer, instead of prompting into a void.
 *
 * `isTTY` is the right predicate here even though it is a coarse one, because the
 * question being asked is exactly "is there a human at the other end of this stream".
 * A pipe or a redirect answers no, and the two things that can follow are: prompt
 * anyway and hope (which is what hung), or say what to run instead.
 *
 * It points at `-y` rather than silently BEHAVING like `-y`. Those differ in the one
 * way that matters -- `-y` is the adopter choosing the defaults, and this would be the
 * tool choosing them and attributing the choice to the adopter. `init` writes a
 * ruleset that decides what the gate enforces from then on; a config nobody agreed to
 * is worth less than an error message.
 */
function refuseNonInteractiveInterview() {
    throw new Error('init needs an interactive terminal for its interview, and stdin is not a tty. ' +
        'Re-run with -y to accept every suggested default without being asked ' +
        '(this is the CI path), or run init from a terminal to answer the questions.');
}
export async function conductInterview(analysis, suggestion, options, 
// Injectable so the prompt LOOP is testable, not just the parsing under it. Without
// this the wiring -- which question takes which default, and that four questions are
// asked in order -- was covered by typechecking and reading only, which is how #44's
// inverted default reached a release with `interpretYesNo` fully unit-tested.
prompter) {
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
    if (!prompter && !process.stdin.isTTY) {
        refuseNonInteractiveInterview();
    }
    console.error('\n--- Quality Gate Configuration ---\n');
    console.error(`LLM Analysis: ${suggestion.rationale}\n`);
    const session = prompter ?? createPrompter(process.stdin);
    try {
        const useSonarQube = options.noDocker
            ? false
            : await askYesNo(session, `Use SonarQube for deep analysis? (requires Docker)`, suggestion.recommendSonarQube && analysis.hasDocker);
        const coverageInput = await askQuestion(session, `Target branch coverage percentage`, String(suggestion.coverageTarget));
        const coverageTarget = parseInt(coverageInput, 10) || suggestion.coverageTarget;
        const testCommand = await askQuestion(session, `Test command (npm script name)`, analysis.testCommand || 'test');
        const strictMode = await askYesNo(session, `Enable strict mode? (zero tolerance for type/lint errors)`, false);
        return { useSonarQube, coverageTarget, testCommand, strictMode };
    }
    finally {
        // In a `finally` because the interface holds the process open. An interview that
        // threw would otherwise hang on exit -- the same symptom as the bug being fixed,
        // reached from the error path.
        session.close();
    }
}
/** The four dimensions an istanbul `total` reports, in report order. */
const COVERAGE_DIMENSIONS = ['statements', 'branches', 'functions', 'lines'];
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
export function classifyCoverageTotal(total, reportPath) {
    const entryOf = (dimension) => (total ?? {})[dimension];
    const denominators = COVERAGE_DIMENSIONS.map((dimension) => ({
        dimension,
        denominator: entryOf(dimension)?.total,
    }));
    const malformed = denominators.filter((d) => typeof d.denominator !== 'number' || !Number.isFinite(d.denominator));
    if (malformed.length > 0) {
        return {
            kind: 'unreadable',
            detail: `${reportPath} has no numeric denominator for ` +
                `${malformed.map((d) => `total.${d.dimension}.total`).join(', ')}, so it cannot be read ` +
                'as an istanbul coverage summary.',
        };
    }
    if (denominators.every((d) => d.denominator === 0)) {
        return {
            kind: 'measured-nothing',
            detail: `${reportPath} reports 0 statements, 0 branches, 0 functions and 0 lines, so the ` +
                "coverage tool instrumented nothing. Check the tool's include/exclude patterns.",
        };
    }
    const read = {};
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
                detail: `${reportPath} reports total.${dimension}.pct as ${JSON.stringify(pct)} over ` +
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
function coverageSummaryCandidates(projectRoot) {
    const { unitDir, summaryFile } = loadConfig().coverage;
    const candidates = [
        path.join(projectRoot, unitDir, summaryFile),
        path.join(projectRoot, 'coverage-unit', summaryFile),
    ];
    return Array.from(new Set(candidates));
}
function mtimeMsOf(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    }
    catch {
        return null;
    }
}
function collectCalibrationMetrics(projectRoot, testCommand, hasTypeScript, selection) {
    // Both counts start UNMEASURABLE rather than at zero. The old initialiser was 0,
    // and every path that failed to overwrite it -- a project with no TypeScript, a
    // crashed linter -- silently contributed a calibrated ceiling of zero.
    const metrics = {
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
        if (after === null)
            return false;
        const before = mtimesBefore.get(p) ?? null;
        return before === null || after > before;
    });
    if (refreshed.length === 0) {
        const stale = coveragePaths.filter((p) => mtimesBefore.get(p) !== null);
        metrics.coverage = {
            kind: 'not-written',
            detail: `\`${test.display}\` exited ${String(testRun.status)} and wrote no coverage ` +
                `report to ${coveragePaths.join(' or ')}.` +
                (stale.length > 0
                    ? ` ${stale.join(', ')} exists but was not rewritten by this run, so it describes an ` +
                        'earlier generation of the code and cannot be calibrated from.'
                    : ''),
        };
        console.error(`  Coverage: not measured -- ${metrics.coverage.detail}`);
    }
    else {
        const reportPath = refreshed[0];
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        }
        catch (error) {
            parsed = undefined;
            metrics.coverage = {
                kind: 'unreadable',
                detail: `${reportPath} is not valid JSON (${String(error)}).`,
            };
        }
        if (parsed !== undefined) {
            metrics.coverage = classifyCoverageTotal(parsed.total, reportPath);
        }
        const { coverage } = metrics;
        if (coverage.kind === 'measured') {
            const show = (dimension, pct) => pct === null ? `no ${dimension} in this codebase` : `${pct.toFixed(1)}% ${dimension}`;
            console.error(`  Coverage: ${show('branches', coverage.branches)}, ` +
                `${show('statements', coverage.statements)}`);
        }
        else {
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
        console.error(metrics.typescript.kind === 'measured'
            ? `  TypeScript errors: ${metrics.typescript.errors}`
            : `  TypeScript: could not measure -- ${metrics.typescript.detail}`);
    }
    console.error('  Checking ESLint...');
    const lint = eslintLintProvider.measure({
        ...context,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.lintTimeoutMs,
    });
    metrics.eslint = lint.ok
        ? { kind: 'measured', errors: lint.value.metrics.errors }
        : { kind: 'unmeasurable', detail: lint.error.message };
    console.error(metrics.eslint.kind === 'measured'
        ? `  ESLint errors: ${metrics.eslint.errors}`
        : `  ESLint: could not measure -- ${metrics.eslint.detail}`);
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
export function calibrateCoverageRules(analysis, answers, calibration) {
    const floors = {};
    const notes = [];
    if (calibration.kind === 'measured') {
        // "Barely passing": current value minus a small buffer, capped by the target.
        if (calibration.branches !== null) {
            floors['coverage.unit.branches'] = Math.round(Math.min(Math.max(calibration.branches - 5, 0), answers.coverageTarget));
        }
        else {
            notes.push('No `coverage.unit.branches` floor was generated: the coverage report has 0 branches, so ' +
                'this codebase has none to cover. The gate reports 0-of-0 as 100%; a floor calibrated ' +
                'from that measures nothing, and a ratchet on it would fail the first time a real ' +
                'branch appears.');
        }
        if (calibration.statements !== null) {
            floors['coverage.unit.statements'] = Math.round(Math.min(Math.max(calibration.statements - 5, 0), answers.coverageTarget + 10));
        }
        else {
            notes.push('No `coverage.unit.statements` floor was generated: the coverage report has 0 statements ' +
                'to cover.');
        }
    }
    else if (calibration.kind === 'not-written' &&
        scriptWritesCoverage(answers.testCommand, scriptsOf(analysis.packageJson)[answers.testCommand] ?? '')) {
        // No report YET, but the script the gate will run is the kind that writes
        // one. Floors from the interview target, as init has always done.
        floors['coverage.unit.branches'] = Math.round(Math.max(answers.coverageTarget - 10, 30));
        floors['coverage.unit.statements'] = Math.round(Math.max(answers.coverageTarget, 40));
        notes.push(`Coverage floors are derived from your target of ${answers.coverageTarget}%, not from a ` +
            `measurement: ${calibration.detail}. Re-run init once \`${analysis.packageManager.manager} run ${answers.testCommand}\` ` +
            'produces a report, or adjust them by hand.');
    }
    else {
        notes.push(`No coverage floors were generated: ${'detail' in calibration ? calibration.detail : ''} ` +
            'A floor the gate cannot measure fails forever, so init writes none. Add a ' +
            'coverage-writing script (e.g. "test:coverage": "vitest run --coverage"), put it in ' +
            '`requiredScripts`, and re-run init.');
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
export function generateConfig(analysis, suggestion, answers, metrics) {
    const coverage = calibrateCoverageRules(analysis, answers, metrics.coverage);
    for (const note of coverage.notes) {
        console.error(`  ${note}`);
    }
    const rules = {
        version: '1.0.0',
        description: `Quality gates for ${path.basename(process.cwd())} - Generated by quality-gate-sgd init` +
            (coverage.ratchet.length > 0
                ? `. The coverage floors are graded against the report \`${analysis.packageManager.manager} run ${answers.testCommand}\` ` +
                    'writes, which is why that script is in requiredScripts: replace it with another and ' +
                    'the floors are graded against whatever generation of the code last wrote coverage.'
                : ''),
        rules: {
            floors: coverage.floors,
            ceilings: {},
            monotonic: coverage.ratchet.length > 0
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
    const gradeCount = (dimension, calibration) => {
        if (answers.strictMode) {
            rules.rules.ceilings[dimension] = 0;
            return;
        }
        if (calibration.kind !== 'measured')
            return;
        rules.rules.ceilings[dimension] = calibration.errors;
        rules.rules.monotonic.push({ direction: 'down', metrics: [dimension] });
    };
    if (analysis.hasTypeScript)
        gradeCount('typescript.errors', metrics.typescript);
    if (analysis.hasEslint)
        gradeCount('eslint.errors', metrics.eslint);
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
function generateExplanation(analysis, suggestion, answers, metrics, rules) {
    const lines = [
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
    const coverageRow = (label, dimension) => {
        const floor = rules.rules.floors[`coverage.unit.${dimension}`];
        const measured = metrics.coverage.kind === 'measured' ? metrics.coverage[dimension] : undefined;
        const current = measured === undefined
            ? 'not measured'
            : measured === null
                ? `none in this codebase (0 ${dimension})`
                : `${measured.toFixed(1)}%`;
        lines.push(floor === undefined
            ? `| ${label} | ${current} | not gated | - |`
            : `| ${label} | ${current} | ≥${floor}% | ↑ |`);
    };
    coverageRow('Branch Coverage', 'branches');
    coverageRow('Statement Coverage', 'statements');
    // An unmeasurable dimension gets a row that says so, rather than a number sitting
    // beside a ceiling that was never written. The old shape printed `0 | ≤undefined`.
    const countRow = (label, dimension, calibration) => {
        if (calibration.kind !== 'measured') {
            lines.push(`| ${label} | not measured | (no rule written) | -- |`);
            return;
        }
        lines.push(`| ${label} | ${calibration.errors} | ≤${rules.rules.ceilings[dimension]} | ↓ |`);
    };
    if (analysis.hasTypeScript) {
        countRow('TypeScript Errors', 'typescript.errors', metrics.typescript);
    }
    if (analysis.hasEslint)
        countRow('ESLint Errors', 'eslint.errors', metrics.eslint);
    lines.push('');
    for (const note of calibrateCoverageRules(analysis, answers, metrics.coverage).notes) {
        lines.push(`> ${note}`);
        lines.push('');
    }
    lines.push('## Measuring Coverage');
    lines.push('');
    lines.push(`The coverage numbers above are read from the report that \`${analysis.packageManager.manager} run ${answers.testCommand}\` ` +
        'writes, which is why that script is in `requiredScripts`. The gate reads the report AFTER ' +
        'running those scripts, so if you replace it with a script that writes no coverage report, ' +
        'the floors below are graded against whatever report was last left in the coverage ' +
        'directory -- and the gate cannot tell that it is grading older code.');
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
export async function runInit(args) {
    const options = {
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
    }
    else {
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
    console.error(`\nRunner: ${analysis.packageManager.manager} (${analysis.packageManager.reason})`);
    const metrics = collectCalibrationMetrics(projectRoot, answers.testCommand, analysis.hasTypeScript, analysis.packageManager);
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
        console.error('Coverage is NOT gated by this configuration. A floor on a dimension the gate cannot ' +
            `measure fails on every run with no edit that clears it, so init wrote none. \`npm run ` +
            `${answers.testCommand}\` is what the gate will run; give it a --coverage flag, or add a ` +
            'script that has one and re-run init, to get coverage floors.\n');
    }
    console.error('Next steps:');
    console.error('  1. Review rules.json and adjust thresholds if needed');
    console.error('  2. Run: npx quality-gate-sgd');
    if (answers.useSonarQube) {
        console.error('  3. Start SonarQube: docker run -d --name sonarqube -p 9000:9000 sonarqube:latest');
    }
    console.error('');
}
//# sourceMappingURL=init.js.map