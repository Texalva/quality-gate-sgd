#!/usr/bin/env node
/**
 * Asserts the Apollo fixture is byte-for-byte the subject the golden baseline
 * was captured against.
 *
 * The fixture is not read-only -- npm, git and eslint all need to write to it.
 * So rather than trying to PREVENT drift, this detects it and fails loudly,
 * the same stance the liveness gate takes toward measurement. A golden master
 * compared against a silently-changed subject is worse than no golden master,
 * because it reports confidence it has not earned.
 *
 *   node verify-fixture.mjs           # check, exit 1 on drift
 *   node verify-fixture.mjs --write   # (re)generate the manifest
 *
 * The subject is 793 MB with node_modules and lives outside the repo, so its
 * location comes from the manifest that pins it rather than from a path next to
 * this script. It used to be assumed to be a sibling directory, which meant the
 * committed copy of this file could not run at all -- only the copy that
 * happened to sit beside the fixture worked, from identical bytes.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "fixture-manifest.json");

const manifestOnDisk = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, "utf-8"))
  : null;

const [FIXTURE, FIXTURE_SOURCE] = process.env.QG_FIXTURE_DIR
  ? [resolve(process.env.QG_FIXTURE_DIR), "$QG_FIXTURE_DIR"]
  : manifestOnDisk?.fixture
    ? [manifestOnDisk.fixture, "fixture-manifest.json"]
    : [join(HERE, "apollo-client"), "default sibling directory"];

if (!existsSync(FIXTURE) || !statSync(FIXTURE).isDirectory()) {
  console.error(`FIXTURE MISSING: ${FIXTURE}`);
  console.error(`  (path came from ${FIXTURE_SOURCE})`);
  console.error("\nSet QG_FIXTURE_DIR to the subject checkout, or re-clone it there.");
  process.exit(1);
}

/**
 * Files that are load-bearing but invisible to `git status` because they are
 * gitignored. The canonical-references stub is the one that, when missing,
 * crashed eslint into reporting zero findings -- the original vacuous pass.
 */
const IGNORED_BUT_REQUIRED = ["docs/public/canonical-references.json"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const git = (...args) =>
  execFileSync("git", ["-C", FIXTURE, ...args], { encoding: "utf-8" });

function probe() {
  const head = git("rev-parse", "HEAD").trim();

  // Hash the full tracked-file diff rather than listing filenames: a changed
  // filename AND a changed line both have to move this hash.
  const diff = git("diff", "HEAD");

  const ignoredFiles = Object.fromEntries(
    IGNORED_BUT_REQUIRED.map((rel) => {
      const abs = join(FIXTURE, rel);
      return [rel, existsSync(abs) ? sha256(readFileSync(abs)) : null];
    })
  );

  return {
    head,
    trackedDiffSha: sha256(diff),
    trackedDiffBytes: Buffer.byteLength(diff),
    modifiedPaths: git("diff", "--name-only", "HEAD").trim().split("\n").filter(Boolean),
    ignoredFiles,
    packageLockSha: sha256(readFileSync(join(FIXTURE, "package-lock.json"))),
  };
}

const actual = probe();

if (process.argv.includes("--write")) {
  const manifest = {
    what: "Frozen state of the Apollo Client fixture the golden baseline was captured against.",
    fixture: FIXTURE,
    ...actual,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("wrote fixture-manifest.json");
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

if (manifestOnDisk === null) {
  console.error("FIXTURE UNVERIFIED: no manifest. Run with --write first.");
  process.exit(1);
}

const expected = manifestOnDisk;
const drift = [];

const compare = (label, exp, got) => {
  if (JSON.stringify(exp) !== JSON.stringify(got)) {
    drift.push({ field: label, expected: exp, actual: got });
  }
};

// A manifest pinning one checkout cannot vouch for a different one, so an
// override that silently points elsewhere is drift like any other.
compare("fixture", expected.fixture, FIXTURE);
compare("head", expected.head, actual.head);
compare("trackedDiffSha", expected.trackedDiffSha, actual.trackedDiffSha);
compare("modifiedPaths", expected.modifiedPaths, actual.modifiedPaths);
compare("packageLockSha", expected.packageLockSha, actual.packageLockSha);

for (const rel of IGNORED_BUT_REQUIRED) {
  if (actual.ignoredFiles[rel] === null) {
    drift.push({ field: `ignoredFiles.${rel}`, expected: "present", actual: "MISSING" });
  } else {
    compare(`ignoredFiles.${rel}`, expected.ignoredFiles?.[rel], actual.ignoredFiles[rel]);
  }
}

if (drift.length === 0) {
  console.log(`FIXTURE VERIFIED  head=${actual.head.slice(0, 10)}  diff=${actual.trackedDiffBytes}B`);
  process.exit(0);
}

console.error("FIXTURE DRIFTED -- the golden baseline is not comparable:\n");
for (const d of drift) {
  console.error(`  ${d.field}`);
  console.error(`    expected: ${JSON.stringify(d.expected)}`);
  console.error(`    actual:   ${JSON.stringify(d.actual)}\n`);
}
process.exit(1);
