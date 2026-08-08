/**
 * Quality Gate Configuration
 * ==========================
 * Centralized configuration for the quality gate system.
 * All project-specific values are externalized here for portability.
 *
 * To port this to another project:
 * 1. Install quality-gate-sgd
 * 2. Set environment variables or use defaults
 * 3. Create a rules.json with your project's thresholds
 */
import type { RunnerSelection, TypecheckScriptSelection } from './runner.js';
export interface QualityGateConfig {
    projectName: string;
    projectRoot: string;
    sonarqube: {
        url: string;
        projectKey: string;
        tokenFile: string;
        defaultCredentials: {
            user: string;
            password: string;
        };
    };
    coverage: {
        unitDir: string;
        lambdaDir: string;
        summaryFile: string;
        /** False only for a project that deliberately has no coverage report at all. */
        required: boolean;
        /**
         * Whether each directory above was named by the PROJECT rather than defaulted.
         *
         * Both are resolved with `||` against a hardcoded default, which loses exactly
         * the distinction the coverage provider needs to decide whether an absent
         * summary for that suite is a failed measurement. See CoverageReportPaths.
         */
        unitDirConfigured: boolean;
        lambdaDirConfigured: boolean;
    };
    cache: {
        file: string;
        maxAgeDays: number;
    };
    /**
     * Which package manager runs this project's scripts, and why that was chosen.
     *
     * Resolved once, here, so that every measurement and `init`'s calibration shell
     * the same tool. Resolving it per call site is how the interview measures a
     * project with one runner and the gate then grades it with another.
     */
    packageManager: RunnerSelection;
    /**
     * The package.json script the typescript dimension runs, and why that one.
     *
     * Resolved here for the same reason as the runner: the provider must not read
     * package.json itself (a provider shelling `tsc` or `deno check` has no script to
     * look up), and `init` has to agree with the gate about which script is the
     * project's type-check.
     */
    typecheckScript: TypecheckScriptSelection;
    rulesFile: string;
    codePathspecs: string[];
    scriptTimeouts: Record<string, number>;
    defaultScriptTimeout: number;
}
/**
 * Load configuration from environment variables and defaults.
 * Environment variables take precedence over defaults.
 */
export declare function loadConfig(): QualityGateConfig;
/**
 * Get the quality gate configuration.
 * Loads once and caches for the duration of the process.
 */
export declare function getConfig(): QualityGateConfig;
/**
 * Reset the configuration cache (useful for testing)
 */
export declare function resetConfig(): void;
/**
 * Get the SonarQube authentication token.
 * Reads from token file or falls back to default credentials.
 */
export declare function getSonarAuthToken(): string;
/**
 * Get curl auth argument for SonarQube API calls
 *
 * Returns ONE shell word pair as a single string, which makes it usable only where
 * a shell parses the result. That is the problem: a token or password containing a
 * space, a quote, `$`, a backtick or `;` either splits into extra arguments or is
 * interpreted. Prefer `sonarAuthArgs()`, which cannot be reinterpreted, and treat
 * this as retained for the published API surface.
 *
 * @deprecated Use {@link sonarAuthArgs} -- see the note above.
 */
export declare function getSonarCurlAuth(): string;
/**
 * The SonarQube credential as argv words, for a spawn with no shell.
 *
 * Two argv entries, never one string, and never interpolated into a command line.
 * A credential that reaches a shell has to survive quoting; a credential that
 * reaches `execve` directly does not, so `p@ss word`, `to;ken` and `$SECRET` are
 * all passed through verbatim instead of splitting the command or being expanded
 * by the shell.
 *
 * It also means no caller can accidentally print it: the only string form of the
 * credential in this process is the one curl receives, and nothing builds a
 * message out of that.
 */
export declare function sonarAuthArgs(): readonly string[];
/**
 * A SonarQube URL with any embedded credential removed, safe to print.
 *
 * `https://user:token@sonar.example.com` is a legal value for SONARQUBE_URL, and
 * every failure message and piece of evidence names the URL. Redacting the `-u`
 * argument is not enough on its own while the credential can also arrive inside
 * the URL itself.
 */
export declare function redactUrlCredentials(url: string): string;
//# sourceMappingURL=config.d.ts.map