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
export {};
//# sourceMappingURL=types.js.map