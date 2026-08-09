/**
 * Coverage Report Provenance
 * ==========================
 * WHICH state of the code a coverage report on disk describes, established from a
 * sidecar the tool writes beside the report -- not inferred from timestamps.
 *
 * THE HOLE THIS CLOSES. `extractAllMetrics` runs `requiredScripts` and then reads
 * `coverage-summary.json`, so a project whose gate DOES run its coverage script is
 * graded on a report that run produced. A project that generates coverage outside
 * the gate -- a CI job that uploads an artifact, a developer who ran vitest an hour
 * ago -- was graded on whatever file was on disk, with nothing tying it to the
 * commit being graded. A planted 10% report satisfied a floor of 5 and the run was
 * cached as a pass.
 *
 * TWO EARLIER DESIGNS FOR THIS WERE BUILT AND REMOVED. Both are recorded because
 * this module has to be readable as the thing that does not repeat them.
 *
 *   (A) "did this run rewrite the report", armed on `scriptsToRun`. INERT on the
 *       default path: `COVERAGE_ONLY_DEFAULTS` and `FULL_DEFAULTS` both ship
 *       `requiredScripts: []` and cli.ts's `rules.rules.requiredScripts || ['quality']`
 *       does not rescue it, because `[]` is truthy. It also blamed the report for a
 *       phantom substituted script, and fired on `coverage.lambda`, which nothing
 *       grades.
 *   (B) report mtime vs the newest source file under `codePathspecs`. Inert for any
 *       project without a literal top-level `src/`, and false-failing in the other
 *       direction on mtime-preserving archive restores (`actions/cache`), branch
 *       switches that rewrite identical content, clock skew, and any bulk tree write
 *       longer than its tolerance -- a constant sized from file COUNT when the real
 *       quantity is wall time (measured: 130k files on SSD spread 3550 ms).
 *
 * WHAT THIS DOES INSTEAD. One recorded identity per suite, compared inside one
 * repository, with no timestamp arithmetic and no tolerance constant anywhere:
 *
 *   stamp:  { codeCommit: <HEAD>, codeStateDigest: <digest of the code vs HEAD>,
 *             summarySha256: <the report's bytes> }
 *   verify: recompute the digest AGAINST THE RECORDED COMMIT and compare exactly.
 *
 * Recomputing against the recorded commit -- rather than comparing two cache-key
 * strings -- is what makes the STALE half reachable at all. MEASURED against
 * dist/cache.js on a project whose `coverage/` is not gitignored, so the report is
 * untracked and the tree is already `?? coverage/`:
 *
 *   before stamp     wip:fe9d8fb...:18217e4f...
 *   after stamp      wip:fe9d8fb...:18217e4f...
 *   after one edit   wip:fe9d8fb...:5b0c1b69...   <- differs, but both are `wip:`
 *
 * Two unequal `wip:` keys cannot tell "the code moved" from "a past working tree
 * that can no longer be recomputed", so key inequality alone would have to report
 * that report -- which the tool has direct evidence describes different code -- as
 * merely unverifiable, and the gate would pass. Recomputing the digest against
 * `fe9d8fb` answers it exactly, in every clean/dirty combination.
 *
 * The same recomputation is what keeps the FALSE-FAIL direction closed, which is
 * where design B died. MEASURED, stamping at a clean commit and then:
 *
 *   edit README.md               key moves; digest vs the stamped commit UNCHANGED -> verified
 *   commit that README edit      key moves; digest UNCHANGED                       -> verified
 *   change src/a.ts, commit,
 *     revert, commit             key moves; content back to identical              -> verified
 *   switch to an identical branch key moves; digest UNCHANGED                      -> verified
 *   add untracked src/new.ts     digest MOVES                                      -> stale
 *   chmod +x src/index.ts        digest moves, but `git diff --raw` reports
 *                               `:100644 100755 cb0ff5c cb0ff5c M` -- identical
 *                               blob shas, so no content changed                   -> not stale
 *
 * THREE VERDICTS, and the asymmetry between them is the design:
 *
 *   verified      silent.
 *   stale         a `stale-report` MeasurementFailure on the SUITE dimension, so
 *                 `isMeasurementUnderRule` fails every rule that grades it. A
 *                 definite claim, made only about a report recognised byte-for-byte
 *                 and only when a tracked file's CONTENT or an untracked source file
 *                 demonstrably differs.
 *   unverifiable  no evidence either way -- no sidecar, an unusable one, a report
 *                 rewritten since the stamp. What this COSTS is a policy decision, and
 *                 it is the one thing in this module that is configurable:
 *
 *                   provenanceRequired (DEFAULT)  a `provenance-unverified`
 *                     MeasurementFailure. The gate goes red on any rule that grades
 *                     the suite.
 *                   QUALITY_COVERAGE_PROVENANCE=optional  an advisory plus an
 *                     `unverified-provenance` entry in `EvaluationResult.unevaluated`,
 *                     which forces `monotonicEvaluated: false` -- baseline-only
 *                     caching. Gate green.
 *
 *                 The default REVERSED in this version, and it is a breaking contract
 *                 change made on purpose. "Nobody stamped this" is not evidence the
 *                 numbers are wrong, which is why it shipped green the first time; it
 *                 is also not evidence they are right, and the number in question is
 *                 the one deciding whether the build ships. See
 *                 `config.coverage.provenanceRequired`.
 *
 *                 TWO EXCEPTIONS keep strict mode from false-failing where no remedy
 *                 exists or where the evidence cannot bear the claim. Both are decided
 *                 in ONE place -- `provenanceFailureIsWarranted` -- and are documented
 *                 there rather than restated here.
 *
 * WHERE THIS IS NOT CALLED, deliberately. `runScore` and `runSuggest` (and the MCP
 * score/suggest handlers) never see the unverifiable ADVISORY, because they produce no
 * verdict and write no cache entry and the advisory is entirely about those two
 * things. They do see both FAILURES, through `metrics.measurementFailures` and
 * `describeUnmeasured`, which partitions them as `numberReported` so those surfaces
 * report the number and say in the same breath that nothing ties it to this code. In
 * `optional` mode there is no failure to carry, so they print the number unqualified
 * -- accepted, because that mode is an explicit opt-out of the check and the run path
 * still prints the advisory. On a cache HIT nothing here runs either: the sidecar is
 * not read, which is the same shape as #41 and is stated in the cached-pass comment in
 * cli.ts rather than left to be inferred.
 *
 * LIMITS, each one reproduced rather than supposed:
 *
 *   - Provenance is exactly as sharp as `QUALITY_CODE_PATHSPECS`. A project whose
 *     real sources are outside it (a Next.js `app/` beside a token `src/`, a
 *     monorepo graded from the root) gets a constant digest and therefore a sidecar
 *     that vouches for every state of the tree. #40; the cache key has the same
 *     blind spot for the same reason.
 *   - A source file GIT IGNORES is invisible to both halves. MEASURED with
 *     `src/generated/` gitignored: regenerating `src/generated/api.ts` with
 *     different content leaves `git diff --name-only <C> -- src/` empty AND
 *     `git ls-files --others --exclude-standard` empty, while tsc, eslint and the
 *     coverage tool all read the new bytes. Needs no unusual layout at all.
 *   - The MEASUREMENT CONFIGURATION is out of scope. Narrow vitest's
 *     `coverage.include` and leave the report in place and this still says verified,
 *     because the report really is the one stamped for this code. Folding
 *     `measurementInputsHash` in would have caught it and would have turned every
 *     edit to rules.json into an advisory, which is the wrong trade.
 *   - `stamp-coverage` ASSERTS; it cannot verify. Run after a cache restore it
 *     vouches for a report this code never produced.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { codeStateDigest, digestOfUnchangedCodeState, getCurrentCommitHash, listUntrackedCodeFiles, } from './cache.js';
import { getConfig } from './config.js';
import { rulesReadingMeasurement } from './rules.js';
import { buildReportEvidence } from './providers/result.js';
/** Same buffer ceiling the cache uses; git output scales with the repository. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Beside the summary it describes. Dot-prefixed so it sorts out of the way. */
export const PROVENANCE_SIDECAR_FILE = '.quality-gate-provenance.json';
/**
 * Bumped when the recorded FIELDS change meaning. A sidecar from another version is
 * refused rather than read optimistically, for the same reason the cache refuses a
 * mismatched `schemaVersion`: a misread stamp is a report vouched for by accident.
 */
const PROVENANCE_SIDECAR_SCHEMA = 1;
/**
 * The two lines written into `<coverageDir>/.gitignore` when the sidecar would
 * otherwise be visible to git.
 *
 * Self-ignoring: the first line hides the .gitignore itself. Without that, writing
 * this file to fix one untracked path introduces another. MEASURED on a project
 * whose `coverage/` is tracked and not ignored, clean tree:
 *
 *   baseline                 key 209fcf90...        porcelain ''
 *   + sidecar                key wip:209fcf90...    porcelain '?? coverage/.quality-gate-provenance.json'
 *   + this .gitignore        key 209fcf90...        porcelain ''
 *   + edit the tracked report key wip:209fcf90...   porcelain ' M coverage/coverage-summary.json'
 *
 * So the tree goes back to clean and the adopter's own tracked files stay fully
 * visible. The middle row is the hard constraint being protected: a clean tree keys
 * on the bare commit hash, and `findBaselineEntry` resolves baselines BY commit
 * hash, so a permanently-WIP key would cost every monotonic rule its baseline.
 */
const SIDECAR_GITIGNORE_LINES = [`.gitignore`, PROVENANCE_SIDECAR_FILE];
/** How many changed paths a stale message names before it summarises the rest. */
const CHANGED_FILES_SHOWN = 3;
/**
 * Where each configured suite's summary and sidecar live.
 *
 * Mirrors `suitesOf` + the join in providers/coverage.ts rather than importing
 * them, and that is D7 rather than duplication for its own sake: the provider must
 * not vouch for its own freshness, so the judgement lives outside it. The one thing
 * that must not drift is the PATH, which is why both are built from
 * `getConfig().coverage` and nothing else.
 *
 * `collision` exists because `QUALITY_COVERAGE_LAMBDA_DIR=coverage` is legal --
 * config.ts does no distinctness check and always populates `lambdaDir` -- and one
 * sidecar cannot describe two suites. Reported as its own reason so it reads as the
 * configuration collision it is rather than as a corrupt file.
 */
function suiteLocations() {
    const config = getConfig();
    const at = (suite, dir) => ({
        suite,
        dir,
        summaryPath: path.join(config.projectRoot, dir, config.coverage.summaryFile),
        sidecarPath: path.join(config.projectRoot, dir, PROVENANCE_SIDECAR_FILE),
    });
    const locations = [at('coverage.unit', config.coverage.unitDir)];
    if (config.coverage.lambdaDir !== undefined) {
        locations.push(at('coverage.lambda', config.coverage.lambdaDir));
    }
    const distinct = new Set(locations.map((location) => location.sidecarPath));
    return { locations, collision: distinct.size !== locations.length };
}
// =============================================================================
// Reading, hashing, parsing
// =============================================================================
/**
 * Total by construction -- `null` on any throw, never an exception.
 *
 * Defensive because the summary is an artifact another process may be rewriting
 * while this runs, and because a provenance check that can crash the gate is worse
 * than no provenance check. It also keeps the mocked-`fs` unit suites honest: they
 * stub `readFileSync` to a bare `vi.fn()`, so an undefined return has to be a
 * `null` here rather than a TypeError inside a measurement.
 */
function sha256OfFile(absolutePath) {
    try {
        const bytes = fs.readFileSync(absolutePath);
        if (bytes === undefined || bytes === null)
            return null;
        return crypto.createHash('sha256').update(bytes).digest('hex');
    }
    catch {
        return null;
    }
}
/** mtimeMs, or null. Total for the same reasons as `sha256OfFile`. */
function modifiedMsOf(absolutePath) {
    try {
        const stat = fs.statSync(absolutePath);
        return typeof stat?.mtimeMs === 'number' ? stat.mtimeMs : null;
    }
    catch {
        return null;
    }
}
/**
 * Parse a sidecar, or say why it is not one.
 *
 * PARSE AT THE BOUNDARY, and strictly, because this is a file the tool did not
 * necessarily write and `codeCommit` is interpolated into a git command below.
 * Anything but a 40-hex commit and a 64-hex digest is refused before a shell sees
 * it: `'$(touch /tmp/x)'` and `'abc; touch /tmp/x'` are `unusable`, not arguments.
 *
 * A partially-written file (an interrupted stamp) lands here as invalid JSON and is
 * therefore `unusable` -- which is the safe direction, since `unusable` vouches for
 * nothing.
 */
function readSidecar(absolutePath) {
    let raw;
    try {
        raw = fs.readFileSync(absolutePath, 'utf-8');
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return { kind: 'absent' };
        return { kind: 'unusable', why: `it could not be read (${code ?? 'unknown error'})` };
    }
    if (typeof raw !== 'string' || raw.length === 0) {
        return { kind: 'unusable', why: 'it is empty' };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { kind: 'unusable', why: 'it does not contain valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'unusable', why: 'it is not a JSON object' };
    }
    const fields = parsed;
    if (fields.schema !== PROVENANCE_SIDECAR_SCHEMA) {
        return {
            kind: 'unusable',
            why: `it declares schema ${JSON.stringify(fields.schema)}, and this build reads ${PROVENANCE_SIDECAR_SCHEMA}`,
        };
    }
    if (fields.suite !== 'coverage.unit' && fields.suite !== 'coverage.lambda') {
        return { kind: 'unusable', why: `it names no known suite (${JSON.stringify(fields.suite)})` };
    }
    if (typeof fields.summaryFile !== 'string' || fields.summaryFile.length === 0) {
        return { kind: 'unusable', why: 'it names no summary file' };
    }
    if (typeof fields.codeCommit !== 'string' || !/^[0-9a-f]{40}$/.test(fields.codeCommit)) {
        return {
            kind: 'unusable',
            why: 'its codeCommit is not a 40-character commit hash, so it is not a state of the code this tool can ask git about',
        };
    }
    if (typeof fields.codeStateDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(fields.codeStateDigest)) {
        return { kind: 'unusable', why: 'its codeStateDigest is not a sha256 digest' };
    }
    if (typeof fields.summarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(fields.summarySha256)) {
        return { kind: 'unusable', why: 'its summarySha256 is not a sha256 digest' };
    }
    if (fields.stampedBy !== 'run' && fields.stampedBy !== 'stamp-coverage') {
        return { kind: 'unusable', why: `it records no known stamping route (${JSON.stringify(fields.stampedBy)})` };
    }
    return {
        kind: 'valid',
        sidecar: {
            schema: PROVENANCE_SIDECAR_SCHEMA,
            suite: fields.suite,
            summaryFile: fields.summaryFile,
            codeCommit: fields.codeCommit,
            codeStateDigest: fields.codeStateDigest,
            summarySha256: fields.summarySha256,
            stampedAt: typeof fields.stampedAt === 'string' ? fields.stampedAt : 'unknown',
            stampedBy: fields.stampedBy,
        },
    };
}
/**
 * HEAD plus the digest of the code against it.
 *
 * NEVER THROWS, which is the caveat D2 attaches to reusing the cache's identity:
 * `getCurrentCommitHash` throws when git cannot be asked and the digest refuses a
 * layout that tracks no code. Both are ordinary states for this module -- "cannot
 * stamp" and "cannot verify" -- and turning either into a new crash path would make
 * a provenance check able to break a measurement that used to work.
 */
function resolveCodeIdentity() {
    let commit;
    try {
        commit = getCurrentCommitHash();
    }
    catch (error) {
        return { ok: false, why: error instanceof Error ? error.message : String(error) };
    }
    const digest = codeStateDigest(commit);
    if (digest.kind !== 'digest') {
        return { ok: false, why: digest.message };
    }
    return { ok: true, commit, digest: digest.digest };
}
/**
 * Tracked paths whose CONTENT differs from a commit, mode-only rows dropped.
 *
 * `--raw` rather than `--name-only`, and the difference is a false failure this
 * would otherwise produce. MEASURED after `chmod +x src/index.ts && git commit`:
 *
 *   git diff --name-only <C> -- src/  ->  src/index.ts
 *   git diff --raw       <C> -- src/  ->  :100644 100755 cb0ff5c cb0ff5c M  src/index.ts
 *
 * Identical blob shas: nothing about the code changed, only a permission bit, and
 * `scripts/` is in the DEFAULT pathspecs so committing a permissions fix from a
 * Windows or WSL checkout would otherwise fail a coverage rule while naming a file
 * that did not change. That is verbatim the message design B was rejected for.
 */
function contentChangedPaths(againstCommit) {
    const config = getConfig();
    let raw;
    // `againstCommit` reaches a shell here. Every caller passes a value `readSidecar`
    // has already matched against /^[0-9a-f]{40}$/, and `codeStateDigest` re-checks the
    // same shape for itself -- neither relies on the other having done it.
    if (!/^[0-9a-f]{40}$/.test(againstCommit)) {
        return { ok: false, why: `${againstCommit} is not a commit hash` };
    }
    try {
        raw = execSync(`git diff --raw ${againstCommit} -- ${config.codePathspecs.join(' ')}`, {
            cwd: config.projectRoot,
            encoding: 'utf-8',
            maxBuffer: GIT_MAX_BUFFER,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (error) {
        return { ok: false, why: error instanceof Error ? error.message : String(error) };
    }
    const paths = raw
        .split('\n')
        .filter((line) => line.startsWith(':'))
        .flatMap((line) => {
        // `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>`
        const [meta = '', ...rest] = line.split('\t');
        const fields = meta.slice(1).split(' ');
        const [, , srcSha = '', dstSha = ''] = fields;
        if (srcSha.length > 0 && srcSha === dstSha)
            return [];
        return rest.length > 0 ? [rest.join('\t')] : [];
    })
        .sort();
    return { ok: true, paths: [...new Set(paths)] };
}
/** Every configured suite's summary as it stands now, plus the code state. */
export function snapshotCoverageStateBeforeScripts() {
    const summaries = suiteLocations().locations.map((location) => {
        const sha256 = sha256OfFile(location.summaryPath);
        return {
            suite: location.suite,
            summaryPath: location.summaryPath,
            present: sha256 !== null,
            modifiedMs: modifiedMsOf(location.summaryPath),
            sha256,
        };
    });
    return { summaries, identityBefore: resolveCodeIdentity() };
}
/**
 * Keep the sidecar out of `git status`, without touching a file the project owns.
 *
 * Asked of GIT rather than guessed: `git check-ignore -q <path>` exits 0 when the
 * path is already ignored and 1 when it is not (measured on git 2.51), so the
 * overwhelmingly common case -- `coverage/` already in .gitignore -- writes nothing
 * into the adopter's tree at all.
 *
 * NEVER appends to an existing `<dir>/.gitignore`. Editing a file the project wrote
 * is not this tool's business, and the cost of not doing it is bounded and reported:
 * the sidecar stays visible, every run keys as WIP, and the advisory names the
 * one-line remedy.
 *
 * The directory has to be a strict subdirectory of the project root, because
 * `QUALITY_COVERAGE_UNIT_DIR=.` is legal and would otherwise clobber the project's
 * own root .gitignore.
 */
function ensureSidecarHiddenFromGit(dir) {
    const config = getConfig();
    const absoluteDir = path.resolve(config.projectRoot, dir);
    const relative = path.relative(config.projectRoot, absoluteDir);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        return false;
    }
    const sidecarRelative = path.posix.join(relative.split(path.sep).join('/'), PROVENANCE_SIDECAR_FILE);
    try {
        execSync(`git check-ignore -q -- ${JSON.stringify(sidecarRelative)}`, {
            cwd: config.projectRoot,
            stdio: 'ignore',
        });
        return true;
    }
    catch {
        // Exit 1 (not ignored) and exit 128 (not a repository) both land here. Writing
        // the file is harmless in the second case and is the whole point in the first.
    }
    const gitignorePath = path.join(absoluteDir, '.gitignore');
    try {
        if (fs.existsSync(gitignorePath))
            return false;
        fs.writeFileSync(gitignorePath, SIDECAR_GITIGNORE_LINES.join('\n') + '\n');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Write one sidecar, or say why not.
 *
 * The report is HASHED before anything is written, so a summary that cannot be read
 * is never vouched for. An existing sidecar beside an unreadable-or-rewritten report
 * is DELETED: whatever it described is not what is on disk, and leaving it would let
 * a superseded stamp vouch for a file it never saw.
 */
function writeSidecar(location, identity, stampedBy) {
    const summarySha256 = sha256OfFile(location.summaryPath);
    if (summarySha256 === null) {
        discardSidecar(location.sidecarPath);
        return {
            kind: 'no-report',
            suite: location.suite,
            summaryPath: location.summaryPath,
        };
    }
    const hiddenFromGit = ensureSidecarHiddenFromGit(location.dir);
    const sidecar = {
        schema: PROVENANCE_SIDECAR_SCHEMA,
        suite: location.suite,
        summaryFile: path.basename(location.summaryPath),
        codeCommit: identity.commit,
        codeStateDigest: identity.digest,
        summarySha256,
        stampedAt: new Date().toISOString(),
        stampedBy,
    };
    try {
        fs.writeFileSync(location.sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');
    }
    catch (error) {
        // A read-only coverage directory -- a mounted CI artifact, a container volume --
        // must not crash the gate. It costs the suite its verdict, not the run.
        const code = error.code;
        return {
            kind: 'cannot-stamp',
            suite: location.suite,
            summaryPath: location.summaryPath,
            why: `the sidecar could not be written to ${location.sidecarPath} (${code ?? 'unknown error'})`,
            reason: 'code-state-unknown',
        };
    }
    return {
        kind: 'stamped',
        suite: location.suite,
        summaryPath: location.summaryPath,
        sidecarPath: location.sidecarPath,
        codeCommit: identity.commit,
        summarySha256,
        hiddenFromGit,
    };
}
function discardSidecar(sidecarPath) {
    try {
        fs.unlinkSync(sidecarPath);
    }
    catch {
        // Absent is the desired state, and an unremovable one reads as `unusable` or as
        // `report-rewritten-since-stamp` on the next verify -- both of which vouch for
        // nothing.
    }
}
/**
 * Stamp every suite whose summary this run WROTE.
 *
 * Arming condition, both signals OR'd (D3): the summary is present now AND (it was
 * absent before, OR its mtime moved, OR its bytes differ). mtime is permitted here
 * and only here, for the one question it answers honestly -- did THIS file get
 * written during THIS process, on ONE clock. It is never compared against another
 * file, never against another machine, and carries no tolerance.
 *
 * Content alone is insufficient: a comment-only source edit regenerates a
 * byte-identical `coverage-summary.json`, which would leave a correctly-regenerated
 * report looking unstamped. mtime catches that rewrite -- measured granularity here
 * is 0.046 ms and an identical-content rewrite always moves it.
 *
 * A suite the run did NOT rewrite is left completely alone, including any sidecar
 * beside it: this run neither vouches for somebody else's stamp nor destroys it.
 */
export function stampCoverageSummariesRewrittenDuringRun(snapshot, stampedBy = 'run') {
    const { locations } = suiteLocations();
    const before = new Map(snapshot.summaries.map((state) => [state.suite, state]));
    // Resolved LAZILY, and at most once. The overwhelmingly common shape is a run whose
    // scripts rewrote nothing (a project with no coverage script in `requiredScripts`, or
    // a suite it does not have), and that run should pay no git calls for a stamp it is
    // not going to write.
    let resolved;
    const identityAfter = () => (resolved ??= resolveCodeIdentity());
    return locations.flatMap((location) => {
        const previous = before.get(location.suite);
        const nowSha = sha256OfFile(location.summaryPath);
        if (nowSha === null) {
            return [{ kind: 'no-report', suite: location.suite, summaryPath: location.summaryPath }];
        }
        const rewritten = previous === undefined ||
            !previous.present ||
            previous.sha256 !== nowSha ||
            previous.modifiedMs !== modifiedMsOf(location.summaryPath);
        if (!rewritten) {
            return [
                { kind: 'not-rewritten', suite: location.suite, summaryPath: location.summaryPath },
            ];
        }
        const after = identityAfter();
        if (!after.ok) {
            discardSidecar(location.sidecarPath);
            return [
                {
                    kind: 'cannot-stamp',
                    suite: location.suite,
                    summaryPath: location.summaryPath,
                    why: `this run rewrote the report but could not establish which state of the code it describes: ${after.why}`,
                    reason: 'code-state-unknown',
                },
            ];
        }
        if (!snapshot.identityBefore.ok) {
            discardSidecar(location.sidecarPath);
            return [
                {
                    kind: 'cannot-stamp',
                    suite: location.suite,
                    summaryPath: location.summaryPath,
                    why: `the code state before the scripts ran could not be established: ${snapshot.identityBefore.why}`,
                    reason: 'code-state-unknown',
                },
            ];
        }
        if (snapshot.identityBefore.commit !== after.commit ||
            snapshot.identityBefore.digest !== after.digest) {
            discardSidecar(location.sidecarPath);
            return [
                {
                    kind: 'cannot-stamp',
                    suite: location.suite,
                    summaryPath: location.summaryPath,
                    why: 'the code under QUALITY_CODE_PATHSPECS changed while this run was measuring -- a ' +
                        'script or custom extractor rewrote it (codegen into src/ during `build` is the ' +
                        'usual cause), so the report describes one generation of the code and the tree now ' +
                        'holds another. Nothing can be vouched for. Run the coverage script in a step that ' +
                        'does not also regenerate sources.',
                    reason: 'code-changed-during-measurement',
                },
            ];
        }
        return [writeSidecar(location, after, stampedBy)];
    });
}
/**
 * Stamp every readable summary unconditionally. The `stamp-coverage` entrypoint.
 *
 * ASSERTS rather than verifies, and there is no way for it to do otherwise: the
 * adopter is telling the tool that the report beside this code was produced from
 * this code. Run in the wrong CI step -- after `actions/cache` restores a
 * `coverage/` directory, or in a catch-all "stamp everything" job -- it vouches for
 * a report this code never produced. What the command can do is print exactly what
 * it asserted, so a CI log carries the claim.
 */
export function stampAllCoverageSummaries(stampedBy = 'stamp-coverage') {
    const { locations } = suiteLocations();
    const identity = resolveCodeIdentity();
    return locations.map((location) => {
        if (sha256OfFile(location.summaryPath) === null) {
            return { kind: 'no-report', suite: location.suite, summaryPath: location.summaryPath };
        }
        if (!identity.ok) {
            return {
                kind: 'cannot-stamp',
                suite: location.suite,
                summaryPath: location.summaryPath,
                why: identity.why,
                reason: 'code-state-unknown',
            };
        }
        return writeSidecar(location, identity, stampedBy);
    });
}
// =============================================================================
// Verification
// =============================================================================
/**
 * The suites that produced a NUMBER this run.
 *
 * The double-reporting guard. A suite that produced a number is exactly a suite
 * whose summary was read AND had a usable `total` -- `extractFromTotal` returns
 * `metrics: undefined` for every failure it reports -- so asking about anything
 * else would put a provenance verdict beside an existing `report-missing` or
 * `unparseable-output` failure for the same suite and report one broken report
 * twice. Same reasoning as the `explained` set in `evaluateCeilings`.
 */
export function suitesWithNumbers(coverage) {
    const suites = [];
    if (coverage?.unit !== undefined)
        suites.push('coverage.unit');
    if (coverage?.lambda !== undefined)
        suites.push('coverage.lambda');
    return suites;
}
/**
 * Which state of the code each report describes.
 *
 * ORDER IS THE POLICY. The definite claim -- STALE -- is made last, and only about a
 * report recognised byte-for-byte as the one that was stamped. Everything the tool
 * cannot establish routes to `unverifiable` first: no sidecar (which costs ZERO git
 * calls, and is the default population), an unusable one, an unreadable summary, or
 * a summary whose bytes are not the ones vouched for.
 */
export function verifyCoverageProvenance(suites) {
    const { locations, collision } = suiteLocations();
    return suites.flatMap((suite) => {
        const location = locations.find((candidate) => candidate.suite === suite);
        if (location === undefined)
            return [];
        if (collision) {
            return [
                {
                    kind: 'unverifiable',
                    suite,
                    summaryPath: location.summaryPath,
                    sidecarPath: location.sidecarPath,
                    why: 'suite-directories-collide',
                    detail: 'both coverage suites are configured at the same directory, so one sidecar cannot ' +
                        'describe both. Point QUALITY_COVERAGE_LAMBDA_DIR at a different directory (or at ' +
                        'one that does not exist, if this project has no second suite).',
                },
            ];
        }
        return [verifyOneSuite(location)];
    });
}
function verifyOneSuite(location) {
    const unverifiable = (why, detail) => ({
        kind: 'unverifiable',
        suite: location.suite,
        summaryPath: location.summaryPath,
        sidecarPath: location.sidecarPath,
        why,
        detail,
    });
    const read = readSidecar(location.sidecarPath);
    if (read.kind === 'absent') {
        return unverifiable('no-sidecar', `no ${PROVENANCE_SIDECAR_FILE} beside ${location.summaryPath}, so nothing records which state of the code this report describes.`);
    }
    if (read.kind === 'unusable') {
        return unverifiable('sidecar-unusable', `${location.sidecarPath} cannot be trusted: ${read.why}.`);
    }
    const sidecar = read.sidecar;
    if (sidecar.suite !== location.suite) {
        return unverifiable('sidecar-unusable', `${location.sidecarPath} was stamped for ${sidecar.suite}, not for ${location.suite}.`);
    }
    if (sidecar.summaryFile !== path.basename(location.summaryPath)) {
        return unverifiable('sidecar-unusable', `${location.sidecarPath} vouches for ${sidecar.summaryFile}, and this suite reads ${path.basename(location.summaryPath)}.`);
    }
    const summarySha256 = sha256OfFile(location.summaryPath);
    if (summarySha256 === null) {
        return unverifiable('summary-unreadable', `${location.summaryPath} could not be read to compare against the stamp.`);
    }
    if (summarySha256 !== sidecar.summarySha256) {
        return unverifiable('report-rewritten-since-stamp', `${location.summaryPath} is not the file that was stamped -- its bytes have changed since, so the recorded code state describes some other report.`);
    }
    const digestNow = codeStateDigest(sidecar.codeCommit);
    if (digestNow.kind === 'no-tracked-code') {
        return unverifiable('no-code-identity', digestNow.message);
    }
    if (digestNow.kind === 'git-failed') {
        return unverifiable('recorded-commit-unknown', `git could not compare the tree against the stamped commit ${sidecar.codeCommit.slice(0, 7)} ` +
            `(a shallow clone, or a commit that was rebased or force-pushed away): ${digestNow.message.trim()}`);
    }
    if (digestNow.digest === sidecar.codeStateDigest) {
        return {
            kind: 'verified',
            suite: location.suite,
            summaryPath: location.summaryPath,
            sidecarPath: location.sidecarPath,
            codeCommit: sidecar.codeCommit,
        };
    }
    // The digest moved. WHAT moved decides whether this is a definite claim: a mode
    // bit is not a generation of the code, and saying it is was design B's defect.
    const changedPaths = contentChangedPaths(sidecar.codeCommit);
    if (!changedPaths.ok) {
        return unverifiable('recorded-commit-unknown', `the code no longer matches the stamp, and git could not say which files differ from ${sidecar.codeCommit.slice(0, 7)}: ${changedPaths.why.trim()}`);
    }
    let untracked = [];
    try {
        untracked = listUntrackedCodeFiles();
    }
    catch {
        untracked = [];
    }
    if (changedPaths.paths.length === 0 && untracked.length === 0) {
        // Nothing's CONTENT differs from the stamped commit, yet the digest moved. Two
        // ways to get here, and only one of them is safe to call verified:
        //
        //   - the stamp was taken over a tree whose code matched its commit exactly, so
        //     "no content differs from the commit" means "no content differs from the
        //     stamped state" -- the remaining difference is a file mode. Verified.
        //   - the stamp was taken over UNCOMMITTED code that has since been reverted.
        //     The code really did change since the stamp and no content difference is
        //     visible now, so neither claim can be made. Unverifiable.
        if (sidecar.codeStateDigest === digestOfUnchangedCodeState()) {
            return {
                kind: 'verified',
                suite: location.suite,
                summaryPath: location.summaryPath,
                sidecarPath: location.sidecarPath,
                codeCommit: sidecar.codeCommit,
            };
        }
        return unverifiable('stamp-state-not-reproducible', 'this report was stamped against uncommitted code, and the tree no longer reproduces that ' +
            `state while no tracked file's content differs from ${sidecar.codeCommit.slice(0, 7)} -- the ` +
            'uncommitted changes were reverted, or a file mode changed. Which generation of the code ' +
            'the report describes cannot be established.');
    }
    const shown = [...changedPaths.paths, ...untracked.map((file) => `${file} (untracked)`)];
    return {
        kind: 'stale',
        suite: location.suite,
        summaryPath: location.summaryPath,
        sidecarPath: location.sidecarPath,
        codeCommit: sidecar.codeCommit,
        changed: {
            modified: changedPaths.paths,
            untracked,
            more: Math.max(0, shown.length - CHANGED_FILES_SHOWN),
        },
        stampedWithUncommittedCode: sidecar.codeStateDigest !== digestOfUnchangedCodeState(),
    };
}
// =============================================================================
// What the verdicts mean to the gate
// =============================================================================
function describeChanged(changed) {
    const shown = [
        ...changed.modified,
        ...changed.untracked.map((file) => `${file} (untracked)`),
    ].slice(0, CHANGED_FILES_SHOWN);
    const suffix = changed.more > 0 ? ` and ${changed.more} more` : '';
    return `${shown.join(', ')}${suffix}`;
}
/**
 * A report that cannot be tied to the code being graded is a failed MEASUREMENT.
 *
 * Emitted unconditionally, not scoped to the rules, because that is this codebase's
 * architecture: the fact is reported and `evaluateMeasurements` decides which facts
 * become failed RULES. So a stale `coverage.lambda` on a project that grades no
 * coverage is an ungated advisory rather than a red gate -- and the run is still not
 * cached, exactly as it already is for an unparseable lambda report.
 *
 * TWO FINDINGS FAIL, and the epistemic difference between them is the whole design:
 *
 *   - `stale`: positive evidence the report describes other code. Always fails.
 *   - `unverifiable`: no evidence either way. Fails only when the adopter has asked for
 *     provenance to be required, which is the default, AND the two exceptions below do
 *     not apply. See `config.coverage.provenanceRequired`.
 *
 * TWO EXCEPTIONS, and both exist because a red build naming a remedy that cannot work
 * is the false-fail that killed designs A and B. `provenanceFailureIsWarranted` is the
 * single place they are decided, and it is shared with `coverageProvenanceUnevaluated`
 * rather than duplicated: two copies of this predicate is precisely how a suite came to
 * be reported as a hard failure AND listed under "Not failing the gate on these".
 *
 * (1) THE TOOL CANNOT STAMP AT ALL. Provenance is built out of git -- a commit and a
 *     digest against it. Where `resolveCodeIdentity` cannot answer, no sidecar can be
 *     written by ANYONE, so neither `requiredScripts` nor `stamp-coverage` would help.
 *     Note that the CLI does not reach this: `assertSupportedLayout` shells `git
 *     ls-files` and exits 1 first, which is a loud, early, honest refusal and is the
 *     documented contract ("git: the run refuses rather than guessing the tree state").
 *     This exception is therefore for the LIBRARY and MCP paths, which call
 *     `extractAllMetrics*` directly with no layout assertion -- the shape every harness
 *     case uses.
 *
 * (2) THE CODE CHANGED WHILE THE SCRIPTS RAN. The stamp detects that the code identity
 *     before `requiredScripts` and after them disagree, and refuses. That detection
 *     CANNOT distinguish the unsafe ordering from the safe one, because one snapshot is
 *     taken before ALL scripts and one after ALL of them:
 *
 *       ['test:coverage', 'build']   coverage measured, THEN build rewrote src/.
 *                                    The report describes code the tree no longer
 *                                    holds. Genuinely bad.
 *       ['build', 'test:coverage']   build generated src/, THEN coverage measured the
 *                                    final tree. The report describes the tree exactly.
 *                                    Perfectly correct, and a common shape.
 *
 *     Both produce identical evidence. An earlier revision of this function promoted it
 *     to a `code-changed-during-measurement` failure that fired in both provenance
 *     modes -- which hard-failed the SECOND row, on a project that had already ordered
 *     its scripts correctly, while telling it to "run the coverage script in a step that
 *     does not also regenerate sources". It already was. That promotion is reverted; the
 *     specific diagnostic survives on the advisory, which is where an inference the tool
 *     cannot actually make belongs.
 *
 *     Making this sharp needs a code identity captured BETWEEN scripts so that "the code
 *     last changed at step j, the report was last rewritten at step k" is answerable
 *     without a timestamp. That is real work in `runScripts` and is filed rather than
 *     guessed at here.
 *
 * `canStampAtAll` is resolved LAZILY and at most once: it costs git calls, and it is
 * only consulted on the path that is otherwise about to fail the build.
 */
/**
 * Whether an `unverifiable` suite should FAIL, or only be advised about.
 *
 * ONE definition, consumed by both `coverageProvenanceFailures` and
 * `coverageProvenanceUnevaluated`, so that the failure channel and the advisory channel
 * cannot disagree about a suite. They are exact complements: whichever one declines,
 * the other must speak, or a finding is lost. Two independent copies of this logic is
 * how a suite came to be reported as a hard failure and simultaneously listed under
 * "Not failing the gate on these".
 *
 * Returns a PREDICATE rather than a set so `resolveCodeIdentity` stays lazy -- the
 * overwhelmingly common run has no unverifiable suite at all and should pay no git call.
 */
function provenanceFailureIsWarranted(stampOutcomes, provenanceRequired) {
    const codeMovedDuringRun = new Set(stampOutcomes
        .filter((outcome) => outcome.kind === 'cannot-stamp' && outcome.reason === 'code-changed-during-measurement')
        .map((outcome) => outcome.suite));
    let establishable;
    const canStampAtAll = () => (establishable ??= resolveCodeIdentity().ok);
    return (suite) => {
        if (!provenanceRequired)
            return false;
        // Exception 2: the evidence cannot tell a correctly-ordered `['build',
        // 'test:coverage']` from a broken `['test:coverage', 'build']`, so it cannot carry a
        // red build. See the header.
        if (codeMovedDuringRun.has(suite))
            return false;
        // Exception 1: no sidecar is obtainable by anyone here, so no remedy would work.
        return canStampAtAll();
    };
}
export function coverageProvenanceFailures(verdicts, stampOutcomes = [], provenanceRequired = getConfig().coverage.provenanceRequired) {
    const warranted = provenanceFailureIsWarranted(stampOutcomes, provenanceRequired);
    return [
        ...verdicts.flatMap((verdict) => {
            if (verdict.kind === 'unverifiable') {
                if (!warranted(verdict.suite))
                    return [];
                return [
                    {
                        kind: 'provenance-unverified',
                        dimension: verdict.suite,
                        message: `${verdict.summaryPath} yielded a number, but nothing establishes which code it ` +
                            `describes: ${verdict.detail} A coverage report is a file on disk -- a crashed test ` +
                            'run, or a CI cache restored from another commit, leaves one that reads exactly ' +
                            'like a fresh one. Run the coverage script through `requiredScripts` so the gate ' +
                            'produces the report itself, or run `npx quality-gate-sgd stamp-coverage` in the ' +
                            'step that produces it. To grade unvouched-for numbers anyway, set ' +
                            'QUALITY_COVERAGE_PROVENANCE=optional.',
                        evidence: buildReportEvidence(`read ${verdict.summaryPath}`, 0, [
                            {
                                path: verdict.summaryPath,
                                existed: true,
                                bytesRead: null,
                                modifiedMs: modifiedMsOf(verdict.summaryPath),
                                outcome: 'read',
                            },
                        ]),
                    },
                ];
            }
            if (verdict.kind !== 'stale')
                return [];
            const stampedAgainst = verdict.stampedWithUncommittedCode
                ? `uncommitted code on top of ${verdict.codeCommit.slice(0, 7)}, and the tree no longer holds that state`
                : `${verdict.codeCommit.slice(0, 7)}, and the code has moved since`;
            return [
                {
                    kind: 'stale-report',
                    dimension: verdict.suite,
                    message: `${verdict.summaryPath} describes a different state of the code than the one being ` +
                        `graded. It was stamped against ${stampedAgainst}: ${describeChanged(verdict.changed)}. ` +
                        'Re-run the script that writes coverage (and list it in `requiredScripts` so the gate ' +
                        'runs it), or run `npx quality-gate-sgd stamp-coverage` in the step that produces the ' +
                        'report. Nothing here is inferred from a timestamp -- the report is the one that was ' +
                        'stamped, and the code under QUALITY_CODE_PATHSPECS is not.',
                    // `modifiedMs` populated rather than null, because `ReportAttempt` documents
                    // null as "nothing was read" and this path just hashed the whole file. The
                    // mtime is the first thing an investigator wants on a staleness finding, and
                    // dropping it here contradicted the argument ReportAttempt itself makes for
                    // carrying it.
                    evidence: buildReportEvidence(`read ${verdict.summaryPath}`, 0, [
                        {
                            path: verdict.summaryPath,
                            existed: true,
                            bytesRead: null,
                            modifiedMs: modifiedMsOf(verdict.summaryPath),
                            outcome: 'read',
                        },
                    ]),
                },
            ];
        }),
    ];
}
/**
 * A rule graded against coverage nobody can tie to this code.
 *
 * ONE entry per unverifiable report rather than one per rule -- the same choice
 * `evaluateAnalysisProvenance` makes for sonarqube, and for the same reason: the
 * sentence is identical for all of them, and noise in the loud channel trains
 * adopters to stop reading it.
 *
 * RULE-SCOPED, and that is load-bearing. The cost of reporting lands on the cache
 * (`monotonicEvaluated: false`, so `isCacheValid` will not serve the entry as a
 * verdict), so without the scoping every build-only project with a stray
 * `coverage/` directory would lose `PASSED (cached)` over a report nothing grades.
 *
 * The requiredScripts branches exist because the remedy an adopter is given has to be
 * one their configuration can reach, and because the sentence explaining WHY has to be
 * true of the ruleset in front of them. Three cases, not two:
 *
 *   `requiredScripts: []`   both embedded default rulesets, and cli.ts's
 *                           `rules.rules.requiredScripts || ['quality']` does not
 *                           rescue it because `[]` is TRUTHY. Nothing ran, so "let the
 *                           gate run your coverage script" is impossible advice until
 *                           they write a rules.json.
 *   key OMITTED             the `||` substitutes `['quality']`, so a script really did
 *                           run and it simply did not write this report. Telling this
 *                           reader the gate "never ran your coverage tool" is false and
 *                           sends them hunting a configuration problem that is not
 *                           there -- and blaming a report for a phantom substituted
 *                           script is what design A was removed for.
 *   scripts NAMED           the ordinary remedy.
 */
export function coverageProvenanceUnevaluated(rules, verdicts, provenanceRequired = getConfig().coverage.provenanceRequired, stampOutcomes = []) {
    // The EXACT COMPLEMENT of the failure channel, decided by the one predicate both call.
    // Where a suite failed, saying it again here -- once as a red rule, once as "this was
    // not evaluated" -- is how a loud channel stops being read. Where a suite did NOT fail
    // because of one of the two exceptions, this advisory is the ONLY thing reporting that
    // the numbers are ungrounded, and dropping it would turn a reasoned
    // refusal-to-false-fail into exactly the silence this module exists to remove.
    //
    // `stampOutcomes` is threaded in for that second case: without it this function
    // decided the question differently from `coverageProvenanceFailures`, and a codegen
    // run in `optional` mode was reported through both channels at once.
    const warranted = provenanceFailureIsWarranted(stampOutcomes, provenanceRequired);
    // THREE cases, not two, because `[]` and `undefined` are not the same ruleset and the
    // sentence explaining WHY differs between them. Every caller resolves the scripts as
    // `rules.rules.requiredScripts || ['quality']`, and `[]` is TRUTHY in JS -- so an
    // empty array runs nothing, while an omitted key silently becomes `['quality']` and a
    // script really did run. Collapsing them with `?? []` told a project that omitted the
    // key that "the gate never ran your coverage tool", which is false and sends the
    // reader looking for a configuration problem that is not there. Blaming a report for
    // a phantom substituted script is also precisely what killed design A.
    const scripts = rules.rules.requiredScripts;
    const scriptSituation = scripts === undefined ? 'defaulted' : scripts.length === 0 ? 'none' : 'named';
    return verdicts.flatMap((verdict) => {
        if (verdict.kind !== 'unverifiable')
            return [];
        if (warranted(verdict.suite))
            return [];
        const graded = rulesReadingMeasurement(rules, verdict.suite);
        if (graded.length === 0)
            return [];
        const stampIt = 'run `npx quality-gate-sgd stamp-coverage` in the CI step that produces the report.';
        const remedy = scriptSituation === 'none'
            ? 'This ruleset lists `requiredScripts: []`, so the gate ran no scripts at all and has ' +
                'nothing to vouch for. Add the coverage-writing script to `requiredScripts` in ' +
                `rules.json, or ${stampIt}`
            : scriptSituation === 'defaulted'
                ? // "did not write this report" is NOT said here, and that is deliberate: the
                    // advisory also fires when the script DID rewrite the report and the stamp
                    // was then refused, so asserting it would be false in that case. What can be
                    // stated is that no script was named -- an inference-free fact about the
                    // ruleset.
                    'This ruleset names no coverage script -- `requiredScripts` is absent, so the gate ' +
                        'ran only the default `quality` script. Name the coverage-writing script in ' +
                        `\`requiredScripts\` in rules.json, or ${stampIt}`
                : 'Add the script that writes coverage to `requiredScripts` so the gate produces the ' +
                    `report itself, or ${stampIt}`;
        return [
            {
                type: 'unverified-provenance',
                rule: `${verdict.suite}.provenance`,
                metricPath: verdict.suite,
                reason: 'provenance-unverifiable',
                message: `${graded.length} rule(s) (${graded.join(', ')}) were applied to ${verdict.suite} numbers ` +
                    `whose origin could not be established: ${verdict.detail} ${remedy}`,
            },
        ];
    });
}
/** `4f2a1c9`, matching how cli.ts prints a commit. */
export function describeCodeCommit(commit) {
    return commit.slice(0, 7);
}
//# sourceMappingURL=coverage-provenance.js.map