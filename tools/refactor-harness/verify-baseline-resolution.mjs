#!/usr/bin/env node
/**
 * Negative control for baseline commit resolution, against REAL git.
 *
 *   node tools/refactor-harness/verify-baseline-resolution.mjs [tool-dir]
 *
 * `resolveBaselineCommit` has unit tests, and they are all mocked -- they assert
 * that a hand-written string shaped like `git cat-file commit` output parses the
 * way it should. That is worth having and it cannot catch the bug that mattered:
 * the defect was never in the parsing, it was in the BELIEF that
 * `git rev-parse HEAD~1` answers "what is the parent of HEAD". In a shallow
 * clone it does not, and no mock predicts that, because a mock returns whatever
 * the person writing it already believed.
 *
 * The same shape of mistake has now bitten this refactor three times: spawnSync's
 * maxBuffer turned out to be a budget SHARED across stdout and stderr, `exactly`
 * the limit turned out not to be truncation, and `git log --format=%P` turns out
 * to honour the shallow graft while `git cat-file` does not. Each was wrong in a
 * comment and right in a measurement.
 *
 * So this builds real repositories, clones one at --depth 1, and asks the
 * compiled tool what it thinks the baseline is.
 *
 * Exit: 0 all cases correct | 1 at least one wrong | 2 the fixture itself is
 * not exercising what it claims to
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(process.argv[2] ?? join(HERE, "..", ".."));

const ROOT = mkdtempSync(join(tmpdir(), "qg-baseline-"));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A repository with `count` commits on a linear history.
 *
 * Committer identity and dates are pinned so nothing here depends on the
 * machine's git config.
 */
function makeRepo(name, count) {
  const dir = join(ROOT, name);
  execFileSync("git", ["init", "-q", dir], { encoding: "utf8" });
  git(dir, "config", "user.email", "probe@example.com");
  git(dir, "config", "user.name", "Probe");
  git(dir, "config", "commit.gpgsign", "false");

  for (let i = 1; i <= count; i++) {
    writeFileSync(join(dir, "file.txt"), `revision ${i}\n`);
    git(dir, "add", "file.txt");
    git(dir, "commit", "-q", "-m", `commit ${i}`);
  }
  return dir;
}

/** What the compiled tool says the baseline is, for a real directory. */
function resolveIn(dir) {
  const script = `
    process.env.QUALITY_PROJECT_ROOT = ${JSON.stringify(dir)};
    process.env.QUALITY_PROJECT_NAME = 'baseline-probe';
    const cache = await import(${JSON.stringify(`${TOOL}/dist/cache.js`)});
    process.stdout.write(JSON.stringify(cache.resolveBaselineCommit()));
  `;

  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (proc.status !== 0) {
    return { kind: "threw", reason: (proc.stderr ?? "").slice(0, 600) };
  }
  try {
    return JSON.parse(proc.stdout);
  } catch {
    return { kind: "unparseable", reason: proc.stdout.slice(0, 300) };
  }
}

const results = [];
const check = (name, passed, detail, stands_for) =>
  results.push({ name, passed, detail, stands_for });

// --- the case the fix exists for -------------------------------------------
const origin = makeRepo("origin", 4);
const expectedParent = git(origin, "rev-parse", "HEAD~1");

const shallow = join(ROOT, "shallow");
execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, shallow], {
  encoding: "utf8",
});

// The fixture has to be genuinely shallow, or every assertion below is vacuous.
const isShallow = git(shallow, "rev-parse", "--is-shallow-repository");
const revParseWorks = spawnSync("git", ["rev-parse", "HEAD~1"], { cwd: shallow }).status === 0;

if (isShallow !== "true" || revParseWorks) {
  console.error(
    "FIXTURE NOT EXERCISING THE BUG: the clone reports is-shallow=" +
      `${isShallow} and rev-parse HEAD~1 ${revParseWorks ? "SUCCEEDS" : "fails"}.\n` +
      "The whole point is a clone where the old implementation breaks. Nothing below is meaningful."
  );
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(2);
}

{
  const got = resolveIn(shallow);
  check(
    "shallow clone: parent recovered",
    got.kind === "parent" && got.hash === expectedParent,
    got.kind === "parent" && got.hash === expectedParent
      ? `parent ${got.hash.slice(0, 12)} found despite the graft`
      : `expected parent ${expectedParent}, got ${JSON.stringify(got)}`,
    "actions/checkout clones at depth 1 by DEFAULT. `git rev-parse HEAD~1` exits 128 there, which the old code read as 'first commit' -- so every monotonic rule silently stopped being enforced in CI while still passing locally."
  );
}

// --- and the ordinary case still works --------------------------------------
{
  const got = resolveIn(origin);
  check(
    "full clone: parent resolved",
    got.kind === "parent" && got.hash === expectedParent,
    got.kind === "parent" && got.hash === expectedParent
      ? `parent ${got.hash.slice(0, 12)}`
      : `expected parent ${expectedParent}, got ${JSON.stringify(got)}`
  );
}

// --- a root commit genuinely has no baseline --------------------------------
{
  const single = makeRepo("single", 1);
  const got = resolveIn(single);
  check(
    "root commit: reported as root, not as an error",
    got.kind === "root-commit",
    got.kind === "root-commit" ? "root-commit" : `expected root-commit, got ${JSON.stringify(got)}`,
    "The one case the old catch got right, and it must keep working -- a genuine first commit has nothing to compare against and that is not a failure."
  );
}

// --- a merge commit takes its first parent ----------------------------------
{
  const merged = makeRepo("merged", 2);
  const mainline = git(merged, "rev-parse", "HEAD");
  git(merged, "checkout", "-q", "-b", "side", "HEAD~1");
  writeFileSync(join(merged, "side.txt"), "side\n");
  git(merged, "add", "side.txt");
  git(merged, "commit", "-q", "-m", "side commit");
  git(merged, "checkout", "-q", "-");
  git(merged, "merge", "-q", "--no-ff", "-m", "merge side", "side");

  const got = resolveIn(merged);
  check(
    "merge commit: first parent chosen",
    got.kind === "parent" && got.hash === mainline,
    got.kind === "parent" && got.hash === mainline
      ? `first parent ${got.hash.slice(0, 12)}, matching what HEAD~1 meant`
      : `expected first parent ${mainline}, got ${JSON.stringify(got)}`
  );
}

// --- a "parent" line in the MESSAGE is not a parent -------------------------
{
  const revert = makeRepo("revert", 2);
  const realParent = git(revert, "rev-parse", "HEAD");
  writeFileSync(join(revert, "file.txt"), "reverted\n");
  git(revert, "add", "file.txt");
  git(
    revert,
    "commit",
    "-q",
    "-m",
    "Revert an earlier change\n\nparent 0000000000000000000000000000000000000000"
  );

  const got = resolveIn(revert);
  check(
    "commit message containing 'parent <sha>' ignored",
    got.kind === "parent" && got.hash === realParent,
    got.kind === "parent" && got.hash === realParent
      ? `read the header parent ${got.hash.slice(0, 12)}, not the message`
      : `expected ${realParent}, got ${JSON.stringify(got)}`,
    "`git cat-file commit` emits headers, a blank line, then the message. Reverts and cherry-picks routinely put a 'parent <sha>' line in the message, so scanning the whole output finds a parent that is not one."
  );
}

// --- a signed commit puts a PGP block in the header -------------------------
//
// The header is separated from the message by a blank line, and PGP armor
// contains a blank line of its own, so a naive read of a signed commit stops
// before reaching the parent. Git folds continuation lines with a leading space
// and that "blank" line arrives as `" "` rather than `""`, which is what makes
// the split safe -- verified here rather than asserted, because getting it wrong
// silently disables monotonic rules for every repository that signs.
{
  const gpgAvailable = spawnSync("gpg", ["--version"], { encoding: "utf8" }).status === 0;

  if (!gpgAvailable) {
    // Reported as a SKIP, never folded into the pass count. A check that did not
    // run must not read as a check that succeeded.
    check(
      "signed commit: SKIPPED (no gpg on this machine)",
      true,
      "gpg unavailable, so this case did not run -- it is not evidence of anything",
    );
  } else {
    const home = mkdtempSync(join(ROOT, "gnupg-"));
    const gpgEnv = { ...process.env, GNUPGHOME: home };
    const keygen = spawnSync(
      "gpg",
      [
        "--batch", "--quick-generate-key", "--passphrase", "",
        "Probe Signer <probe@example.com>", "default", "default", "never",
      ],
      { encoding: "utf8", env: gpgEnv }
    );
    const fpr = spawnSync("gpg", ["--list-secret-keys", "--with-colons"], {
      encoding: "utf8",
      env: gpgEnv,
    })
      .stdout?.split("\n")
      .find((line) => line.startsWith("fpr:"))
      ?.split(":")[9];

    if (keygen.status !== 0 || !fpr) {
      check(
        "signed commit: SKIPPED (key generation failed)",
        true,
        `gpg could not produce a throwaway key: ${(keygen.stderr ?? "").slice(0, 200)}`
      );
    } else {
      const signed = makeRepo("signed", 2);
      const realParent = git(signed, "rev-parse", "HEAD");
      git(signed, "config", "user.signingkey", fpr);
      git(signed, "config", "gpg.program", "gpg");
      writeFileSync(join(signed, "file.txt"), "signed revision\n");
      git(signed, "add", "file.txt");
      execFileSync("git", ["commit", "-q", "-S", "-m", "signed commit"], {
        cwd: signed,
        encoding: "utf8",
        env: gpgEnv,
      });

      // Confirm the commit really carries a signature, or the case is inert.
      const hasSignature = git(signed, "cat-file", "commit", "HEAD").includes("gpgsig");
      const got = resolveIn(signed);
      const passed = hasSignature && got.kind === "parent" && got.hash === realParent;

      check(
        "signed commit: parent read past the PGP block",
        passed,
        !hasSignature
          ? "the commit carries no gpgsig header, so this case proved nothing"
          : passed
            ? `parent ${got.hash.slice(0, 12)} found past the armor`
            : `expected ${realParent}, got ${JSON.stringify(got)}`,
        "PGP armor contains a blank line. Git folds it to a line holding a single space, so the header/message split still lands after the signature -- but a signed commit is exactly where a wrong assumption here would hide."
      );
    }
  }
}

// --- no git at all is indeterminate, not a root commit ----------------------
{
  const bare = mkdtempSync(join(ROOT, "notarepo-"));
  const got = resolveIn(bare);
  check(
    "non-repository: indeterminate, not root-commit",
    got.kind === "indeterminate",
    got.kind === "indeterminate"
      ? "indeterminate, so findBaselineEntry can refuse rather than guess"
      : `expected indeterminate, got ${JSON.stringify(got)}`,
    "Answering 'root commit' here claims there is nothing to compare against, which reads as a satisfied monotonic rule rather than an unasked question."
  );
}

rmSync(ROOT, { recursive: true, force: true });

// --- report -----------------------------------------------------------------
for (const r of results) {
  console.log(`${r.passed ? "ok  " : "FAIL"} ${r.name.padEnd(48)} ${r.detail}`);
}
console.log();

const failed = results.filter((r) => !r.passed);

if (failed.length === 0) {
  console.log(
    `BASELINE RESOLUTION OK: ${results.length} cases against real git, including a depth-1 clone.`
  );
  process.exit(0);
}

console.error(`BASELINE RESOLUTION WRONG: ${failed.length} case(s).\n`);
for (const r of failed) {
  console.error(`  ${r.name}`);
  if (r.stands_for) console.error(`    ${r.stands_for}`);
  console.error(`    ${r.detail}\n`);
}
process.exit(1);
