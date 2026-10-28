import type { AgentId, AgentSelection, WorkflowKind, WorkflowStageDefinition } from './types.js';

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
    review: true,
  },
  {
    id: 'claude-implement',
    title: 'Claude reconciles and implements',
    agent: 'claude',
    permission: 'workspace-write',
    purpose: 'Primary implementation',
    instructions:
      'Reconcile the original plan with Codex\'s review. Explicitly accept or reject material review points with short reasons, implement the best solution, and run proportionate tests. Keep changes scoped to the objective.',
    requiresApproval: true,
  },
  {
    id: 'codex-code-review',
    title: 'Codex reviews the implementation',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent code and test review',
    instructions:
      'Review the current working-tree diff against the objective and acceptance criteria. Look for correctness, regressions, security, maintainability, missing tests, and incomplete requirements. Return prioritized findings with severity, file, line or symbol, evidence, and a concrete fix. Do not modify files.',
    review: true,
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
      'Perform a final review of the resulting diff and the verification evidence. Pass only if the objective is satisfied with no material unresolved issue. Otherwise provide only actionable blocking or high-confidence findings. Do not modify files.',
    review: true,
    gate: true,
  },
  {
    id: 'claude-finalize',
    title: 'Claude finalizes the result',
    agent: 'claude',
    // Read-only so the files end exactly as the last verification judged them; fixes happen in fix rounds.
    permission: 'read-only',
    purpose: 'Final synthesis',
    instructions:
      'Produce the completion summary: outcome, changed files, verification performed, accepted and rejected findings, residual risks, and recommended follow-up. If the final verification still reports unresolved findings, list them plainly as unresolved. Do not modify files.',
  },
];

const BRAINSTORMING: readonly WorkflowStageDefinition[] = [
  {
    id: 'claude-proposal',
    context: 'lean',
    title: 'Claude develops the proposal',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Primary ideation',
    instructions:
      'Develop a concrete proposal with goals, constraints, alternatives, trade-offs, risks, and a recommended direction. Ground it in the repository when relevant. Do not modify files.',
  },
  {
    id: 'codex-challenge',
    context: 'lean',
    title: 'Codex challenges the proposal',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent critique',
    instructions:
      'Challenge Claude\'s proposal. Test assumptions, surface failure modes and missing constraints, compare alternatives, and propose improvements. Be specific and evidence-driven. Do not modify files.',
    review: true,
  },
  {
    id: 'claude-synthesis',
    context: 'lean',
    title: 'Claude synthesizes the strongest design',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Proposal reconciliation',
    instructions:
      'Review every Codex critique, accept or reject it with reasoning, and synthesize the strongest revised proposal. Include a decision matrix and measurable success criteria. Do not modify files.',
  },
  {
    id: 'codex-final-challenge',
    context: 'lean',
    title: 'Codex performs the final challenge',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Final adversarial review',
    instructions:
      'Review the revised proposal for remaining contradictions, untested assumptions, operational risks, and avoidable complexity. Pass it, or return a short list of material findings. Do not modify files.',
    review: true,
  },
  {
    id: 'claude-final-recommendation',
    context: 'lean',
    title: 'Claude issues the final recommendation',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Final decision document',
    instructions:
      'Resolve the final Codex review and deliver the final recommendation, including rationale, rejected alternatives, phased execution plan, validation strategy, and explicit open questions. Do not modify files.',
  },
];

/** One chat message: Claude answers, and Codex checks the answer before the user relies on it. */
const CHAT: readonly WorkflowStageDefinition[] = [
  {
    id: 'claude-answer',
    context: 'lean',
    title: 'Claude answers',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Primary answer',
    instructions:
      'Answer the user\'s latest message directly and completely, in the context of the conversation. Read the files and attachments you need instead of guessing, cite paths and symbols, and say plainly what you could not verify. Do not modify files.',
  },
  {
    id: 'codex-check',
    context: 'lean',
    title: 'Codex checks the answer',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent answer check',
    instructions:
      'Check Claude\'s answer to the user\'s latest message against the repository, the attachments, and the conversation. Verify its factual claims, code references, and reasoning yourself rather than trusting them. Pass it when it is correct and complete enough to act on. Fail it only for material errors, omissions, or risks, each with evidence and a concrete correction. Do not restate a correct answer. Do not modify files.',
    review: true,
    onFail: 'revise',
  },
];

/**
 * A greeting or a question about the assistant itself: one quick reply from the product description, with no
 * workspace and no check, because there is nothing in it to verify.
 */
const INTRO: readonly WorkflowStageDefinition[] = [
  {
    id: 'claude-intro',
    context: 'none',
    title: 'Claude answers',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Quick reply',
    instructions:
      'The user is greeting you, thanking you, or asking who you are or what you can do. Reply as the Claude and Codex pair ("we"), from the "About Dual Agent" section: warmly, briefly, and only with what fits the question. End by asking what they would like to work on. Do not read files or use tools.',
  },
];

export function introWorkflow(): WorkflowStageDefinition[] {
  return INTRO.map((stage) => ({ ...stage }));
}

/** One requested change: Claude edits, Codex reviews the diff, and fix rounds follow a failed review. */
const EDIT: readonly WorkflowStageDefinition[] = [
  {
    id: 'claude-edit',
    title: 'Claude makes the change',
    agent: 'claude',
    permission: 'workspace-write',
    purpose: 'Primary implementation',
    instructions:
      'Make the change the user asked for in their latest message, correctly the first time. Before editing, read the code you will change, its callers, and its existing tests, and follow the project\'s conventions. Handle edge cases and errors the way the surrounding code does, add or update tests for the new behavior, keep the change scoped to the request, and preserve unrelated work. If you can run the project\'s checks, run them and fix any failure before you finish. End with a short summary of what you changed and why, and of any check you could not run.',
  },
  {
    id: 'codex-change-review',
    title: 'Codex reviews the change',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent change review',
    instructions:
      'Review the current diff against the user\'s latest message and the conversation. Look for incorrect behavior, regressions, security problems, and missing pieces, and use the orchestrator-run checks as evidence. Pass only if the change does what was asked with no material problem. Otherwise list actionable findings with severity, location, evidence, and a concrete fix. Do not modify files.',
    review: true,
    gate: true,
  },
];

/** Asks for the cited works in a form the chat can export as BibTeX or RIS. */
export const SOURCES_BLOCK =
  'After the numbered source list, add a fenced code block whose info string is sources, containing a JSON array of the cited works in the same order, each an object with title, authors (an array of names), year, venue, doi (only when the work has one), and url.';

/**
 * One research question: Claude researches with the web and the workspace, and Codex independently opens
 * every cited source and looks for what was missed before the user relies on the findings.
 */
const RESEARCH: readonly WorkflowStageDefinition[] = [
  {
    id: 'claude-research',
    context: 'lean',
    web: true,
    title: 'Claude researches',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Primary research',
    instructions: [
      'Research the user\'s latest message using the web, the attachments, and the workspace.',
      'Prefer primary and authoritative sources: peer-reviewed papers, official documentation, standards, and original data, with preprints marked as such. Read a source before you cite it; never cite from a search snippet or from memory.',
      'Cite every factual claim inline as [n], and end with a numbered source list giving each source\'s title, authors or publisher, year, and URL.',
      'Separate what is established, what is contested, and what is unknown, and give your confidence in each conclusion. When the question is about research gaps, map what has been done, with sources; what has not been done or not been replicated; why each gap matters; and how it could be studied.',
      'When the question concerns research gaps or a body of literature, include a gap matrix: a Markdown table with one row per key work and columns for problem, method, data, main result, and limitation, followed by the open gaps it reveals.',
      SOURCES_BLOCK,
      'Reason step by step before concluding, check your arithmetic and logic, and say plainly where the evidence is thin. Do not modify files.',
    ].join(' '),
  },
  {
    id: 'codex-source-check',
    context: 'lean',
    web: true,
    title: 'Codex verifies the sources',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent source and reasoning check',
    instructions: [
      'Verify Claude\'s research independently. Open each cited source and confirm that it exists, is attributed correctly, and actually supports the claim it is cited for; flag invented, misattributed, outdated, or retracted sources.',
      'Begin with a claim table: a Markdown table with columns #, Claim, Source, Verdict, and Note, one row per material claim, where Verdict is supported, partly supported, or unsupported.',
      'For every DOI, confirm it resolves to the cited work, and check whether the work has been retracted or corrected; a retracted source is a high-severity finding.',
      'Search for important work Claude missed and for evidence against its conclusions, and check the reasoning, numbers, and stated confidence.',
      'Pass only if every material claim is supported by a real source and no important counter-evidence or work is missing. Otherwise list each problem with its evidence and a correction. Do not modify files.',
    ].join(' '),
    review: true,
    onFail: 'revise',
  },
];

/**
 * A second opinion: both agents answer the same message without seeing each other's answer, and Claude
 * merges them into the best answer, saying where they differed and which was right.
 */
const COMPARE: readonly WorkflowStageDefinition[] = [
  { ...CHAT[0]!, title: 'Claude answers independently' },
  {
    id: 'codex-answer',
    context: 'lean',
    blind: true,
    title: 'Codex answers independently',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent second answer',
    instructions:
      'Answer the user\'s latest message yourself, directly and completely, in the context of the conversation. Another agent is answering separately; you will not see its answer and should not try to guess it. Read the files and attachments you need instead of guessing, cite paths and symbols, and say plainly what you could not verify. Do not modify files.',
  },
  {
    id: 'claude-merge',
    context: 'lean',
    title: 'Claude merges the two answers',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Merged answer',
    instructions:
      'Two independent answers to the user\'s latest message are above: yours and Codex\'s. Compare them claim by claim, and check the files or sources yourself wherever they disagree. Give the user one best answer, then a short "Where we differed" list naming, for each point, which answer was right and the evidence. Do not modify files.',
  },
];

/**
 * Test first: Codex writes tests that fail until the requested behavior exists, Claude makes them pass without
 * weakening them, and Codex reviews the tests and the code together as the gate.
 */
const TDD: readonly WorkflowStageDefinition[] = [
  {
    id: 'codex-tests',
    title: 'Codex writes failing tests',
    agent: 'codex',
    permission: 'workspace-write',
    purpose: 'Executable specification',
    instructions:
      'Write tests for the behavior the user asked for in their latest message, before any implementation exists. Read the code involved and its existing tests first, and follow their framework and conventions. Each test must fail now for the right reason and pass once the behavior is implemented; cover the main case, edge cases, and errors. Change only test files: do not implement the behavior. End with the tests you wrote and why each currently fails.',
    expectFailingChecks: true,
  },
  {
    id: 'claude-tdd-implement',
    title: 'Claude makes the tests pass',
    agent: 'claude',
    permission: 'workspace-write',
    purpose: 'Implementation against the tests',
    instructions:
      'Implement the behavior the user asked for so that Codex\'s new tests pass, following the project\'s conventions and keeping the change scoped. Do not weaken, skip, or delete any test; if a test is genuinely wrong, fix only that test and say why. Run the checks and finish only when they pass, then summarize what you implemented.',
  },
  {
    id: 'codex-tdd-review',
    title: 'Codex reviews the tests and the code',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent review of tests and implementation',
    instructions:
      'Review the tests and the implementation together against the user\'s latest message, using the orchestrator-run checks as evidence. Confirm the tests capture what was asked, were not weakened after they were written, and that the implementation is correct and scoped. Pass only if both hold; otherwise list actionable findings with severity, location, evidence, and a concrete fix. Do not modify files.',
    review: true,
    gate: true,
  },
];

/**
 * Agent mode: Claude works in the folder the way it does in a terminal, running commands, installing tools,
 * and editing files, with each command or edit it does not judge read-only approved by the user. Codex then
 * checks the outcome without changing anything.
 */
const AGENT: readonly WorkflowStageDefinition[] = [
  {
    id: 'claude-agent',
    title: 'Claude works on it',
    agent: 'claude',
    permission: 'agent',
    purpose: 'Hands-on task',
    instructions:
      'Do what the user asked in their latest message, the way you would in a terminal session: inspect the environment, run commands, install what is needed, and edit files. Commands and edits you do not judge read-only ask the user first; if they decline one, find another way or explain what you need. Prefer commands that work on this operating system. Confirm the result yourself, for example by running the tool again after installing it. End with what you did, the commands you ran and their results, and anything left for the user.',
  },
  {
    id: 'codex-agent-check',
    context: 'lean',
    title: 'Codex checks the result',
    agent: 'codex',
    permission: 'read-only',
    purpose: 'Independent check of the outcome',
    instructions:
      'Check whether the user\'s latest request was actually achieved. The evidence trail lists what Claude ran and what each command returned, and the diff shows any file changes. Verify the outcome yourself where you can without changing anything, for example by running read-only commands such as a version check, and look for anything unsafe or left half done. Pass if the request was achieved safely; otherwise list what is missing or wrong, with evidence and the next step. Do not modify files.',
    review: true,
    onFail: 'revise',
  },
];

const WORKFLOWS: Record<WorkflowKind, readonly WorkflowStageDefinition[]> = {
  implementation: IMPLEMENTATION,
  brainstorming: BRAINSTORMING,
  chat: CHAT,
  edit: EDIT,
  research: RESEARCH,
  compare: COMPARE,
  tdd: TDD,
  agent: AGENT,
};

/** One agent working alone: the leading stages of each workflow, with nothing that needs a second agent. */
const SOLO: Record<WorkflowKind, readonly WorkflowStageDefinition[]> = {
  agent: [AGENT[0]!],
  chat: [CHAT[0]!],
  compare: [CHAT[0]!],
  research: [RESEARCH[0]!],
  edit: [EDIT[0]!],
  brainstorming: [
    {
      id: 'claude-brainstorm',
      context: 'lean',
      title: 'Claude brainstorms and recommends',
      agent: 'claude',
      permission: 'read-only',
      purpose: 'Proposal, self-critique, and recommendation',
      instructions:
        'Develop a concrete proposal with goals, constraints, alternatives, trade-offs, and risks. Then challenge it yourself: state the strongest objections and failure modes, and revise where they hold. Finish with a recommendation, a decision matrix, measurable success criteria, a phased plan, and open questions. Do not modify files.',
    },
  ],
  implementation: [
    IMPLEMENTATION[0]!,
    {
      ...IMPLEMENTATION[2]!,
      title: 'Claude implements the plan',
      instructions:
        'Implement the plan, adjusting it where the code shows a better way and saying why. Keep the changes scoped to the objective, follow the project\'s conventions, add or update tests, and run the relevant verification commands before finishing.',
    },
    IMPLEMENTATION[6]!,
  ],
  tdd: [
    { ...TDD[0]!, agent: 'claude', title: 'Claude writes failing tests' },
    { ...TDD[1]!, instructions: 'Implement the behavior the user asked for so that the new tests pass, following the project\'s conventions and keeping the change scoped. Do not weaken, skip, or delete any test; if a test is genuinely wrong, fix only that test and say why. Run the checks and finish only when they pass, then summarize what you implemented.' },
  ],
};

export function getWorkflow(kind: WorkflowKind, agents: AgentSelection = 'claude-codex'): WorkflowStageDefinition[] {
  const solo = agents === 'claude' || agents === 'codex';
  return (solo ? SOLO : WORKFLOWS)[kind].map((stage) => arrangeStage(stage, agents));
}

const OTHER: Record<AgentId, AgentId> = { claude: 'codex', codex: 'claude' };

/** Exchanges the agents' names in text written for the usual roles, keeping each word's case. */
function swapNames(text: string): string {
  return text.replace(/\b(Claude|Codex|claude|codex)\b/g, (name) =>
    ({ Claude: 'Codex', Codex: 'Claude', claude: 'codex', codex: 'claude' })[name] ?? name,
  );
}

/**
 * Fits a stage written for the usual roles (Claude leads, Codex checks) to the chosen agents: with Codex leading
 * the agents and their names are exchanged, and an agent working alone takes every stage. Stage IDs name the
 * role, not the agent, so they stay as they are.
 */
export function arrangeStage(stage: WorkflowStageDefinition, agents: AgentSelection = 'claude-codex'): WorkflowStageDefinition {
  const copy = { ...stage };
  const runs = agents === 'claude' || agents === 'codex' ? agents : agents === 'codex-claude' ? OTHER[stage.agent] : stage.agent;
  if (runs === stage.agent) return copy;
  return { ...copy, agent: runs, title: swapNames(copy.title), purpose: swapNames(copy.purpose), instructions: swapNames(copy.instructions) };
}

/** The single stage a failed check adds: Claude weighs Codex's findings and gives the final answer. */
export function reviseStage(reason: string, kind: WorkflowKind = 'chat'): WorkflowStageDefinition {
  if (kind === 'agent') {
    return {
      id: 'claude-revise',
      title: 'Claude finishes the task',
      agent: 'claude',
      permission: 'agent',
      purpose: 'Follow-up on the check',
      instructions: `Codex's check found the task unfinished (${reason}). Weigh each finding against what you can see now, fix what holds with the same care (commands and edits still ask the user first), confirm the result, and tell the user briefly what changed and why you set aside any finding that does not hold.`,
    };
  }
  const research = kind === 'research';
  return {
    id: 'claude-revise',
    context: 'lean',
    ...(research ? { web: true } : {}),
    title: research ? 'Claude revises the research' : 'Claude revises the answer',
    agent: 'claude',
    permission: 'read-only',
    purpose: 'Answer revision',
    instructions: research
      ? `Codex's check did not pass (${reason}). Check each of its findings against the sources themselves, opening them again where needed. Then give the user the complete, corrected research: keep only sources you have confirmed support their claims, replace or remove the rest, add the important work that was missing, and adjust your conclusions and confidence. Mention the check in at most one short line. ${SOURCES_BLOCK} Do not modify files.`
      : `Codex's check did not pass (${reason}). Weigh each of its findings against the evidence, reading files again where needed. Then give the user your complete, corrected answer to their latest message: rely on findings that hold, and say briefly why you set aside any that do not. Mention the check in at most one short line. Do not modify files.`,
  };
}

/**
 * A repair stage added once when the checks fail right after an editing stage, so Codex reviews working code
 * rather than spending its review on failures the checks already found.
 */
export function repairStage(stage: string): WorkflowStageDefinition {
  return {
    id: 'claude-repair',
    title: 'Claude fixes the failing checks',
    agent: 'claude',
    permission: 'workspace-write',
    purpose: 'Repair before review',
    instructions: `The orchestrator-run checks failed after "${stage}". Read the failing output, find the cause in the code you changed, and fix it without weakening or deleting the tests. Keep the change scoped to the request, and say what the failure was and how you fixed it.`,
  };
}

/** The two stages a failed final gate adds: a Claude fix, then a fresh Codex verification of the result. */
export function fixRoundStages(round: number, reason: string): WorkflowStageDefinition[] {
  return [
    {
      id: `claude-fix-round-${round}`,
      title: `Claude fixes verification findings (round ${round})`,
      agent: 'claude',
      permission: 'workspace-write',
      purpose: 'Bounded repair of final findings',
      instructions: `The final gate did not pass (${reason}). Evaluate each unresolved finding from the latest verification and every failing orchestrator-run check. Fix each finding you accept, state why you reject any other, and keep the changes scoped to the objective.`,
      round,
    },
    {
      id: `codex-reverification-round-${round}`,
      title: `Codex re-verifies the result (round ${round})`,
      agent: 'codex',
      permission: 'read-only',
      purpose: 'Repeat of the final independent quality gate',
      instructions:
        'Verify the current diff again after Claude\'s fixes, using the orchestrator-run checks as evidence. Pass only if the objective is satisfied with no material unresolved issue. Otherwise list only the findings that still block. Do not modify files.',
      review: true,
      gate: true,
      round,
    },
  ];
}
