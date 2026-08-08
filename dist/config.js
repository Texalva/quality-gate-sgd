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
import * as path from 'path';
import * as fs from 'fs';
import { detectPackageManager, detectTypecheckScript } from './runner.js';
// =============================================================================
// Default Configuration
// =============================================================================
/**
 * The values that turn the coverage requirement off, and the reason the set is
 * closed.
 *
 * DEFAULT ON. An absent coverage summary used to produce no metrics AND no
 * measurement failure, and `evaluateFloors` is the only rule evaluator that
 * reports a missing metric -- `evaluateCeilings` and `evaluateMonotonic` both
 * `continue` on an undefined value. So a project whose only coverage rule was a
 * ratchet got no coverage enforcement whatsoever the moment its report stopped
 * being written, and because a monotonic rule still returned a baseline the run
 * counted as fully evaluated and cached the pass. A required script can exit 0
 * while writing no report, so nothing had to look broken for this to happen.
 *
 * An UNRECOGNISED value leaves the requirement ON, and the asymmetry is
 * deliberate. Reading a typo as "off" restores exactly the silence above and the
 * reader gets no sign that their opt-out did nothing; reading it as "on" costs an
 * advisory that says what to fix. Note that this includes the empty string, so
 * `QUALITY_COVERAGE_REQUIRED=` does NOT disable it -- elsewhere in this file `||`
 * makes an empty value mean "unset", and that convention would be the wrong one
 * here for the same reason.
 */
const COVERAGE_REQUIREMENT_DISABLED_BY = new Set(['false', '0', 'no', 'off']);
function coverageRequired() {
    const raw = process.env.QUALITY_COVERAGE_REQUIRED;
    if (raw === undefined)
        return true;
    return !COVERAGE_REQUIREMENT_DISABLED_BY.has(raw.trim().toLowerCase());
}
function resolveProjectRoot() {
    // Start from cwd and verify package.json exists
    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, 'package.json'))) {
        return cwd;
    }
    // Walk up to find package.json
    let dir = cwd;
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return cwd;
}
/**
 * Load configuration from environment variables and defaults.
 * Environment variables take precedence over defaults.
 */
export function loadConfig() {
    const projectRoot = process.env.QUALITY_PROJECT_ROOT || resolveProjectRoot();
    return {
        projectName: process.env.QUALITY_PROJECT_NAME || 'quality-gate',
        projectRoot,
        sonarqube: {
            url: process.env.SONARQUBE_URL || 'http://localhost:9000',
            projectKey: process.env.SONARQUBE_PROJECT_KEY || detectProjectKey(projectRoot),
            tokenFile: process.env.SONARQUBE_TOKEN_FILE ||
                path.join(projectRoot, '.sonarqube-token'),
            defaultCredentials: {
                user: process.env.SONARQUBE_DEFAULT_USER || 'admin',
                password: process.env.SONARQUBE_DEFAULT_PASSWORD || 'admin',
            },
        },
        coverage: {
            unitDir: process.env.QUALITY_COVERAGE_UNIT_DIR || 'coverage',
            lambdaDir: process.env.QUALITY_COVERAGE_LAMBDA_DIR || 'coverage-lambda',
            summaryFile: process.env.QUALITY_COVERAGE_SUMMARY_FILE || 'coverage-summary.json',
            required: coverageRequired(),
            // Emptiness counts as unset here, matching the `||` above it: a variable set
            // to '' resolves to the default path, so calling it "configured" would claim
            // the project named a directory it did not.
            unitDirConfigured: !!process.env.QUALITY_COVERAGE_UNIT_DIR,
            lambdaDirConfigured: !!process.env.QUALITY_COVERAGE_LAMBDA_DIR,
        },
        cache: {
            file: process.env.QUALITY_CACHE_FILE ||
                path.join(projectRoot, '.quality-gate-cache.json'),
            maxAgeDays: parseInt(process.env.QUALITY_CACHE_MAX_AGE_DAYS || '90', 10),
        },
        packageManager: detectPackageManager(projectRoot),
        typecheckScript: detectTypecheckScript(projectRoot),
        rulesFile: process.env.QUALITY_RULES_FILE || 'rules.json',
        codePathspecs: (process.env.QUALITY_CODE_PATHSPECS || 'src/,tests/,scripts/').split(','),
        scriptTimeouts: {
            'test:ci': 300000, // 5 minutes
            quality: 120000, // 2 minutes
        },
        defaultScriptTimeout: 120000,
    };
}
/**
 * Detect project key from sonar-project.properties or package.json
 */
function detectProjectKey(projectRoot) {
    // Try sonar-project.properties first
    const sonarPropsPath = path.join(projectRoot, 'sonar-project.properties');
    if (fs.existsSync(sonarPropsPath)) {
        const content = fs.readFileSync(sonarPropsPath, 'utf-8');
        const match = content.match(/sonar\.projectKey\s*=\s*(.+)/);
        if (match) {
            return match[1].trim();
        }
    }
    // Fall back to package.json name
    const packageJsonPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            if (pkg.name) {
                // Convert scoped package name to valid project key
                return pkg.name.replace(/^@/, '').replace(/\//g, '-');
            }
        }
        catch {
            // Ignore parse errors
        }
    }
    return 'my-project';
}
// =============================================================================
// Singleton Config Instance
// =============================================================================
let _config;
/**
 * Get the quality gate configuration.
 * Loads once and caches for the duration of the process.
 */
export function getConfig() {
    if (!_config) {
        _config = loadConfig();
    }
    return _config;
}
/**
 * Reset the configuration cache (useful for testing)
 */
export function resetConfig() {
    _config = undefined;
}
/**
 * Get the SonarQube authentication token.
 * Reads from token file or falls back to default credentials.
 */
export function getSonarAuthToken() {
    const config = getConfig();
    if (fs.existsSync(config.sonarqube.tokenFile)) {
        return fs.readFileSync(config.sonarqube.tokenFile, 'utf-8').trim();
    }
    return config.sonarqube.defaultCredentials.user;
}
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
export function getSonarCurlAuth() {
    const config = getConfig();
    if (fs.existsSync(config.sonarqube.tokenFile)) {
        const token = fs.readFileSync(config.sonarqube.tokenFile, 'utf-8').trim();
        return `-u ${token}:`;
    }
    const { user, password } = config.sonarqube.defaultCredentials;
    return `-u ${user}:${password}`;
}
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
export function sonarAuthArgs() {
    const config = getConfig();
    if (fs.existsSync(config.sonarqube.tokenFile)) {
        const token = fs.readFileSync(config.sonarqube.tokenFile, 'utf-8').trim();
        // A SonarQube token authenticates as the user with an empty password.
        return ['-u', `${token}:`];
    }
    const { user, password } = config.sonarqube.defaultCredentials;
    return ['-u', `${user}:${password}`];
}
/**
 * A SonarQube URL with any embedded credential removed, safe to print.
 *
 * `https://user:token@sonar.example.com` is a legal value for SONARQUBE_URL, and
 * every failure message and piece of evidence names the URL. Redacting the `-u`
 * argument is not enough on its own while the credential can also arrive inside
 * the URL itself.
 */
export function redactUrlCredentials(url) {
    try {
        const parsed = new URL(url);
        if (parsed.username === '' && parsed.password === '')
            return url;
        parsed.username = '<redacted>';
        parsed.password = '';
        return parsed.toString();
    }
    catch {
        // Not a parseable URL. Fall back to removing anything that looks like
        // userinfo, rather than returning a string that may carry a credential.
        return url.replace(/\/\/[^/@]*@/, '//<redacted>@');
    }
}
//# sourceMappingURL=config.js.map