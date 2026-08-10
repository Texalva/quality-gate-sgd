/**
 * `openai` is an optional peer dependency, so a normal install does not have it.
 * This file is separate from the other fixability suites because they mock the
 * module as a WORKING client; `vi.mock` is file-scoped and hoisted, so the
 * absent case cannot share a file with the present case.
 *
 * The failure being pinned is not the return value on its own -- an estimator
 * that returns [] because the package is missing looks identical, from the
 * caller, to one that returns [] because nothing was worth estimating. What
 * makes it safe is that the reason reaches the operator, so the guard here
 * asserts the message and its remedy, not just the empty array.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// A module whose factory throws is what a genuinely absent package looks like to
// a dynamic import.
vi.mock('openai', () => {
  throw new Error("Cannot find module 'openai'");
});

import { estimateFixability } from '../../src/fixability/index.js';
import type { SymbolIssues } from '../../src/symbols/types.js';

function symbolWithIssues(): SymbolIssues {
  return {
    symbol: {
      id: 'src/thing.ts::doThing',
      file: 'src/thing.ts',
      name: 'doThing',
      qualifiedName: 'doThing',
      kind: 'function',
      span: { startLine: 1, endLine: 12 },
      sloc: 12,
      exported: true,
    },
    issues: [],
    totalDeltaQ: 4,
  } as unknown as SymbolIssues;
}

describe('fixability estimation without the optional openai package', () => {
  const savedKey = process.env.OPENAI_API_KEY;
  let said: string[] = [];

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-present-but-unusable';
    said = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      said.push(args.map((arg) => String(arg)).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  it('says the package is missing and names the install, rather than throwing', async () => {
    const symbols = [symbolWithIssues()];

    const estimates = await estimateFixability(symbols);

    expect(estimates).toEqual([]);

    const reported = said.join('\n');
    expect(reported).toContain('optional `openai` package');
    expect(reported).toContain('npm install openai');
    // The remedy has to say what is NOT broken, or an adopter reads a missing
    // optional feature as a broken gate.
    expect(reported).toContain('every measured dimension is unchanged');
  });

  it('leaves the symbols it could not estimate exactly as they were', async () => {
    const symbols = [symbolWithIssues()];
    const before = JSON.parse(JSON.stringify(symbols)) as SymbolIssues[];

    await estimateFixability(symbols);

    // No fixabilityScore, no adjustedDeltaQ, no reordering: an estimator that
    // cannot run must not leave partial scoring behind for the ranker to trust.
    expect(symbols).toEqual(before);
    expect(symbols[0].fixabilityScore).toBeUndefined();
    expect(symbols[0].adjustedDeltaQ).toBeUndefined();
  });

  it('does not report a missing key when the key is present', async () => {
    await estimateFixability([symbolWithIssues()]);

    expect(said.join('\n')).not.toContain('OPENAI_API_KEY not set');
  });
});
