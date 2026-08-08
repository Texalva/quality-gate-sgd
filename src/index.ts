/**
 * quality-gate-sgd
 * ================
 * Deterministic quality gates for stochastic gradient descent behavior from LLM agents.
 *
 * This package provides:
 * - Quality gate evaluation with floors, ceilings, and monotonic rules
 * - SonarQube integration for code quality metrics
 * - Coverage aggregation from multiple test suites
 * - Intelligent caching with content-aware hashing
 * - Dependency graph analysis for test prioritization
 * - Priority computation for LLM agent guidance
 */

// =============================================================================
// Core Types
// =============================================================================

export type {
  // Cache types
  QualityGateCache,
  CacheEntry,

  // Metrics types
  Metrics,
  AllCoverageMetrics,
  CoverageMetrics,
  TotalCoverageMetrics,
  TypescriptMetrics,
  EslintMetrics,
  SonarqubeMetrics,
  SonarqubeAnalysisProvenance,
  BundleMetrics,

  // Root-cause analysis types
  RootCause,
  RootCauseGroup,

  // Rules types
  QualityRules,
  MonotonicRule,

  // Evaluation types
  EvaluationResult,
  FailedRule,

  // Dependency graph types
  FileInfo,

  // Optimization types
  OptimizationConfig,
  PriorityWeights,
  PrioritizedFile,
} from './types.js';

// =============================================================================
// Configuration
// =============================================================================

export {
  type QualityGateConfig,
  getConfig,
  loadConfig,
  resetConfig,
  getSonarAuthToken,
  getSonarCurlAuth,
} from './config.js';

// =============================================================================
// Rules Engine
// =============================================================================

export {
  loadRules,
  computeRulesHash,
  evaluateRules,
  isCacheValid,
  isUsingEmbeddedDefaults,
  type LoadRulesOptions,
} from './rules.js';

export {
  getDefaultRules,
  isEmbeddedDefaults,
  COVERAGE_ONLY_DEFAULTS,
  FULL_DEFAULTS,
} from './defaults.js';

// =============================================================================
// Metrics Extraction
// =============================================================================

export {
  // Coverage
  measureCoverage,
  extractAllCoverageMetrics,
  extractCoverageMetrics,

  // SonarQube
  extractSonarqubeMetrics,
  // The failure-carrying variant, exported alongside the lossy one. Publishing only
  // `extractSonarqubeMetrics` left every external caller with the defect this
  // package exists to catch: `undefined` from a refused token and `undefined` from
  // a project with no issues are the same value.
  readSonarqubeMetrics,
  type SonarqubeReading,
  isSonarqubeAvailable,
  runSonarqubeScan,
  // Not tidiness: `declaration: true` means tsc has to be able to NAME
  // `runSonarqubeScan`'s return type and `readSonarqubeMetrics`'s parameter in the
  // emitted .d.ts, and an external caller threading a scan into an extraction needs
  // both.
  type SonarqubeScanOutcome,
  type SubmittedAnalysis,
  type SubmittedAnalysisFromScan,
  getTopSonarIssues,
  type SonarIssue,

  // TypeScript & ESLint
  extractTypescriptMetrics,
  extractEslintMetrics,

  // Scripts
  runScript,
  runScripts,

  // SLOC extraction
  extractSloc,

  // Full extraction
  extractAllMetrics,
  extractAllMetricsAsync,
  // The variants that keep the coverage provenance verdicts. Published alongside the
  // lossy ones for the same reason `readSonarqubeMetrics` is: a consumer producing a
  // VERDICT needs to know which reports it can stand behind, and the Metrics-only
  // signatures cannot say.
  extractAllMetricsAndCoverageProvenance,
  extractAllMetricsAsyncAndCoverageProvenance,
  type MetricsWithCoverageProvenance,
} from './metrics.js';

// =============================================================================
// Cache System
// =============================================================================

export {
  // Git utilities
  getCurrentCommitHash,
  resolveBaselineCommit,
  getCacheKey,
  isWIPKey,

  // Cache I/O
  loadCache,
  saveCache,

  // Cache entry operations
  getCacheEntry,
  setCacheEntry,
  createCacheEntry,
  findBaselineEntry,
  pruneOldEntries,

  // The code-state question the provenance sidecar asks, published because a consumer
  // that wants to stamp a report from its own pipeline needs the same answer the gate
  // uses rather than a second one.
  codeStateDigest,
  type CodeStateDigest,
  listUntrackedCodeFiles,
} from './cache.js';

// =============================================================================
// Coverage Report Provenance
// =============================================================================
//
// Published because the verdict is a FACT ABOUT THE READING, not an internal detail of
// the CLI. A consumer that reads `metrics.coverage` without being able to ask which
// state of the code produced it is back where this module started: grading a report
// nothing ties to the code.

export {
  verifyCoverageProvenance,
  snapshotCoverageStateBeforeScripts,
  stampCoverageSummariesRewrittenDuringRun,
  stampAllCoverageSummaries,
  coverageProvenanceFailures,
  coverageProvenanceUnevaluated,
  suitesWithNumbers,
  describeCodeCommit,
  PROVENANCE_SIDECAR_FILE,
  type CoverageProvenanceSidecar,
  type CoverageProvenanceSnapshot,
  type ProvenanceUnverifiableReason,
  type StampOutcome,
  type SuiteProvenance,
} from './coverage-provenance.js';

// =============================================================================
// Severity Weights (SGD Gradient)
// =============================================================================

export {
  DEFAULT_SEVERITY_WEIGHTS,
  getSeverityWeight,
  sumSeverityWeights,
} from './severity.js';

// =============================================================================
// Dependency Graph Analysis
// =============================================================================

export {
  // Graph building
  buildDependencyGraph,
  buildDependentCounts,

  // File analysis
  getAllTypeScriptFiles,
  extractLocalImports,
  calculateDegrees,

  // Coverage integration
  attachCoverageData,
} from './dependency-graph.js';

// =============================================================================
// Optimizer (Priority Computation)
// =============================================================================

export {
  // Priority computation
  computePriority,
  prioritizeFiles,

  // Default weights
  DEFAULT_PRIORITY_WEIGHTS,
} from './optimizer.js';

// =============================================================================
// Issue Listing
// =============================================================================

export { listIssues } from './list-issues.js';

// =============================================================================
// Initialization
// =============================================================================

export { runInit } from './init.js';

// =============================================================================
// Dimension Registry
// =============================================================================

export type {
  DimensionDef,
  DimensionUnit,
  DimensionDirection,
  DimensionContinuity,
  DimensionCategory,
} from './dimensions/index.js';

export {
  // Constants
  BUILTIN_DIMENSIONS,

  // Registration
  registerDimension,
  clearCustomDimensions,

  // Lookup
  getDimension,
  getAllDimensions,
  getValidPaths,
  validatePath,

  // Filtering
  getDimensionsByCategory,
  getDimensionsByContinuity,
  getSmoothDimensions,
  getConstraintDimensions,

  // Documentation
  formatDimensionsTable,
  generateDimensionsDoc,

  // Custom dimensions
  loadCustomDimensions,
  extractCustomMetric,
  registerCustomDimensions,
  extractAllCustomMetrics,
} from './dimensions/index.js';

export type {
  CustomDimensionConfig,
  ScriptExtractor,
} from './dimensions/index.js';

// =============================================================================
// Fitness Function (SGD Scalar Objective)
// =============================================================================

export type {
  FitnessConfig,
  FitnessAggregation,
  GradientComponent,
  FitnessSuggestion,
} from './fitness.js';

export {
  // Config
  getDefaultFitnessConfig,

  // Computation
  computeFitness,
  computeGradient,

  // Suggestions
  suggestNextFix,
  suggestNextFixes,

  // Formatting
  formatFitnessScore,
  formatGradientTable,
  formatSuggestion,

  // Utility
  getMetricValue,
} from './fitness.js';

// =============================================================================
// Trajectory Analysis (SGD Descent)
// =============================================================================

export type {
  NormalizedMetrics,
  TrajectoryPoint,
  Trajectory,
  ConvergenceState,
} from './types.js';

export {
  // Normalization
  normalizeMetrics,

  // Quality score
  computeQualityScore,
  DEFAULT_QUALITY_WEIGHTS,

  // Trajectory building
  buildTrajectory,

  // Visualization
  trajectorySparkline,
  formatTrajectorySummary,
} from './trajectory.js';

// =============================================================================
// MCP Server (Model Context Protocol)
// =============================================================================

export {
  // Server
  createMcpServer,
  runMcpServer,

  // Tools
  TOOLS,
  handleRun,
  handleScore,
  handleSuggest,
  handleTrajectory,
  handleExplain,

  // Resources
  RESOURCES,
  readResource,
} from './mcp/index.js';

// =============================================================================
// Experiment Infrastructure (Hypothesis Validation)
// =============================================================================

export type {
  ExperimentDesign,
  HypothesisId,
  ExperimentCondition,
  ExperimentConfig,
  IterationRecord,
  TargetSuggestion,
  IterationOutcome,
  ExperimentRun,
  RunOutcome,
  RunMetadata,
  StatisticalTest,
  DescriptiveStats,
  HypothesisResult,
  ExperimentBatch,
  DesignMetadata,
  // Runner types
  ExperimentTask,
  IterationEvaluationResult,
  ExperimentAgent,
  RunOptions,
  BatchOptions,
  ResumeOptions,
  // Harness types
  MetricsProvider,
  LLMExecutor,
  FixContext,
  FixAttemptResult,
  HarnessOptions,
} from './experiments/index.js';

export {
  // Logger
  startExperimentRun,
  logIteration,
  endExperimentRun,
  getCurrentRunId,
  getCurrentIteration,
  createBatch,
  addRunToBatch,
  saveBatch,
  loadBatch,
  loadRun,
  listRuns,

  // Statistics
  describe,
  tTest,
  pearsonCorrelation,
  spearmanCorrelation,
  chiSquaredTest,

  // Analysis
  analyzeBatch,
  generateAnalysisReport,

  // Visualization
  sparkline,
  visualizeRun,
  compareRuns,
  visualizeBatch,
  visualizeResults,
  boxPlot,
  comparativeBoxPlots,
  iterationTimeline,
  resultsTable,

  // Condition Factory
  DEFAULT_EXPERIMENT_CONFIG,
  DESIGN_METADATA,
  createConditions,
  getBaselineCondition,
  getTreatmentConditions,
  validateCondition,
  canPairConditions,
  describeCondition,
  conditionLabel,

  // Runner
  executeRun,
  executeBatch,
  executeTaskAcrossConditions,
  executeBaselineVsTreatment,
  canResumeRun,
  getLastIteration,
  createMockAgent,
  estimateTimeRemaining,
  formatDuration,

  // Agent Harness
  createAgentHarness,
  createMockMetricsProvider,
  createMockExecutor,
} from './experiments/index.js';
