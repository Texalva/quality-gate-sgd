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
import type { CoverageSuite, MeasurementFailure } from './providers/types.js';
import type { AllCoverageMetrics, QualityRules, UnevaluatedRule } from './types.js';
/** Beside the summary it describes. Dot-prefixed so it sorts out of the way. */
export declare const PROVENANCE_SIDECAR_FILE = ".quality-gate-provenance.json";
/**
 * What a stamp records. Every field is compared or reported; none is decoration.
 */
export interface CoverageProvenanceSidecar {
    readonly schema: number;
    /**
     * Which suite this stamp is for. Recorded because two suites can be configured at
     * one directory (`QUALITY_COVERAGE_LAMBDA_DIR=coverage` is legal), and a sidecar
     * read as the other suite's would vouch for a report it never saw.
     */
    readonly suite: CoverageSuite;
    /** Basename of the summary vouched for, for the same reason as `suite`. */
    readonly summaryFile: string;
    /** 40-hex HEAD at stamp time. The commit the digest below is a difference FROM. */
    readonly codeCommit: string;
    /** `codeStateDigest(codeCommit)` at stamp time. Exact equality, no tolerance. */
    readonly codeStateDigest: string;
    /**
     * sha256 of the summary's bytes.
     *
     * Without it, `stamp-coverage` followed by a hand edit of the report is a
     * laundering path: the code identity still matches, so the doctored numbers would
     * be vouched for. With it, a report replaced after stamping is UNVERIFIABLE.
     */
    readonly summarySha256: string;
    /**
     * When the stamp was taken. HUMAN EVIDENCE ONLY, never judged -- the same rule as
     * `ReportAttempt.modifiedMs`, and the reason there is no age check anywhere in
     * this module. An earlier design compared a report's age against other files'
     * ages and was wrong in both directions at once.
     */
    readonly stampedAt: string;
    /** `run` if the gate wrote the report, `stamp-coverage` if an adopter asserted it. */
    readonly stampedBy: 'run' | 'stamp-coverage';
}
/** Why a report's provenance could not be established. */
export type ProvenanceUnverifiableReason = 'no-sidecar' | 'sidecar-unusable' | 'report-rewritten-since-stamp' | 'summary-unreadable' | 'no-code-identity' | 'recorded-commit-unknown' | 'stamp-state-not-reproducible' | 'suite-directories-collide';
/** What changed since the stamp, for the message. */
export interface ChangedCode {
    /** Tracked paths whose CONTENT differs from the recorded commit. */
    readonly modified: readonly string[];
    /** Untracked code files that exist now. */
    readonly untracked: readonly string[];
    /** How many names were elided from the two lists above. */
    readonly more: number;
}
export type SuiteProvenance = {
    readonly kind: 'verified';
    readonly suite: CoverageSuite;
    readonly summaryPath: string;
    readonly sidecarPath: string;
    readonly codeCommit: string;
} | {
    readonly kind: 'stale';
    readonly suite: CoverageSuite;
    readonly summaryPath: string;
    readonly sidecarPath: string;
    readonly codeCommit: string;
    readonly changed: ChangedCode;
    /**
     * Whether the stamp was taken over a tree that already differed from its
     * commit. Changes the WORDING and nothing else: with uncommitted code in the
     * stamped state, the paths named below are what differs from the commit now,
     * not necessarily what changed since the stamp.
     */
    readonly stampedWithUncommittedCode: boolean;
} | {
    readonly kind: 'unverifiable';
    readonly suite: CoverageSuite;
    readonly summaryPath: string;
    readonly sidecarPath: string;
    readonly why: ProvenanceUnverifiableReason;
    readonly detail: string;
};
/** Which state of the code this process is looking at, or why it cannot be said. */
type CodeIdentity = {
    readonly ok: true;
    readonly commit: string;
    readonly digest: string;
} | {
    readonly ok: false;
    readonly why: string;
};
interface SummaryState {
    readonly suite: CoverageSuite;
    readonly summaryPath: string;
    readonly present: boolean;
    readonly modifiedMs: number | null;
    readonly sha256: string | null;
}
export interface CoverageProvenanceSnapshot {
    readonly summaries: readonly SummaryState[];
    /**
     * The code state as it stood BEFORE any script ran.
     *
     * Recorded so a run that mutates its own code between writing the report and
     * reading it cannot stamp. `requiredScripts: ['test:coverage', 'build']` where
     * `build` runs codegen into `src/generated` is the ordinary shape: the report
     * describes the tree as it was, and the identity resolved afterwards describes the
     * tree as it became. Stamping the second over the first is a false pass created by
     * the vouching mechanism itself, so the two are compared and a difference means
     * nothing can be vouched for.
     */
    readonly identityBefore: CodeIdentity;
}
/** Every configured suite's summary as it stands now, plus the code state. */
export declare function snapshotCoverageStateBeforeScripts(): CoverageProvenanceSnapshot;
export type StampOutcome = {
    readonly kind: 'stamped';
    readonly suite: CoverageSuite;
    readonly summaryPath: string;
    readonly sidecarPath: string;
    readonly codeCommit: string;
    readonly summarySha256: string;
    /** False when the sidecar is visible to git, which keeps the tree dirty. */
    readonly hiddenFromGit: boolean;
} | {
    readonly kind: 'not-rewritten';
    readonly suite: CoverageSuite;
    readonly summaryPath: string;
} | {
    readonly kind: 'no-report';
    readonly suite: CoverageSuite;
    readonly summaryPath: string;
} | {
    readonly kind: 'cannot-stamp';
    readonly suite: CoverageSuite;
    readonly summaryPath: string;
    readonly why: string;
    /**
     * Whether the stamp was refused because something was POSITIVELY WRONG, or
     * because the tool could not find out.
     *
     * The distinction decides whether the run fails, so it is carried in the data
     * rather than left to a caller to re-derive from the wording of `why`.
     *
     * `code-changed-during-measurement` is a finding: the code identity before the
     * scripts ran and the identity after them disagree, so the report provably
     * describes a generation of the source the tree no longer holds. That fails in
     * both provenance modes, like `stale`.
     *
     * `code-state-unknown` is an absence: git could not answer, or the sidecar
     * could not be written to a read-only artifact mount. Nothing is known to be
     * wrong, so it degrades to the ordinary unvouched-for path and is governed by
     * `provenanceRequired` like any other report nobody stamped.
     */
    readonly reason: 'code-changed-during-measurement' | 'code-state-unknown';
};
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
export declare function stampCoverageSummariesRewrittenDuringRun(snapshot: CoverageProvenanceSnapshot, stampedBy?: 'run' | 'stamp-coverage'): readonly StampOutcome[];
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
export declare function stampAllCoverageSummaries(stampedBy?: 'run' | 'stamp-coverage'): readonly StampOutcome[];
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
export declare function suitesWithNumbers(coverage: AllCoverageMetrics | undefined): readonly CoverageSuite[];
/**
 * Which state of the code each report describes.
 *
 * ORDER IS THE POLICY. The definite claim -- STALE -- is made last, and only about a
 * report recognised byte-for-byte as the one that was stamped. Everything the tool
 * cannot establish routes to `unverifiable` first: no sidecar (which costs ZERO git
 * calls, and is the default population), an unusable one, an unreadable summary, or
 * a summary whose bytes are not the ones vouched for.
 */
export declare function verifyCoverageProvenance(suites: readonly CoverageSuite[]): readonly SuiteProvenance[];
export declare function coverageProvenanceFailures(verdicts: readonly SuiteProvenance[], stampOutcomes?: readonly StampOutcome[], provenanceRequired?: boolean): readonly MeasurementFailure[];
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
export declare function coverageProvenanceUnevaluated(rules: QualityRules, verdicts: readonly SuiteProvenance[], provenanceRequired?: boolean, stampOutcomes?: readonly StampOutcome[]): readonly UnevaluatedRule[];
/** `4f2a1c9`, matching how cli.ts prints a commit. */
export declare function describeCodeCommit(commit: string): string;
export {};
//# sourceMappingURL=coverage-provenance.d.ts.map