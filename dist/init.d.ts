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
}
export interface GeometrySuggestion {
    dimensions: string[];
    rationale: string;
    coverageTarget: number;
    recommendSonarQube: boolean;
}
export interface InitOptions {
    yes: boolean;
    noDocker: boolean;
    verbose: boolean;
}
export interface GeneratedConfig {
    rules: {
        version: string;
        description: string;
        rules: {
            floors: Record<string, number>;
            ceilings: Record<string, number>;
            monotonic: Array<{
                direction: 'up' | 'down';
                metrics: string[];
            }>;
            requiredScripts: string[];
        };
    };
    explanation: string;
}
export declare function scriptWritesCoverage(name: string, body: string): boolean;
export declare function analyzeRepo(projectRoot: string): RepoAnalysis;
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
export declare function reportTestCommandChoice(analysis: RepoAnalysis): void;
export declare function conductInterview(analysis: RepoAnalysis, suggestion: GeometrySuggestion, options: InitOptions): Promise<InterviewAnswers>;
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
export type CoverageCalibration = {
    readonly kind: 'measured';
    readonly reportPath: string;
    readonly branches: number | null;
    readonly statements: number | null;
} | {
    readonly kind: 'measured-nothing';
    readonly detail: string;
} | {
    readonly kind: 'unreadable';
    readonly detail: string;
} | {
    readonly kind: 'not-written';
    readonly detail: string;
};
export interface CalibrationMetrics {
    coverage: CoverageCalibration;
    typescriptErrors: number;
    eslintErrors: number;
}
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
export declare function classifyCoverageTotal(total: unknown, reportPath: string): CoverageCalibration;
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
export declare function calibrateCoverageRules(analysis: RepoAnalysis, answers: InterviewAnswers, calibration: CoverageCalibration): {
    readonly floors: Record<string, number>;
    readonly ratchet: readonly string[];
    readonly notes: readonly string[];
};
export declare function generateConfig(analysis: RepoAnalysis, suggestion: GeometrySuggestion, answers: InterviewAnswers, metrics: CalibrationMetrics): GeneratedConfig;
export declare function runInit(args: string[]): Promise<void>;
//# sourceMappingURL=init.d.ts.map