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
 */
export declare function getSonarCurlAuth(): string;
//# sourceMappingURL=config.d.ts.map