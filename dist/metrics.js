/**
 * Metrics Extraction Module
 * Extracts quality metrics from various sources
 */
import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, redactUrlCredentials, sonarAuthArgs } from './config.js';
import { extractAllCustomMetrics, registerCustomDimensions, } from './dimensions/index.js';
import { manifestDefinesScript, scriptCommand } from './runner.js';
// The commit being graded, for the revision half of the provenance check. cache.ts
// imports rules.ts, config.ts, runner.ts and measurement-inputs.ts and none of those
// imports this module, so this edge adds no cycle.
import { getCurrentCommitHash } from './cache.js';
// The provenance judgement lives OUTSIDE the coverage provider (D7): a provider that
// vouches for its own freshness is self-attestation, which the note on
// MeasurementProvider rules out. It is driven from here rather than from cli.ts because
// the STALE verdict is a false-pass channel and has to reach every surface that
// measures -- `run`, `score`, `suggest` and their three MCP equivalents -- the same
// argument `Metrics.measurementFailures` makes for itself.
import { coverageProvenanceFailures, snapshotCoverageStateBeforeScripts, stampCoverageSummariesRewrittenDuringRun, suitesWithNumbers, verifyCoverageProvenance, } from './coverage-provenance.js';
import { eslintLintProvider } from './providers/eslint.js';
import { typescriptTypecheckProvider } from './providers/typescript.js';
import { DEFAULT_MEASUREMENT_LIMITS, measurementFailure } from './providers/result.js';
import { createIstanbulCoverageProvider } from './providers/coverage.js';
/**
 * spawnSync defaults to a 1 MiB stdout buffer. Past that, Node truncates the
 * output and kills the child, leaving status === null -- and every parse path
 * below turns unparseable output into *zero findings* rather than an error.
 * eslint's JSON crosses 1 MiB at roughly a thousand findings, so any real
 * codebase with a lint backlog silently reports clean and passes an
 * `eslint.errors: 0` ceiling. Observed directly: a 1038-finding subject
 * returned exactly 1048576 bytes and 0 errors.
 *
 * 64 MiB is far beyond any plausible linter or compiler output.
 */
const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;
// =============================================================================
// Coverage Metrics
// =============================================================================
/**
 * Measures coverage once, so the metrics and the located findings cannot end up
 * describing two different reads of the same report.
 *
 * The parsing that used to live here now lives in src/providers/coverage.ts,
 * unchanged. Before the extraction the two halves came from DIFFERENT files read
 * at DIFFERENT times -- metrics from coverage-summary.json here, findings from
 * coverage-final.json in targets/extract.ts -- with nothing checking that they
 * agreed about anything.
 *
 * `issues: 'skip'` because this path discards them, and the cost of building them
 * is not notional: `measureCoverage` returns metrics and failures and has no
 * issues field to put them in, while the detail report they come from is the
 * biggest artifact the tool reads. Before the extraction this path never opened
 * coverage-final.json at all; collecting here would parse and walk it on the
 * metrics pass and again on the findings pass. See CoverageProviderOptions.
 */
function measureCoverageReading(absentReport) {
    const config = getConfig();
    return createIstanbulCoverageProvider({
        unitDir: config.coverage.unitDir,
        lambdaDir: config.coverage.lambdaDir,
        summaryFile: config.coverage.summaryFile,
        unitDirConfigured: config.coverage.unitDirConfigured,
        lambdaDirConfigured: config.coverage.lambdaDirConfigured,
    }, { issues: 'skip', absentReport }).measure({
        projectRoot: config.projectRoot,
        // A file read has neither a timeout nor a buffer budget. The context carries
        // them because every spawn-based provider needs them, and inventing coverage
        // -specific numbers here would put a limit in the contract that nothing
        // enforces.
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
        packageManager: config.packageManager,
        typecheckScript: config.typecheckScript,
    });
}
/**
 * The coverage numbers and the reasons any of them are missing, together.
 *
 * `reads` is deliberately NOT surfaced here, and it is still not the freshness
 * channel. The provider records what it looked at (CoverageReading.reads) and
 * targets/extract.ts uses that to warn about a detail report it could not use;
 * returning a field no caller reads would suggest something here checks it.
 *
 * The metrics path DOES now judge a report's provenance -- `extractAllMetrics` calls
 * verifyCoverageProvenance after this function returns -- but from a sidecar beside
 * the report, not from anything in `reads` and not from any mtime this provider
 * recorded. Keeping the two apart is the point: this function answers "what do the
 * reports say", and coverage-provenance.ts answers "which code do they describe".
 */
export function measureCoverage(options = {}) {
    // Defaults to REQUIRING the report, so a caller that says nothing gets the loud
    // reading. `QUALITY_COVERAGE_REQUIRED=false` is not consulted here on purpose:
    // it is a statement about a project with no coverage, and honouring it for a
    // project that DOES grade coverage would restore the exact silence this exists
    // to remove -- an absent report, a ratchet that skips it, and a cached pass.
    // Only the gate path knows the rules, so only the gate path resolves it. See
    // `coverageAbsenceIsFailure` in cli.ts.
    const reading = measureCoverageReading((options.absentReportIsFailure ?? true) ? 'fail' : 'ignore');
    if (!reading.ok) {
        return { metrics: {}, failures: [reading.error] };
    }
    return {
        metrics: reading.value.metrics,
        failures: reading.value.failures,
    };
}
/**
 * Extract all three coverage metrics: lambda-only, unit-only, and union.
 *
 * Returns `{}` rather than `undefined` when nothing could be read, because
 * `extractAllMetrics` assigns this straight to `metrics.coverage` and callers
 * distinguish "no coverage numbers" from "no coverage key" already.
 *
 * As with extractTypescriptMetrics, absence is only half the fix: this wrapper
 * discards the REASON, so a caller using it directly gets an honest blank and no
 * diagnosis. The gate path uses `measureCoverage` for exactly that reason.
 */
export function extractAllCoverageMetrics() {
    return measureCoverage().metrics;
}
/**
 * Extract coverage metrics for quality gate.
 * Returns the union coverage for backward compatibility.
 * @deprecated Use extractAllCoverageMetrics() for full coverage data.
 */
export function extractCoverageMetrics() {
    return measureCoverage().metrics.union;
}
export function getTopSonarIssues(limit = 10) {
    const projectKey = getConfig().sonarqube.projectKey;
    // Through the same reader as the metrics, so a 401 login page is never handed to
    // JSON.parse and mistaken for "no issues".
    //
    // Still `[]` on failure, and that is a narrower statement than it looks: this feeds
    // the CLI's inline issue LIST, not the verdict. `readSonarqubeMetrics` is what the
    // gate reads and it reports the same failure loudly, so a run that cannot reach
    // SonarQube fails there rather than quietly showing an empty issue table here.
    const response = sonarGet(`/api/issues/search?componentKeys=${projectKey}` +
        `&severities=BLOCKER,CRITICAL,MAJOR,MINOR&statuses=OPEN,CONFIRMED` +
        `&ps=${limit}&s=SEVERITY`);
    if (response.kind !== 'ok' || response.status >= 400)
        return [];
    try {
        const parsed = JSON.parse(response.body);
        if (!parsed.issues)
            return [];
        return parsed.issues.map((i) => ({
            severity: i.severity,
            type: i.type,
            message: i.message,
            component: i.component.replace(`${projectKey}:`, ''),
            line: i.line,
            rule: i.rule,
        }));
    }
    catch {
        return [];
    }
}
const SONAR_HTTP_TIMEOUT_SECONDS = 10;
function sonarGet(pathAndQuery) {
    const config = getConfig();
    const started = Date.now();
    // Spawned as argv with NO shell, which is what keeps the credential safe. The
    // string form this replaced interpolated `-u user:password` into a command line
    // and then tried to scrub it back out of error text with a regex, which fails two
    // ways at once: a password containing a space leaves its tail in the message
    // (`-u <redacted> second`), and a password containing `"`, `$`, a backtick or `;`
    // changes what the shell runs. Neither is reachable through execve.
    const result = spawnSync('curl', [
        '-s',
        '-w',
        '\\n%{http_code}',
        '--max-time',
        String(SONAR_HTTP_TIMEOUT_SECONDS),
        ...sonarAuthArgs(),
        `${config.sonarqube.url}${pathAndQuery}`,
    ], {
        encoding: 'utf-8',
        shell: false,
        // As well as `--max-time`: that one lets curl exit cleanly with a status we
        // can report, this one is the backstop for a curl that hangs before it
        // starts counting.
        timeout: (SONAR_HTTP_TIMEOUT_SECONDS + 5) * 1000,
    });
    const unreachable = (reason) => ({
        kind: 'unreachable',
        reason,
        elapsedMs: Date.now() - started,
    });
    // `error` is set when the spawn itself failed -- curl absent, or the timeout
    // above. Node builds that message from the FILE (`spawnSync curl ENOENT`), not the
    // arguments, so the credential should not be in it; it is scrubbed anyway, by
    // value rather than by shape, because "should not be" is the assumption that put a
    // token in the output in the first place.
    if (result.error) {
        return unreachable(scrubCredential(result.error.message));
    }
    if (result.signal) {
        return unreachable(`curl was killed by ${result.signal}`);
    }
    const raw = result.stdout ?? '';
    const split = raw.lastIndexOf('\n');
    const status = Number.parseInt(raw.slice(split + 1).trim(), 10);
    // curl writes `000` when it never got a response. Exit 0 with no HTTP status is
    // the shape a `--max-time` abort takes, so it is a refusal to answer, not an
    // answer of zero. A nonzero curl exit with no status is the same thing: connection
    // refused, DNS failure, TLS rejection.
    if (!Number.isFinite(status) || status === 0) {
        return unreachable(result.status === 0
            ? 'no HTTP response from the server'
            : `curl exited ${result.status} without an HTTP response`);
    }
    return {
        kind: 'ok',
        status,
        body: raw.slice(0, Math.max(0, split)),
        elapsedMs: Date.now() - started,
    };
}
/**
 * Remove the SonarQube credential from a string, by VALUE rather than by shape.
 *
 * The regex this replaces matched `-u` followed by one whitespace-free token, which
 * made the redaction depend on the credential's shape: a password of `first second`
 * left `second` in the message. Searching for the value itself has no such gap --
 * it redacts wherever and however the credential appears, in any message from any
 * source, including ones whose format nobody here controls.
 *
 * The empty-string guard matters: `String.replaceAll('')` inserts the replacement
 * between every character, and an unset password is an ordinary configuration.
 */
function scrubCredential(text) {
    return sonarAuthArgs()
        .flatMap((arg) => (arg === '-u' ? [] : [arg, ...arg.split(':')]))
        .filter((secret) => secret.length > 0)
        .reduce((scrubbed, secret) => scrubbed.split(secret).join('<redacted>'), text);
}
/**
 * Evidence for a sonarqube failure: one HTTP call, named so it can be repeated.
 *
 * `exitCode` reports what CURL did, not what the server said -- 0 whenever a response
 * came back, whatever its status, and null only when curl itself failed. That
 * distinction matters because `describeEvidence` renders a null exit code as
 * `killed`, and a 401 is not a killed process. The HTTP status lives in the failure
 * MESSAGE, where an adopter reads it.
 *
 * The command is SYNTHESIZED rather than captured, which is deliberate: a captured
 * command line would carry the credential, and the safety of this string would then
 * depend on scrubbing it back out. `-u <redacted>` here is a literal, and the URL
 * goes through `redactUrlCredentials` because SONARQUBE_URL may itself embed one.
 */
function sonarEvidence(pathAndQuery, response) {
    const config = getConfig();
    return {
        via: 'process',
        command: `curl -u <redacted> ` +
            `"${redactUrlCredentials(config.sonarqube.url)}${pathAndQuery}"`,
        exitCode: response.kind === 'ok' ? 0 : null,
        signal: null,
        elapsedMs: response.elapsedMs,
        stdoutBytes: response.kind === 'ok' ? Buffer.byteLength(response.body) : 0,
        stderrBytes: 0,
    };
}
/**
 * The reading a run told not to measure sonarqube has: no metrics, no failure, and no
 * provenance.
 *
 * Named rather than written `{} as SonarqubeReading` at the call site, which is what
 * stood there: the cast asserted a shape instead of describing one, and the shape it
 * asserted now has a third field whose absence is load-bearing. No provenance is what
 * makes `--coverage-only` produce the pre-existing `skipped-dimension` advisory rather
 * than a provenance advisory about numbers nobody read.
 */
const SONARQUBE_NOT_MEASURED = {};
export function extractSonarqubeMetrics() {
    return readSonarqubeMetrics().metrics;
}
/**
 * The measures this reads, and whether the reading is incomplete without each.
 *
 * `required` marks the measures every analysis computes: issue counts and the
 * severity breakdown are derived from the issues themselves, so an analysis that
 * published anything published these. Their absence means the response is not a
 * complete reading of this project, and substituting zero for one of them is the
 * vacuous pass in its purest form -- `sonarqube.blocker: 0` satisfied by a measure
 * SonarQube never sent.
 *
 * `coverage` and `duplicated_lines_density` are conditional: coverage exists only
 * where a coverage report was imported into the scan, and a project that does not
 * feed one is not broken. Those stay absent rather than becoming zero, so a floor
 * on them fails loudly (`Metric '...' not available`) instead of reading as 0%.
 *
 * Which measures are guaranteed is an inference from SonarQube's metric domains
 * rather than something verified against a live server here; it is wrong only in the
 * direction of demanding a measure some edition omits, which fails loudly and names
 * the measure rather than passing silently.
 */
const SONAR_MEASURES = [
    { key: 'bugs', field: 'bugs', required: true },
    { key: 'vulnerabilities', field: 'vulnerabilities', required: true },
    { key: 'code_smells', field: 'codeSmells', required: true },
    { key: 'coverage', field: 'coverage', required: false },
    { key: 'duplicated_lines_density', field: 'duplications', required: false },
    { key: 'blocker_violations', field: 'blocker', required: true },
    { key: 'critical_violations', field: 'critical', required: true },
    { key: 'major_violations', field: 'major', required: true },
    { key: 'minor_violations', field: 'minor', required: true },
    { key: 'info_violations', field: 'info', required: true },
];
export function readSonarqubeMetrics(submitted = { kind: 'not-scanned' }) {
    const config = getConfig();
    const sonarUrl = redactUrlCredentials(config.sonarqube.url);
    const projectKey = config.sonarqube.projectKey;
    const metrics = SONAR_MEASURES.map((m) => m.key).join(',');
    const query = `/api/measures/component?component=${projectKey}&metricKeys=${metrics}`;
    const response = sonarGet(query);
    const fail = (kind, message) => ({
        failure: measurementFailure(kind, 'sonarqube', message, sonarEvidence(query, response)),
    });
    if (response.kind === 'unreachable') {
        return fail('tool-missing', `SonarQube at ${sonarUrl} did not answer (${response.reason}). Check ` +
            'SONARQUBE_URL and that the server is running.');
    }
    if (response.status === 401 || response.status === 403) {
        return fail('access-denied', `SonarQube refused the request with HTTP ${response.status}. The token is ` +
            'missing, expired or lacks "Browse" on this project -- set SONARQUBE_TOKEN.');
    }
    if (response.status === 404) {
        return fail('report-missing', `SonarQube has no component "${projectKey}" (HTTP 404). Either the project ` +
            'key is wrong, or no analysis has ever been published for it.');
    }
    // Anything that is not a 200 is not an answer to this question. The check used to
    // be `>= 400`, which accepted every 2xx and every 3xx: curl is not given
    // `--location`, so a 302 is a body we were not sent to read (an SSO login page, a
    // reverse proxy's canonical-host bounce) and a 204 is no body at all. A 3xx whose
    // body happened to be JSON of the right shape was accepted as measures.
    if (response.status !== 200) {
        return fail('crashed', `SonarQube answered HTTP ${response.status} for the measures of "${projectKey}", ` +
            (response.status >= 300 && response.status < 400
                ? 'a redirect. The API is not at this URL -- SONARQUBE_URL is probably ' +
                    'missing a path prefix, or an SSO proxy is intercepting the request.'
                : 'which is not a reading. Only 200 carries measures.'));
    }
    let parsed;
    try {
        parsed = JSON.parse(response.body);
    }
    catch {
        return fail('unparseable-output', `SonarQube answered HTTP ${response.status} with a body that is not JSON ` +
            `(${response.body.length} bytes). A proxy or login page in front of the API ` +
            'produces exactly this.');
    }
    const measures = parsed.component?.measures;
    if (!measures || measures.length === 0) {
        return fail('measured-nothing', `SonarQube returned no measures for "${projectKey}". The component exists but ` +
            'the analysis published nothing -- check that the scan actually ran against ' +
            'this project key.');
    }
    // Parsed at the boundary, completely, into a value that is either a full reading or
    // a stated reason it is not one. What stood here read `m ? parseFloat(m.value) : 0`,
    // and both halves of that were unsound:
    //
    //   - an ABSENT measure became 0, so a response carrying only `bugs` reported
    //     `vulnerabilities: 0` and `blocker: 0`, and the ceilings on them passed. The
    //     gate said the code was clean because the server had not been asked, or had
    //     not answered, about the thing being graded.
    //   - a NON-NUMERIC value became NaN, and NaN passes every ceiling, because
    //     `NaN > 0` is false. `"bugs": "NaN"` -- or any string a malformed or
    //     truncated response leaves there -- read as a clean project.
    const readings = {};
    const absent = [];
    const malformed = [];
    for (const measure of SONAR_MEASURES) {
        const found = measures.find((m) => m.metric === measure.key);
        if (!found) {
            if (measure.required)
                absent.push(measure.key);
            continue;
        }
        const value = Number.parseFloat(found.value);
        if (!Number.isFinite(value) || value < 0) {
            malformed.push(`${measure.key}=${JSON.stringify(found.value)}`);
            continue;
        }
        readings[measure.field] = value;
    }
    if (malformed.length > 0) {
        return fail('unparseable-output', `SonarQube returned a measure that is not a number for "${projectKey}": ` +
            `${malformed.join(', ')}. A measure that will not parse cannot be graded, ` +
            'and treating it as zero would satisfy every ceiling on it.');
    }
    if (absent.length > 0) {
        return fail('measured-nothing', `SonarQube returned no value for ${absent.join(', ')} on "${projectKey}", ` +
            `though it answered with ${measures.length} other measure(s). Every analysis ` +
            'computes these, so this response is a partial reading -- most likely the ' +
            'analysis is still indexing, or the project key names a component that holds ' +
            'no code.');
    }
    // Every required measure is present and finite by the time control reaches here --
    // the `absent` check above returned otherwise -- so this fallback is unreachable
    // rather than a substitution. It exists because the check that establishes that is
    // a length test on a separate array, which the type system cannot follow.
    const required = (field) => readings[field] ?? 0;
    const readMetrics = {
        bugs: required('bugs'),
        vulnerabilities: required('vulnerabilities'),
        codeSmells: required('codeSmells'),
        // The two conditional measures, left absent rather than zeroed when SonarQube
        // did not send them: a floor on either then fails as "not available" instead
        // of reading as 0% coverage, and a project that imports no coverage report
        // into its scan is not told its coverage is nil.
        coverage: readings.coverage,
        duplications: readings.duplications,
        blocker: required('blocker'),
        critical: required('critical'),
        major: required('major'),
        minor: required('minor'),
        info: required('info'),
    };
    // LAST, after a complete reading exists. See bindReadingToAnalysis for why the
    // ordering is load-bearing in both directions.
    return bindReadingToAnalysis(readMetrics, submitted);
}
/** How long a git sha is, so a value that is not one is not compared as if it were. */
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
/**
 * Tie a complete sonarqube reading to the analysis this run submitted, or state why it
 * could not be.
 *
 * WHAT WAS WRONG. `waitForSonarTask` reduced the CE task to a boolean and
 * `/api/measures/component?component=<key>&metricKeys=...` has no analysis, task or
 * revision parameter -- its only parameters are `component`, `metricKeys`, `branch` and
 * `pullRequest` -- so it answers with the LIVE measures: whatever the most recently
 * PROCESSED analysis of that key left in the table. A second publisher for the same
 * project key between SUCCESS and this read replaces them and nothing in the response
 * says which analysis it described. The gate confirmed analysis A and graded analysis B.
 * The code path was read directly; the exploitability is unmeasured, because
 * reproducing it needs a live server with two concurrent scanners.
 *
 * WHY THIS RUNS LAST, twice over. Every classification in `readSonarqubeMetrics`
 * (unreachable / access-denied / project-404 / redirect / non-JSON / empty / partial /
 * malformed) is individually tested and must keep firing FIRST, so none of them is
 * pre-empted by a provenance answer -- and by the time control arrives here the host has
 * already proved it speaks JSON, which is why an unparseable body from THIS call is
 * treated as "cannot tell" rather than as a second refusal. Verify-AFTER is also the
 * only sound ordering: live measures only move forward, so "the current analysis was
 * still mine when I finished reading" implies the read got mine. Verify-BEFORE would
 * leave a false-PASS window (publish lands between the check and the read), and a false
 * pass is the defect this repository exists to prevent, where the ~100ms false-fail
 * window verify-after leaves costs a retry.
 *
 * THE RULE THAT ASSIGNS THE THREE ANSWERS, stated once so nobody re-derives it:
 *
 *   server named a DIFFERENT current analysis and recognises ours -> FAIL
 *     (`wrong-subject` on the sonarqube dimension, which fails the gate via
 *      rule-scoped gating in evaluateMeasurements)
 *   server REFUSED to discuss provenance: unreachable, 401/403, 3xx, 5xx -> FAIL
 *   server ANSWERED and told us nothing usable: either 404 flavour, empty list, no
 *     `analyses[].key`, non-JSON 200 -> UNVERIFIABLE (advisory)
 *   never named the analysis (`unnamed`), or nothing was scanned -> UNVERIFIABLE
 *
 * WHY `/api/project_analyses/search` AND NOT `/api/ce/component`, whose `current`
 * carries `analysisId` directly: `current` is the last EXECUTED task for the component
 * INCLUDING pull requests. Observed on next.sonarqube.com: `current` was a task with
 * `"pullRequest":"601"` while `project_analyses/search` named the main-branch analysis.
 * The graded read passes no `branch`, so it reads the main branch -- `project_analyses`
 * is the endpoint scoped to the same thing as the read being verified.
 *
 * WHY NOT `/api/measures/search_history` pinned to the analysis date, which would be an
 * at-analysis read rather than a latest-check: it does not REPLACE this call (this is
 * the only endpoint mapping an analysis key to its date, so it would be an addition);
 * it is keyed to a second-granularity timestamp, so two analyses in one second are
 * indistinguishable where an id comparison has no such limit; it requires "Browse"
 * where `measures/component` also accepts "Execute Analysis" since 2025.2, so it would
 * narrow the permission needed for the PRIMARY graded read and turn a failed
 * verification into "the measures cannot be read at all"; and it expresses absence as an
 * empty `history` array rather than a missing metric, which would force a rewrite of the
 * completeness parse above -- the loop whose comment records the original vacuous-pass
 * reproduction.
 *
 * WHY `project_status` IS A SAFE CORROBORATOR on a mismatch: it accepts Administer
 * System OR project Administer OR Browse OR Execute Analysis (SCAN since 9.5), strictly
 * wider than the call above, and `getSnapshotThenProject` calls
 * `checkFoundWithOptional("Analysis with id '%s' is not found")` BEFORE `checkPermission`
 * -- so its 404-vs-not-404 answer is truthful even for a narrow token.
 *
 * WHAT WAS PROBED, rather than inferred, on 2026-08-08 against SonarQube Server
 * Community 26.6.0.123539 (sonarqube.ow2.org) and SonarQube Cloud 8.0.0.100793:
 *
 *   project_analyses/search?project=ASM:asm&ps=1
 *     -> analyses[0].key = "4bf5c7a8-eb72-43cc-9c8f-bde3d1477722",
 *        .date, .revision = "2f73cdd24936f5bdd872d6a09d0fa2d5ec7f869d" (a full git sha)
 *   ce/component?component=ASM:asm
 *     -> current.analysisId = "4bf5c7a8-eb72-43cc-9c8f-bde3d1477722", BYTE-IDENTICAL.
 *        `current` is formatted by the same `TaskFormatter.formatActivity` that serves
 *        /api/ce/task, so ce/task's analysisId and project_analyses' key are ONE
 *        identifier space -- observed, not inferred. This is the fact the whole design
 *        rests on.
 *   qualitygates/project_status?analysisId=<that key>            -> HTTP 200
 *   qualitygates/project_status?analysisId=<well-formed bogus>   -> HTTP 404
 *        "Analysis with id '...' is not found" -- on BOTH Server and Cloud, so the
 *        corroborator is not a Server-only parameter.
 *   project_analyses/no_such_action -> 404 {"errors":[{"msg":"Unknown url : ..."}]}
 *   project_analyses/search?project=<absent> -> 404 "Component key '...' not found"
 *
 * WHY A MISMATCH STANDS UNLESS `project_status` 404s, rather than the other way round.
 * The inverted rule -- fail only when the probe POSITIVELY confirms our id -- was
 * considered and rejected on the probe evidence above: the scenario it protects against
 * is "ce/task ids are not project_analyses keys on some platform, so every run
 * mismatches and every run fails unresolvably", and the two platforms that exist were
 * measured to share the id space and to answer this probe. Under the inverted rule a
 * REAL race whose probe is merely blocked (an SSO proxy in front of /api/qualitygates, a
 * CE answering 503) becomes exit 0, which is the direction this repository does not
 * accept. The message says what the corroborator answered, so an adopter is never told
 * the id was recognised when it was not.
 *
 * WHY BOTH 404 FLAVOURS ARE ADVISORY and the body text only picks a WORD: matching the
 * server-side English literal `Unknown url` is exactly the check that rots across
 * versions, so a wrong guess must cost a word in a message and must never pick a
 * verdict. The project-not-found flavour is not a contradiction even though the measures
 * read for the same key just succeeded: `project_analyses/search` resolves a project or
 * application while `measures/component` resolves ANY component, so a key naming a
 * module, directory or file answers one and not the other. Deliberately not retried with
 * the task's `componentKey` -- a provenance check keyed to something other than the
 * graded component is not a check of the graded component.
 *
 * KNOWN IMPRECISION, in both directions. `project_analyses/search` orders by the
 * analysis DATE (scanner-supplied: `sonar.projectDate`, else scan start) while the live
 * measures follow PROCESSING order. A foreign analysis dated earlier but processed later
 * leaves the list naming ours and the measures being theirs -- a false PASS this check
 * cannot see -- and the reverse produces a false fail. SonarQube's CE is understood to
 * reject an analysis dated before the last known one for a project, which would force
 * the two orders to agree, but that was NOT verified here and neither direction is
 * claimed closed.
 */
function bindReadingToAnalysis(metrics, submitted) {
    const config = getConfig();
    const sonarUrl = redactUrlCredentials(config.sonarqube.url);
    const projectKey = config.sonarqube.projectKey;
    // Both helpers scrub BY CONSTRUCTION, because every message below interpolates a
    // server-supplied string (`analyses[0].key`, `.date`, `.revision`) and the advisory
    // travels as far as the failure does: `evaluateAnalysisProvenance` copies `why` into
    // an `UnevaluatedRule.message`, which the CLI prints and the MCP server serialises.
    const unconfirmed = (why) => ({
        metrics,
        provenance: { kind: 'unconfirmed', why: scrubCredential(why) },
    });
    if (submitted.kind === 'not-scanned') {
        // No HTTP call: there is no analysis of ours to compare against, so there is
        // nothing to ask. `score`, `suggest` and the MCP handlers pay nothing for a
        // verification they could not use.
        return unconfirmed(`no analysis was submitted by this process, so these are whatever numbers ` +
            `SonarQube currently holds for "${projectKey}" -- from an analysis of unknown ` +
            'vintage, possibly of a different commit.');
    }
    const query = `/api/project_analyses/search?project=${projectKey}&ps=1`;
    const response = sonarGet(query);
    const fail = (kind, message) => ({
        failure: measurementFailure(kind, 'sonarqube', scrubCredential(message), 
        // The evidence reproduces THIS call, not the measures call: an evidence command
        // that reproduces a call which succeeded is worse than none.
        sonarEvidence(query, response)),
    });
    if (response.kind === 'unreachable') {
        return fail('tool-missing', `The measures for "${projectKey}" were read, but SonarQube at ${sonarUrl} did not ` +
            `answer when asked which analysis they came from (${response.reason}). Refusing ` +
            'to grade numbers whose provenance the server would not state -- they may be a ' +
            'concurrent scan\'s. Retry, or drop the sonarqube rules and use --coverage-only.');
    }
    if (response.status === 401 || response.status === 403) {
        return fail('access-denied', `SonarQube refused to say which analysis the measures of "${projectKey}" came from ` +
            `(HTTP ${response.status}). /api/project_analyses/search requires "Browse": ` +
            '"Execute Analysis" alone is enough to run the scan and read the measures (since ' +
            '2025.2) but not to list the analyses, and no endpoint that names the current ' +
            'analysis accepts it -- api/ce/activity requires Administer and api/ce/component ' +
            'requires Browse. Grant "Browse" to SONARQUBE_TOKEN, or use --coverage-only.');
    }
    if (response.status === 404) {
        return unconfirmed(response.body.includes('Unknown url')
            ? `/api/project_analyses/search does not exist on this server (HTTP 404), so ` +
                `there is no way to ask which analysis the measures of "${projectKey}" came ` +
                'from. The numbers were read and are being graded unverified.'
            : `SonarQube answered HTTP 404 for the analysis list of "${projectKey}": it does ` +
                'not resolve that key to a project (the measures read did resolve it, so the ' +
                'key most likely names a module, directory or file inside one). There is no ' +
                'analysis list to check these numbers against.');
    }
    if (response.status !== 200) {
        return fail('crashed', `SonarQube answered HTTP ${response.status} when asked which analysis the measures ` +
            `of "${projectKey}" came from, ` +
            (response.status >= 300 && response.status < 400
                ? 'a redirect. A 3xx body is not an answer about provenance even when it is ' +
                    'JSON of the right shape -- SONARQUBE_URL is probably missing a path prefix, ' +
                    'or an SSO proxy is intercepting the request.'
                : 'which is not an answer. Only 200 carries an analysis list.'));
    }
    let parsed;
    try {
        parsed = JSON.parse(response.body);
    }
    catch {
        return unconfirmed(`SonarQube's analysis list for "${projectKey}" came back as a body that is not JSON ` +
            `(${response.body.length} bytes), so the provenance of these numbers could not be ` +
            'read. The measures themselves parsed, so this is one endpoint answering oddly ' +
            'rather than a proxy in front of the whole API.');
    }
    const current = parsed.analyses?.[0];
    const currentKey = typeof current?.key === 'string' && current.key.length > 0
        ? current.key
        : undefined;
    if (currentKey === undefined) {
        return unconfirmed(`SonarQube's analysis list for "${projectKey}" named no current analysis (HTTP 200, ` +
            `${response.body.length} bytes), so there is nothing to compare these numbers ` +
            'against. An empty list, or a shape carrying no analysis key, says only that the ' +
            'question could not be answered -- it is not evidence that the numbers are ' +
            "somebody else's.");
    }
    // The `unnamed` half of the check: the server would not name OUR analysis, so its id
    // cannot be compared -- but the current analysis's REVISION can be compared against the
    // commit being graded, which catches the larger and likelier hazard (these numbers are
    // a different COMMIT's) on the call already made. Complementary and not a substitute:
    // a revision match cannot distinguish two concurrent scans of the same commit, which
    // is what an id comparison is for, so a match is still only `unconfirmed`.
    if (submitted.kind === 'unnamed') {
        const revision = typeof current?.revision === 'string' ? current.revision : undefined;
        const graded = gradedRevision();
        if (revision !== undefined &&
            graded !== undefined &&
            GIT_SHA_PATTERN.test(revision) &&
            revision !== graded) {
            return fail('wrong-subject', `SonarQube confirmed analysis task ${submitted.taskId} as SUCCESS but reported no ` +
                `"analysisId" for it, and the analysis it considers current for "${projectKey}" ` +
                `(${currentKey}) is of revision ${revision}, not the ${graded} being graded. ` +
                'The measures endpoint has no analysis parameter, so the numbers just read are ' +
                "that other commit's. Check that the scan reaches the server and publishes for " +
                'this project key, or drop the sonarqube rules and use --coverage-only.');
        }
        return unconfirmed(`SonarQube confirmed analysis task ${submitted.taskId} as SUCCESS but its response ` +
            `carried no "analysisId", so there is no identifier to check these numbers ` +
            `against. ${sonarUrl} may be an edition or version that omits the field. ` +
            (revision === undefined
                ? 'The current analysis names no revision either (SCM detection off, or ' +
                    'sonar.scm.disabled), so nothing about these numbers could be corroborated.'
                : graded === undefined
                    ? `The current analysis is of revision ${revision}, which could not be ` +
                        'compared against anything because the commit being graded could not be read.'
                    : `Its current analysis is of revision ${revision}, which IS the commit being ` +
                        'graded -- so these numbers describe this commit, but not provably this ' +
                        "run's analysis of it."));
    }
    if (currentKey === submitted.analysisId) {
        return { metrics, provenance: { kind: 'confirmed', analysisId: currentKey } };
    }
    // A mismatch does not fail on its own evidence. If ce/task's `analysisId` and
    // project_analyses' `key` were ever different identifier spaces -- an edition nobody
    // probed -- every run would mismatch, and failing on that would be a refusal the
    // adopter cannot resolve, which is what killed two earlier designs for this check.
    // A 404 here means the server does not recognise the id it just gave us, so the
    // difference is not evidence of anything.
    const probeQuery = `/api/qualitygates/project_status?analysisId=${submitted.analysisId}`;
    const probe = sonarGet(probeQuery);
    if (probe.kind === 'ok' && probe.status === 404) {
        return unconfirmed(`SonarQube says the current analysis of "${projectKey}" is ${currentKey}, not the ` +
            `${submitted.analysisId} it reported for task ${submitted.taskId} -- and it does ` +
            `not recognise ${submitted.analysisId} as an analysis id at all (HTTP 404 from ` +
            '/api/qualitygates/project_status). The task API and the analysis list are not ' +
            'naming the same thing on this server, so the difference is not evidence that ' +
            "these numbers are somebody else's.");
    }
    const corroboration = probe.kind === 'unreachable'
        ? ` (the server did not answer when asked whether ${submitted.analysisId} exists: ` +
            `${probe.reason}, so the mismatch stands uncorroborated)`
        : probe.status === 200
            ? ` (it does recognise ${submitted.analysisId} as an analysis, so the two are ` +
                'naming the same kind of thing)'
            : ` (asked whether ${submitted.analysisId} exists, it answered HTTP ` +
                `${probe.status}, so the mismatch stands uncorroborated)`;
    return fail('wrong-subject', `The analysis this run submitted (${submitted.analysisId}, task ${submitted.taskId}) ` +
        `is not the one SonarQube considers current for "${projectKey}": that is ` +
        `${currentKey}` +
        (typeof current?.date === 'string' ? ` from ${current.date}` : '') +
        (typeof current?.revision === 'string' ? ` at revision ${current.revision}` : '') +
        `${corroboration}. The measures endpoint has no analysis parameter, so the numbers ` +
        `just read are ${currentKey}'s, not this commit's. ` +
        (submitted.pullRequest !== undefined
            ? `This run's analysis was of pull request ${submitted.pullRequest} and the ` +
                'measures read is the project\'s default branch -- the two can never agree. ' +
                'This gate has no branch option: point the scan at the default branch, or use ' +
                '--coverage-only.'
            : submitted.branch !== undefined
                ? `This run's analysis was of branch "${submitted.branch}" and the measures read ` +
                    'is the project\'s default branch -- they agree only when that IS the default ' +
                    'branch. This gate has no branch option: point the scan at the default branch, ' +
                    'or use --coverage-only.'
                : 'Another job most likely published for the same project key while this run was ' +
                    'waiting. Serialise the scans on this project key (or give each one its own ' +
                    'key), or drop the sonarqube rules and use --coverage-only.'));
}
/**
 * The commit whose code is being graded, or `undefined` if git will not say.
 *
 * Read here rather than threaded in from the caller because it is a property of the
 * SUBJECT, like `projectKey` two lines up, not of what the scan submitted -- and because
 * an optional parameter for it would be a quiet path: a call site that forgot it would
 * silently downgrade a refusal to an advisory. `undefined` degrades to the advisory
 * honestly and says so in the message.
 */
function gradedRevision() {
    try {
        return getCurrentCommitHash();
    }
    catch {
        return undefined;
    }
}
/**
 * Whether there is a SonarQube server here at all.
 *
 * It used to return `true` whenever curl did not throw, which is to say whenever
 * something accepted a TCP connection. `-o /dev/null -w "%{http_code}"` fetched the
 * status and then discarded it, so a 401, a 503 or an nginx error page all read as
 * "available", the gate ran the scan, and the failure surfaced -- if at all -- as an
 * absent dimension much further downstream.
 *
 * Deliberately still tolerant of 4xx. A root URL behind auth answers 401 while the
 * API is perfectly usable with a token, so refusing here would be wrong; what this
 * has to exclude is "nothing answered" and "the server is broken". Authorization is
 * judged where it is actually exercised, by `readSonarqubeMetrics`, which can say
 * which endpoint refused and why.
 */
export function isSonarqubeAvailable() {
    const response = sonarGet('');
    return response.kind === 'ok' && response.status < 500;
}
/**
 * Wait for a SonarQube analysis task to complete.
 * Polls the task API until status is SUCCESS, FAILED, or CANCELED.
 */
function waitForSonarTask(taskId, timeoutMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds
    while (Date.now() - startTime < timeoutMs) {
        // Through `sonarGet` like every other call, which buys two things here. The body
        // is separated from the HTTP status, so a login page or an error document is
        // never handed to JSON.parse and swallowed as "still in progress"; and a refusal
        // is distinguishable from a transient blip, so the loop can stop instead of
        // spinning out the full two minutes and reporting a timeout for what was really
        // an expired token.
        const response = sonarGet(`/api/ce/task?id=${taskId}`);
        if (response.kind === 'ok' && (response.status === 401 || response.status === 403)) {
            return {
                success: false,
                error: `SonarQube refused the task query with HTTP ${response.status} -- the token ` +
                    'is missing, expired, or lacks permission on this project. The scan may ' +
                    'have run; its result cannot be confirmed.',
            };
        }
        // Only a 200 is an answer about this task, for the same reason as the measures
        // call: without `--location` a 3xx is a redirect body, and `< 400` accepted it.
        if (response.kind === 'ok' && response.status === 200) {
            try {
                const parsed = JSON.parse(response.body);
                const status = parsed.task?.status;
                // The id is checked, not assumed. A response about a DIFFERENT task is not
                // confirmation of this one -- a proxy serving a cached body, or a server that
                // ignores an unknown id and returns the most recent task, both land here, and
                // both would otherwise report SUCCESS for an analysis we never submitted.
                const answeredAbout = parsed.task?.id;
                if (answeredAbout !== undefined && answeredAbout !== taskId) {
                    return {
                        success: false,
                        error: `Asked SonarQube about analysis task ${taskId} and it answered about ` +
                            `${answeredAbout}. That is not a confirmation of this commit's scan, so ` +
                            'it is not being treated as one.',
                    };
                }
                if (status === 'SUCCESS') {
                    // The analysis identity is carried OUT of here, because this response is the
                    // only place it exists. It is the same string `/api/project_analyses/search`
                    // returns as `analyses[].key` -- both are `analysisMetadataHolder.getUuid()`,
                    // and the equality was observed rather than assumed: on SonarQube Community
                    // 26.6.0, `/api/ce/component?component=ASM:asm` reported
                    // `current.analysisId = "4bf5c7a8-eb72-43cc-9c8f-bde3d1477722"` and
                    // `/api/project_analyses/search?project=ASM:asm&ps=1` reported the same string
                    // as `analyses[0].key`; `current` is formatted by the same
                    // `TaskFormatter.formatActivity` that serves this endpoint.
                    //
                    // An EMPTY string is not an identity: some protobuf-to-JSON renderings emit
                    // one for an unset optional, and treating it as named would compare "" against
                    // a real key and refuse a healthy run.
                    const analysisId = parsed.task?.analysisId;
                    if (analysisId === undefined || analysisId.length === 0) {
                        return { success: true, submitted: { kind: 'unnamed', taskId } };
                    }
                    return {
                        success: true,
                        submitted: {
                            kind: 'named',
                            taskId,
                            analysisId,
                            branch: parsed.task?.branch,
                            pullRequest: parsed.task?.pullRequest,
                        },
                    };
                }
                if (status === 'FAILED') {
                    return {
                        success: false,
                        error: parsed.task?.errorMessage || 'Analysis task failed',
                    };
                }
                if (status === 'CANCELED') {
                    return { success: false, error: 'Analysis task was canceled' };
                }
                // Still in progress - wait and retry
            }
            catch {
                // A 2xx that is not JSON is a proxy in the way; keep polling rather than
                // deciding the analysis failed on the strength of one bad body.
            }
        }
        // Sleep for poll interval
        execSync(`sleep ${pollInterval / 1000}`, { encoding: 'utf-8' });
    }
    return {
        success: false,
        error: 'Timed out waiting for analysis to complete',
    };
}
/** Where the scanner names the analysis it submitted. */
function reportTaskPath() {
    return path.join(getConfig().projectRoot, '.scannerwork/report-task.txt');
}
/**
 * Extract the task ID from SonarQube scanner's report-task.txt file.
 */
function getSonarTaskId() {
    const filePath = reportTaskPath();
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // File contains lines like: ceTaskId=AZQxyz123...
        const match = content.match(/ceTaskId=([^\s\n]+)/);
        return match?.[1];
    }
    catch {
        return undefined;
    }
}
export function runSonarqubeScan() {
    const config = getConfig();
    const maxRetries = 2;
    let lastError = '';
    // Read BEFORE the scanner runs, so the check below can tell a new analysis from
    // last run's leftover file. `undefined` here is the ordinary first-scan case and
    // makes every id that follows a new one.
    const priorTaskId = getSonarTaskId();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (attempt > 1) {
            console.error(`  Retry attempt ${attempt}/${maxRetries}...`);
            // Brief pause before retry
            spawnSync('sleep', ['5'], { shell: true });
        }
        // Runs the project's `sonar` script, which handles the full scan (with locking),
        // through the runner so no npm literal is left behind.
        const sonar = scriptCommand('sonar', config.packageManager);
        const result = spawnSync(sonar.executable, [...sonar.args], {
            cwd: config.projectRoot,
            encoding: 'utf-8',
            shell: true,
            timeout: 300000, // 5 minutes for scan
            stdio: ['pipe', 'pipe', 'pipe'],
            // A scanner run is chatty enough to cross 1 MiB routinely, and being cut
            // off there kills the child mid-scan and reads back as a failed scan.
            maxBuffer: SUBPROCESS_MAX_BUFFER,
        });
        const errorOutput = (result.stderr || '') + (result.stdout || '');
        if (result.status === 0) {
            // The scanner exited 0. That is not the same as "this commit was analysed",
            // and treating it as such is what this refusal exists to stop.
            //
            // `report-task.txt` is how the scanner names the analysis it just submitted.
            // Without it there is no task to wait for and no way to tell whether the
            // server ever received one -- so the run used to return success, skip
            // `waitForSonarTask`, and let `readSonarqubeMetrics` read whatever the server
            // already had. Which is the PREVIOUS commit's numbers. The comment that stood
            // here said so out loud ("might be from previous scan") and returned success
            // anyway: this commit graded against the last one's analysis, with a
            // `sonarqube.blocker: 0` ceiling satisfied by a scan of different code.
            //
            // Blocking has a real cost and the message has to carry the remedy, because
            // the honest reading of this state is "I cannot tell", not "you are broken":
            // a scanner configured to write elsewhere, or run from a different working
            // directory, lands here while working perfectly.
            const taskId = getSonarTaskId();
            if (!taskId) {
                return {
                    success: false,
                    error: `The scan exited 0 but wrote no readable task id to ` +
                        `${reportTaskPath()}, so ` +
                        'there is no analysis to wait for and no way to confirm this commit was ' +
                        'analysed at all. Refusing to grade it against whatever the server ' +
                        'already holds -- those are the previous commit\'s numbers. Run the ' +
                        'scanner from the project root so it writes .scannerwork there, or drop ' +
                        'the sonarqube rules and use --coverage-only.',
                };
            }
            // A task id that was already there before this scan ran is the SAME hole the
            // check above closes, reached through a different door. `.scannerwork` is not
            // cleaned between runs, so a scanner that exits 0 without submitting an
            // analysis -- a no-op run, a `-Dsonar.scanner.dumpToFile` invocation, a scan
            // that never reached the server -- leaves the PREVIOUS run's file in place.
            // Its task id is on the server and long since SUCCESS, so waiting on it
            // confirms instantly and the gate grades this commit against the last one's
            // numbers, which is precisely what the refusal above exists to prevent.
            //
            // Task ids are per submission, so "unchanged" is sufficient evidence that
            // nothing new was submitted. Compared rather than deleted: the file is the
            // scanner's artifact and other tooling reads it, so removing it to force the
            // question would break those callers to answer one we can answer by looking.
            if (taskId === priorTaskId) {
                return {
                    success: false,
                    error: `The scan exited 0 but left the task id in ${reportTaskPath()} unchanged ` +
                        `(${taskId}), which means it submitted no new analysis -- that id is the ` +
                        'one the previous run already waited on. Confirming it would confirm the ' +
                        "previous commit's scan and grade this commit against its numbers. Check " +
                        'that the scanner is actually reaching the server, or drop the sonarqube ' +
                        'rules and use --coverage-only.',
                };
            }
            // Wait for the analysis task to complete
            return waitForSonarTask(taskId);
        }
        // Check if this is a transient error worth retrying
        const isTransient = errorOutput.includes('WebSocket connection error') ||
            errorOutput.includes('Connection reset') ||
            errorOutput.includes('Broken pipe') ||
            errorOutput.includes('Another SonarQube analysis is already in progress');
        lastError = errorOutput.slice(-500);
        if (!isTransient || attempt === maxRetries) {
            return {
                success: false,
                error: lastError,
            };
        }
        // Transient error - will retry
        console.error(`  Transient error detected, will retry...`);
    }
    return {
        success: false,
        error: lastError,
    };
}
// =============================================================================
// TypeScript Metrics
// =============================================================================
/**
 * Measures the type-check once, so callers that want the totals and callers
 * that want the located errors cannot end up disagreeing about the same run.
 */
function measureTypescript() {
    const config = getConfig();
    return typescriptTypecheckProvider.measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.typecheckTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
        packageManager: config.packageManager,
        typecheckScript: config.typecheckScript,
    });
}
/**
 * Type-check totals, or `undefined` when the type-check could not be run.
 *
 * `undefined` rather than `{errors: 0}`. Returning zero was the vacuous pass:
 * the old inline implementation scanned whatever output arrived with no
 * exit-code check at all, so a crashed, killed, or missing type-check produced
 * an empty string, matched no diagnostics, and satisfied a
 * `typescript.errors: 0` ceiling.
 *
 * Absence alone would not fix that -- `evaluateCeilings` skips a missing metric
 * just as quietly. What makes it loud is `extractAllMetrics` recording the
 * MeasurementFailure alongside, which `evaluateRules` fails on. Callers using
 * this function directly get the honest `undefined` and no diagnosis; that is
 * why the gate path does not use it.
 */
export function extractTypescriptMetrics() {
    const reading = measureTypescript();
    return reading.ok ? reading.value.metrics : undefined;
}
// =============================================================================
// ESLint Metrics
// =============================================================================
function measureEslint() {
    const config = getConfig();
    return eslintLintProvider.measure({
        projectRoot: config.projectRoot,
        timeoutMs: DEFAULT_MEASUREMENT_LIMITS.lintTimeoutMs,
        maxBufferBytes: DEFAULT_MEASUREMENT_LIMITS.maxBufferBytes,
        packageManager: config.packageManager,
        typecheckScript: config.typecheckScript,
    });
}
/**
 * Lint totals, or `undefined` when eslint could not be run.
 *
 * Replaces `errors: exitCode === 0 ? 0 : 1`, which was wrong twice over: a
 * linter that could not run was reported as one ordinary lint error, and a
 * failure that happened to exit 0 -- a broken config, an empty report -- as a
 * clean project. See extractTypescriptMetrics for why absence is only half the
 * fix.
 */
export function extractEslintMetrics() {
    const reading = measureEslint();
    return reading.ok ? reading.value.metrics : undefined;
}
// =============================================================================
// Script Execution
// =============================================================================
export function runScript(script) {
    const config = getConfig();
    const timeout = config.scriptTimeouts[script] ?? config.defaultScriptTimeout;
    // The same bun fall-through that the typecheck provider refuses, on the path that
    // decides `requiredScripts`. `bun run <name>` for an undefined script executes a
    // same-named `node_modules/.bin` binary and can exit 0, so a required script the
    // project does not have would report `pass` -- while npm exits 1 and reports `fail`.
    // Two managers disagreeing about whether a script ran is not a difference this
    // function may pass on to the gate. Reproduced against bun 1.3.14.
    if (!manifestDefinesScript(config.projectRoot, script))
        return 'fail';
    const command = scriptCommand(script, config.packageManager);
    const result = spawnSync(command.executable, [...command.args], {
        cwd: config.projectRoot,
        encoding: 'utf-8',
        shell: true,
        timeout,
        // Without this a *passing* script that prints more than 1 MiB -- a test
        // suite, typically -- is killed at the buffer, comes back with a null
        // status, and is recorded as a failure. It errs in the safe direction, but
        // it is still the wrong answer about the script.
        maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    return result.status === 0 ? 'pass' : 'fail';
}
export function runScripts(scripts) {
    const results = {};
    for (const script of scripts) {
        results[script] = runScript(script);
    }
    return results;
}
// =============================================================================
// SLOC Extraction (Source Lines of Code)
// =============================================================================
/**
 * Count source lines of code in a directory.
 * Uses a simple heuristic: non-empty, non-comment lines in .ts/.tsx/.js/.jsx files.
 * For determinism, always scans the same directories with the same rules.
 */
export function extractSloc(srcDir) {
    const config = getConfig();
    const targetDir = srcDir ?? path.join(config.projectRoot, 'src');
    if (!fs.existsSync(targetDir)) {
        return 0;
    }
    let totalSloc = 0;
    function countLinesInFile(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            let sloc = 0;
            let inBlockComment = false;
            for (const line of lines) {
                const trimmed = line.trim();
                // Handle block comments
                if (inBlockComment) {
                    if (trimmed.includes('*/')) {
                        inBlockComment = false;
                    }
                    continue;
                }
                if (trimmed.startsWith('/*')) {
                    if (!trimmed.includes('*/')) {
                        inBlockComment = true;
                    }
                    continue;
                }
                // Skip empty lines and single-line comments
                if (trimmed === '' || trimmed.startsWith('//')) {
                    continue;
                }
                sloc++;
            }
            return sloc;
        }
        catch {
            return 0;
        }
    }
    function walkDirectory(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                // Skip node_modules, dist, coverage, .git, etc.
                if (entry.isDirectory() &&
                    !['node_modules', 'dist', 'coverage', '.git', '.next', 'build'].includes(entry.name)) {
                    walkDirectory(fullPath);
                }
                else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
                        // Skip test files and type declaration files
                        if (!entry.name.includes('.test.') &&
                            !entry.name.includes('.spec.') &&
                            !entry.name.endsWith('.d.ts')) {
                            totalSloc += countLinesInFile(fullPath);
                        }
                    }
                }
            }
        }
        catch {
            // Skip directories we can't read
        }
    }
    walkDirectory(targetDir);
    return totalSloc;
}
export function extractAllMetrics(scriptsToRunOrOptions = ['quality']) {
    return extractAllMetricsAndCoverageProvenance(scriptsToRunOrOptions).metrics;
}
export function extractAllMetricsAndCoverageProvenance(scriptsToRunOrOptions = ['quality']) {
    // Support both legacy array signature and new options object
    const options = Array.isArray(scriptsToRunOrOptions)
        ? { scriptsToRun: scriptsToRunOrOptions }
        : scriptsToRunOrOptions;
    const scriptsToRun = options.scriptsToRun ?? ['quality'];
    const skipSonarQube = options.skipSonarQube ?? false;
    const skipCustomDimensions = options.skipCustomDimensions ?? false;
    // ---------------------------------------------------------------------------
    // Every measurement is hoisted OUT of the return literal below, in the order
    // it must actually happen.
    //
    // Object-literal properties are evaluated top-to-bottom, so writing
    // `{coverage: read(), ..., scripts: runScripts()}` read the coverage report
    // BEFORE running the scripts that rewrite it. Confirmed end to end: with a
    // 10%-statements report planted and `scriptsToRun: ['test:coverage']`, the
    // gate reported `coverage.unit.statements = 10` while the same file on disk
    // afterwards said 25. Four reads were on the wrong side of `runScripts` --
    // both coverage summaries, the SonarQube measures, and the custom-dimension
    // shell extractors, which commonly read build artifacts.
    //
    // What the ordering alone does NOT establish is that the report describes the
    // code being graded when no script the gate ran wrote it: a project that
    // generates coverage outside the gate was graded on whatever was on disk.
    // coverage-provenance.ts closes that for a report that carries a sidecar, and
    // says so out loud for one that does not:
    //
    //   - the summaries are snapshotted BEFORE the mutating step and stamped after
    //     it, so a report this run produced records the code it was produced from;
    //   - after the read, each suite that yielded a NUMBER is verified against its
    //     sidecar. A recorded state that no longer matches is a `stale-report`
    //     measurement failure; a report nobody stamped is an advisory, not silence.
    //
    // What remains open is the un-stamped report itself -- the advisory does not
    // prevent it being graded, because "nobody stamped this" is not evidence the
    // numbers are wrong. It prevents the run being CACHED as a verdict.
    //
    // The return literal's property ORDER is deliberately left exactly as it was,
    // because the refactor harness compares capture sections with raw
    // `JSON.stringify` equality and does not sort keys: moving `scripts:` up
    // inside the literal would reject the frozen baseline for a pure
    // serialization change, with no number different anywhere.
    //
    // `sonarqubeProvenance` was ADDED to that literal, immediately after `sonarqube`,
    // and it leaves golden-A.json byte-identical: capture.mjs runs with
    // `skipSonarQube: true`, so the value is `undefined` and `JSON.stringify` omits the
    // key entirely.
    // ---------------------------------------------------------------------------
    // Whether anything in this extraction can rewrite a coverage report at all.
    //
    // Gated rather than unconditional so a run that cannot possibly produce a report --
    // `capture.mjs` passes `scriptsToRun: []` with custom dimensions skipped, and so do
    // most of the mocked unit suites -- pays nothing: no stat of the summaries, and no
    // git call to establish the code state. There is no third way for the summary to
    // move during this function.
    const canRewriteReports = scriptsToRun.length > 0 ||
        (!skipCustomDimensions && (options.customDimensions?.length ?? 0) > 0);
    // Taken BEFORE the mutating step, and it carries the code state as well as the
    // summaries -- see CoverageProvenanceSnapshot for the codegen-during-build false
    // pass that second half exists to refuse.
    const summariesBeforeScripts = canRewriteReports
        ? snapshotCoverageStateBeforeScripts()
        : undefined;
    // First: this is the step that MUTATES the project.
    const scripts = runScripts(scriptsToRun);
    // Extract custom metrics if configs are provided and not skipped
    let custom;
    const customFailures = [];
    if (!skipCustomDimensions && options.customDimensions && options.customDimensions.length > 0) {
        // `getConfig().projectRoot`, the same root every other dimension is measured
        // against. Custom extractors used to inherit the CLI's cwd, so one reading could
        // describe two different trees -- see extractCustomMetric.
        const reading = extractAllCustomMetrics(options.customDimensions, getConfig().projectRoot);
        custom = reading.metrics;
        customFailures.push(...reading.failures);
    }
    // Everything that can mutate the project has now run -- the scripts AND the custom
    // shell extractors, which are arbitrary commands -- and the read is next. Stamping
    // here is what makes the sidecar describe the report that is about to be graded
    // rather than some later state of it.
    if (summariesBeforeScripts !== undefined) {
        stampCoverageSummariesRewrittenDuringRun(summariesBeforeScripts, 'run');
    }
    // Measured once each, and both halves of every reading kept together: the
    // metrics if it worked, the reason if it did not. Calling the public
    // `extract*Metrics` wrappers here instead would discard the reason, which is
    // the only thing that makes a missing ceiling metric fail rather than pass.
    const typescript = measureTypescript();
    const eslint = measureEslint();
    const coverage = measureCoverage({
        absentReportIsFailure: options.coverageAbsenceIsFailure ?? true,
    });
    // Asked ONLY about the suites that produced a number, which is also the
    // double-reporting guard -- see suitesWithNumbers. A suite whose report is missing
    // or unparseable already carries a failure of its own, and a provenance verdict
    // beside it would report one broken report twice.
    const coverageProvenance = verifyCoverageProvenance(suitesWithNumbers(coverage.metrics));
    // Read through the failure-carrying variant. The public `extractSonarqubeMetrics`
    // still returns a bare value for its other callers, and using it HERE was the
    // defect: it discards the reason, and the reason is the only thing that turns a
    // vanished dimension into a failed rule.
    const sonarqube = skipSonarQube
        ? SONARQUBE_NOT_MEASURED
        : readSonarqubeMetrics(options.submittedAnalysis ?? { kind: 'not-scanned' });
    const sloc = extractSloc();
    const measurementFailures = [
        ...[typescript, eslint]
            .filter((reading) => !reading.ok)
            .map((reading) => reading.error),
        // Appended rather than prepended so the existing typescript-then-eslint
        // ordering that tests assert on is untouched.
        ...coverage.failures,
        // Immediately after, so both halves of "what is wrong with the coverage reading"
        // are together: what the report says, then which code it says it about.
        ...coverageProvenanceFailures(coverageProvenance),
        ...customFailures,
        // Last, so the orderings the existing tests assert on are untouched. `--coverage-only`
        // yields no reading and therefore no failure, which is correct: the adopter asked
        // for the dimension to be skipped, and a skipped dimension is not a lost one.
        ...(sonarqube.failure ? [sonarqube.failure] : []),
    ];
    return {
        metrics: {
            coverage: coverage.metrics,
            typescript: typescript.ok ? typescript.value.metrics : undefined,
            eslint: eslint.ok ? eslint.value.metrics : undefined,
            sonarqube: sonarqube.metrics,
            sonarqubeProvenance: sonarqube.provenance,
            scripts,
            sloc,
            custom,
            measurementFailures: measurementFailures.length > 0 ? measurementFailures : undefined,
        },
        coverageProvenance,
    };
}
/**
 * The dimensions a reading is missing, for the surfaces that report a NUMBER
 * rather than a verdict.
 *
 * `score` and `suggest` cannot reasonably refuse to answer the way the gate
 * does -- a fitness score over the dimensions that could be read is still the
 * most useful thing available. What they must not do is present it as complete.
 * A score silently computed over a smaller quality space than the project
 * configured reads as "you are at 82" when the honest statement is "you are at
 * 82 across the dimensions I could measure, and one of them I could not".
 *
 * Returns `undefined` rather than an empty array so it disappears from JSON
 * output entirely when everything was measured.
 *
 * `numberReported` exists because one kind breaks the assumption the name of this
 * function is built on. Every failure but `stale-report` arrives with
 * `metrics: undefined` for its dimension, which is why "missing from this score" was
 * a true sentence; a stale report parsed fine and `computeFitness` includes its
 * number. A caller that prints one sentence for both says something false about one
 * of them, so the distinction is carried in the data rather than left to each
 * surface to rediscover from the kind.
 */
export function describeUnmeasured(metrics) {
    const failures = metrics.measurementFailures ?? [];
    if (failures.length === 0)
        return undefined;
    return failures.map((failure) => ({
        dimension: failure.dimension,
        kind: failure.kind,
        why: failure.message,
        numberReported: failure.kind === 'stale-report',
    }));
}
/**
 * Async version of extractAllMetrics that loads custom dimensions from config.
 *
 * Every path that produces a GATE VERDICT has to use this rather than
 * `extractAllMetrics`, and until now none did. `extractAllMetricsAsync` was
 * exported and never called: the CLI and the MCP server both went through the
 * synchronous version with no `customDimensions`, so no custom extractor ever
 * ran, `metrics.custom` was always absent, and `evaluateCeilings` skipped every
 * configured `custom.*` ceiling in silence. The dimensions were not merely
 * unmeasured -- the rules written against them were never enforced at all.
 *
 * `submittedAnalysis` is REQUIRED here and optional on `extractAllMetrics` for that
 * same history: this is the verdict path, and the divergence above is what an optional
 * field at a module boundary produced last time. A caller that publishes nothing has to
 * write `{ kind: 'not-scanned' }` and be visible doing it.
 */
export async function extractAllMetricsAsync(options) {
    return (await extractAllMetricsAsyncAndCoverageProvenance(options)).metrics;
}
/**
 * The same extraction, with the coverage provenance verdicts kept.
 *
 * For the two surfaces that produce a VERDICT and can therefore write a cache entry:
 * `runQualityGate` in cli.ts and `handleRun` in mcp/tools.ts. `score` and `suggest`
 * take the Metrics-only variant on purpose -- they neither produce a verdict nor cache
 * one, and the unverifiable branch is entirely about those two things. The STALE half
 * still reaches them, through `metrics.measurementFailures`.
 */
export async function extractAllMetricsAsyncAndCoverageProvenance(options) {
    const config = getConfig();
    // Load and register custom dimensions if not already provided
    let customDimensions = options.customDimensions;
    if (!customDimensions && !options.skipCustomDimensions) {
        // projectRoot, not the default of process.cwd(): the config belongs to the
        // project being measured, and the CLI can be invoked from anywhere above or
        // below it. Searching cwd finds a different project's config, or none.
        customDimensions = await registerCustomDimensions(config.projectRoot);
    }
    return extractAllMetricsAndCoverageProvenance({
        ...options,
        customDimensions,
    });
}
//# sourceMappingURL=metrics.js.map