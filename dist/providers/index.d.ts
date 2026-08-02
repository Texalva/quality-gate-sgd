/**
 * Providers Module
 * ================
 * The seam between the gate and whichever toolchain actually measures a
 * project. See ./types.ts for why the return type is a Result.
 */
export type { Result, MeasurementFailureKind, MeasurementEvidence, MeasurementFailure, MeasurementContext, LintReading, TypecheckReading, CoverageReading, MeasurementProvider, LintProvider, TypecheckProvider, CoverageProvider, } from './types.js';
export { DEFAULT_MEASUREMENT_LIMITS, ok, err, isOk, isErr, measurementFailure, classifyProcessOutput, } from './result.js';
//# sourceMappingURL=index.d.ts.map