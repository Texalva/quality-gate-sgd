/**
 * Provider Types
 * ==============
 * The boundary between "the gate wants a reading" and "some particular tool
 * produces one".
 *
 * The tool currently has its toolchain welded in: `spawnSync('npx', ['eslint',
 * ...])` appears literally in metrics.ts and again in targets/extract.ts. No
 * configuration can make that run biome. These types are what the extraction
 * moves behind.
 *
 * The load-bearing decision here is `Result<Reading, MeasurementFailure>`.
 * Today every extraction path collapses failure into absence:
 *
 *     const output = result.stdout || '[]';   // crash, timeout, truncation
 *     const results = JSON.parse(output);     // ...parses, yields zero findings
 *
 * A linter that never ran reports `{errors: 0}`, which satisfies an
 * `eslint.errors: 0` ceiling. That has bitten this repo twice: once when a
 * missing gitignored file crashed eslint, and once when output crossed
 * spawnSync's 1 MiB buffer and was silently truncated. Making the return type
 * a union forces every implementation to say which of the two happened, and
 * makes "measured nothing" unrepresentable as an error.
 */
/**
 * The kinds that arrive ALONGSIDE a value for their dimension.
 *
 * Lives here, beside the union it partitions, because three separate surfaces have to
 * agree about it and each one says something FALSE if it disagrees. `evaluateMeasurements`
 * in rules.ts prints "could not be measured", `describeUnmeasured` labels a dimension
 * "missing from this score", and the MCP handlers serialise the same partition -- all
 * three of which are wrong about a dimension whose percentage appears in the very same
 * output. Each one used to carry its own `=== 'stale-report'` check and its own comment
 * explaining the exception, so adding a second such kind silently made all three false at
 * once. It is a closed set rather than a predicate on the string so that adding a fourth
 * is a deliberate edit here.
 *
 * All of them are provenance findings: the tool ran, the report parsed, the arithmetic is
 * honest, and what is in doubt is WHICH CODE the number describes.
 */
export const MEASUREMENT_KINDS_REPORTING_A_NUMBER = new Set(['stale-report', 'provenance-unverified', 'code-changed-during-measurement']);
//# sourceMappingURL=types.js.map