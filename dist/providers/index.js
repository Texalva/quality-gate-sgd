/**
 * Providers Module
 * ================
 * The seam between the gate and whichever toolchain actually measures a
 * project. See ./types.ts for why the return type is a Result.
 */
export { createIstanbulCoverageProvider, } from './coverage.js';
export { DEFAULT_MEASUREMENT_LIMITS, ok, err, isOk, isErr, measurementFailure, classifyProcessOutput, buildEvidence, buildReportEvidence, readJsonReport, } from './result.js';
//# sourceMappingURL=index.js.map