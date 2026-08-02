/**
 * Quality-Gated Mini-SWE-agent Wrapper
 * =====================================
 * Scientifically correct instrumentation of mini-swe-agent.
 *
 * ONLY adds quality gate hook before submission - everything else identical.
 *
 * Baseline: Mini-SWE-agent with bash tools
 * Treatment: Mini-SWE-agent + Quality gate before submission
 *
 * This allows direct comparison to published mini-swe-agent results (74% on SWE-bench Verified).
 */
import type { SWEBenchTask } from '../swebench/types.js';
import type { PatchProposalReasoning, PatchQualityMetrics } from '../swebench/quality-gate.js';
import { DEFAULT_QUALITY_GATE } from '../swebench/quality-gate.js';
export interface QualityGatedMiniAgentConfig {
    /** Model to use (gpt-5.2, claude-opus-4.5, etc.) */
    model: string;
    /** API key */
    apiKey?: string;
    /** Quality gate config */
    qualityGate?: {
        minOverallQuality?: number;
        minDimensionScores?: Record<string, number>;
    };
    /** Max reasoning iterations before accepting suboptimal quality */
    maxReasoningIterations?: number;
    /** Whether to enable quality gate (false = baseline, true = treatment) */
    enableQualityGate?: boolean;
    /** Python path for mini-swe-agent */
    miniSweAgentPath?: string;
    /** Config file (default: mini.yaml) */
    configFile?: string;
    /** Cost limit */
    costLimit?: number;
    /** Step limit */
    stepLimit?: number;
    /** Verbose logging */
    verbose?: boolean;
}
export interface AgentResult {
    success: boolean;
    patch?: string;
    trajectory: AgentMessage[];
    exitStatus: string;
    exitMessage: string;
    qualityScores?: PatchQualityMetrics[];
    iterations: number;
    cost: number;
    error?: string;
}
export interface AgentMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp?: number;
    action?: string;
    output?: string;
}
/**
 * Run mini-swe-agent on a task with optional quality gate.
 *
 * This preserves ALL of mini-swe-agent's behavior except adds quality evaluation
 * before accepting the COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT command.
 */
export declare function runQualityGatedMiniAgent(task: SWEBenchTask, config: QualityGatedMiniAgentConfig): Promise<AgentResult>;
/**
 * Extract reasoning from mini-swe-agent trajectory.
 *
 * Mini-swe-agent includes THOUGHT sections before each action.
 * We aggregate these to reconstruct the reasoning.
 */
export declare function extractReasoningFromTrajectory(trajectory: AgentMessage[]): PatchProposalReasoning | null;
/**
 * This is the hook point for the quality gate.
 *
 * In the full implementation, this would be called from Python:
 *
 * ```python
 * # In minisweagent/agents/default.py
 *
 * def has_finished(self, output: dict[str, str]):
 *     lines = output.get("output", "").lstrip().splitlines(keepends=True)
 *
 *     if lines and lines[0].strip() == "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT":
 *         # HOOK: Quality gate evaluation
 *         if QUALITY_GATE_ENABLED:
 *             reasoning = extract_reasoning_from_trajectory(self.messages)
 *             quality = evaluate_quality(reasoning)
 *
 *             if quality.overall < THRESHOLD:
 *                 feedback = generate_feedback(quality)
 *                 raise FormatError(f"QUALITY GATE REJECTED: {feedback}")
 *
 *         raise Submitted("".join(lines[1:]))
 * ```
 *
 * This preserves all mini-swe-agent behavior except adds quality check.
 */
export declare function shouldAcceptSubmission(trajectory: AgentMessage[], qualityGateConfig: typeof DEFAULT_QUALITY_GATE): {
    accept: boolean;
    feedback?: string;
    quality?: PatchQualityMetrics;
};
//# sourceMappingURL=quality-gated-mini-agent.d.ts.map