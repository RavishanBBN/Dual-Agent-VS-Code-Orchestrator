import type { WorkflowKind, WorkflowStageDefinition } from './types.js';

const IMPLEMENTATION: readonly WorkflowStageDefinition[] = [
  {
    id: 'claude-plan',
    title: 'Claude plans the implementation',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Primary technical design',
    instructions:
      'Inspect the repository, clarify the desired outcome from available evidence, and produce an implementation plan with risks, acceptance criteria, affected files, and verification commands. Do not modify files.',
  },
  {
    id: 'codex-plan-review',
    title: 'Codex reviews the plan',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent plan review',
    instructions:
      'Review Claude\'s plan independently. Identify incorrect assumptions, missing edge cases, security or compatibility risks, unnecessary scope, and stronger alternatives. Cite repository evidence. Do not modify files.',
  },
  {
    id: 'claude-implement',
    title: 'Claude reconciles and implements',
    agent: 'claude',
    permission: 'workspace-write',
    purpose: 'Primary implementation',
    instructions:
      'Reconcile the original plan with Codex\'s review. Explicitly accept or reject material review points with short reasons, implement the best solution, and run proportionate tests. Keep changes scoped to the objective.',
  },
  {
    id: 'codex-code-review',
    title: 'Codex reviews the implementation',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent code and test review',
    instructions:
      'Review the current working-tree diff against the objective and acceptance criteria. Look for correctness, regressions, security, maintainability, missing tests, and incomplete requirements. Return prioritized findings with severity, file, line or symbol, evidence, and a concrete fix. Do not modify files.',
  },
  {
    id: 'claude-adjudicate-fix',
    title: 'Claude reviews findings and fixes',
    agent: 'claude',
    permission: 'workspace-write',
    purpose: 'Review adjudication and repair',
    instructions:
      'Evaluate every Codex finding. Mark it accepted, rejected-with-reason, or needs-user-decision. Fix all accepted findings, preserve unrelated user changes, and run the relevant verification commands.',
  },
  {
    id: 'codex-final-verification',
    title: 'Codex performs final verification',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Final independent quality gate',
    instructions:
      'Perform a final review of the resulting diff and reported verification. Respond PASS only if the objective is satisfied with no material unresolved issue. Otherwise provide only actionable blocking or high-confidence findings. Do not modify files.',
  },
  {
    id: 'claude-finalize',
    title: 'Claude finalizes the result',
    agent: 'claude',
    permission: 'workspace-write',
    purpose: 'Final synthesis and bounded repair',
    instructions:
      'Review Codex\'s final verification. Fix confirmed issues if any, run final checks, and produce the completion summary: outcome, changed files, verification performed, accepted/rejected findings, residual risks, and recommended follow-up. Do not expand scope.',
  },
];

const BRAINSTORMING: readonly WorkflowStageDefinition[] = [
  {
    id: 'claude-proposal',
    title: 'Claude develops the proposal',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Primary ideation',
    instructions:
      'Develop a concrete proposal with goals, constraints, alternatives, trade-offs, risks, and a recommended direction. Ground it in the repository when relevant. Do not modify files.',
  },
  {
    id: 'codex-challenge',
    title: 'Codex challenges the proposal',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent critique',
    instructions:
      'Challenge Claude\'s proposal. Test assumptions, surface failure modes and missing constraints, compare alternatives, and propose improvements. Be specific and evidence-driven. Do not modify files.',
  },
  {
    id: 'claude-synthesis',
    title: 'Claude synthesizes the strongest design',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Proposal reconciliation',
    instructions:
      'Review every Codex critique, accept or reject it with reasoning, and synthesize the strongest revised proposal. Include a decision matrix and measurable success criteria. Do not modify files.',
  },
  {
    id: 'codex-final-challenge',
    title: 'Codex performs the final challenge',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Final adversarial review',
    instructions:
      'Review the revised proposal for remaining contradictions, untested assumptions, operational risks, and avoidable complexity. Return PASS or a short list of material findings. Do not modify files.',
  },
  {
    id: 'claude-final-recommendation',
    title: 'Claude issues the final recommendation',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Final decision document',
    instructions:
      'Resolve the final Codex review and deliver the final recommendation, including rationale, rejected alternatives, phased execution plan, validation strategy, and explicit open questions. Do not modify files.',
  },
];

export function getWorkflow(kind: WorkflowKind): WorkflowStageDefinition[] {
  const source = kind === 'implementation' ? IMPLEMENTATION : BRAINSTORMING;
  return source.map((stage) => ({ ...stage }));
}
