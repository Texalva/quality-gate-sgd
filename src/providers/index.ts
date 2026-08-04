/**
 * Providers Module
 * ================
 * The seam between the gate and whichever toolchain actually measures a
 * project. See ./types.ts for why the return type is a Result.
 */

export type {
  Result,
  MeasurementFailureKind,
  MeasurementDimension,
  MeasurementEvidence,
  ProcessEvidence,
  ReportEvidence,
  ReportAttempt,
  MeasurementFailure,
  MeasurementContext,
  LintReading,
  TypecheckReading,
  CoverageReading,
  CoverageReportRead,
  CoverageSuite,
  MeasurementProvider,
  LintProvider,
  TypecheckProvider,
  CoverageProvider,
} from './types.js';

export {
  createIstanbulCoverageProvider,
  type CoverageReportPaths,
  // Exported beside the factory it configures: a caller that wants coverage
  // NUMBERS on a large monorepo has to be able to decline the detail-report walk,
  // and a factory option nobody can name is a factory option nobody uses.
  type CoverageProviderOptions,
} from './coverage.js';

export {
  DEFAULT_MEASUREMENT_LIMITS,
  ok,
  err,
  isOk,
  isErr,
  measurementFailure,
  classifyProcessOutput,
  buildEvidence,
  buildReportEvidence,
  readJsonReport,
} from './result.js';
