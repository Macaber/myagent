import { ChatMessage } from '../provider/types.js';
import { Blackboard } from './blackboard.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { MemoryCompactor } from './memory-compactor.js';

export interface AssembleContextParams {
  threadPrompt: string;
  turnId: string;
  stage?: 'planning' | 'worker' | 'verification' | 'summary';
  currentMilestoneTitle?: string;
  currentMilestoneDescription?: string;
  blackboard: Blackboard;
  skillRegistry: SkillRegistry;
  recentMessages?: ChatMessage[];
  maxCharacters?: number;
}

export class DynamicContextAssembler {
  constructor(private readonly compactor: MemoryCompactor = new MemoryCompactor()) {}

  /**
   * Assembles context optimized for prefix caching and minimal token consumption.
   *
   * 1. Layer 1 (Static System Prefix): Role, core principles, safety, L1 skills.
   *    100% invariant across all tasks and steps -> Maximum prefix cache hits.
   * 2. Layer 2 (Milestone-Scoped Cache): Goal, current milestone, completed milestones, L2 skills.
   *    100% invariant across all ReAct steps within the same milestone.
   * 3. Layer 3 (Sliding Window Observations):
   *    Older tool outputs are masked to break O(N^2) token growth while keeping tool_call_id pairs intact.
   */
  public assemble(params: AssembleContextParams): ChatMessage[] {
    const sections: string[] = [];

    // ================= 1. Layer 1: Invariant System Prefix =================
    sections.push(
      `You are an expert software engineering assistant.
Operating Principles:
1. Conversational & Informational requests: If the user is greeting you (e.g. "你好", "hello"), asking a question, seeking clarification, or having a chat, answer DIRECTLY and politely in markdown. DO NOT call tools (especially do not run 'bash' or inspect files) for greetings or general questions.
2. Tool Selection & Safety:
   - For listing files or finding directory structure: ALWAYS use 'glob' with pattern '*' to view top-level files and directories (or 'src/*', 'tests/*' for subdirectories). 'glob' returns [DIR] and [FILE] markers directly in 1 step. NEVER use 'bash' (e.g. ls, find) to list files when 'glob' is available.
   - For searching text in codebase: ALWAYS use 'grep'.
   - For reading files: ALWAYS use 'read'.
   - For editing or creating files: Use 'edit' or 'write'.
   - 'bash' requires strict human approval: Reserve 'bash' ONLY for running build scripts (npm run build), test suites (npm test), git commands, or commands explicitly requested by the user.
3. Clarity and Conciseness: Provide direct, clear, and helpful answers.
4. Project Overview & Explanation Discipline: For questions asking about project purpose, architecture, or codebase overview: Inspecting 1-2 high-level files (such as README.md, package.json, or top-level directory listing) is SUFFICIENT. You MUST immediately synthesize and deliver the final answer once the main purpose and stack are identified. DO NOT recursively inspect or read implementation files line-by-line.`
    );

    // L1 Skills Index (Compact Overview - Static)
    const compactIndex = params.skillRegistry.getCompactIndex();
    sections.push(
      `=== AVAILABLE SKILLS (L1 Index) ===\n` +
      `${compactIndex}\n` +
      `Call 'skill' tool with skillName to inspect or activate detailed domain instructions.`
    );

    // ================= 2. Layer 2: Milestone Semi-Static Cache =================
    sections.push(
      `=== GOAL & MILESTONE ===\n` +
      `Global Task Goal: ${params.threadPrompt}\n` +
      (params.currentMilestoneTitle
        ? `Current Active Milestone: [${params.currentMilestoneTitle}] ${params.currentMilestoneDescription || ''}`
        : '')
    );

    // Completed Milestone Summaries (Compacted History)
    const summaries = params.blackboard.getMilestoneSummaries();
    if (summaries.length > 0) {
      const summaryList = summaries
        .map((s, idx) => `[Milestone ${idx + 1}: ${s.title}]\n${s.summary}`)
        .join('\n\n');

      sections.push(
        `=== COMPLETED MILESTONE SUMMARIES (Compacted History) ===\n` +
        `${summaryList}`
      );
    }

    // L2 Active Skills Guidelines (Turn-Scoped Full Directives)
    const activeSkills = params.skillRegistry.getActiveSkillsForTurn(params.turnId);
    if (activeSkills.length > 0) {
      const skillDirectives = activeSkills
        .map((s) => `[Skill Guideline: ${s.name}]\n${s.systemPrompt}`)
        .join('\n\n');

      sections.push(
        `=== ACTIVE SKILL DIRECTIVES (L2) ===\n` +
        `${skillDirectives}`
      );
    }

    // Workspace Delta Ledger (Artifacts)
    const artifacts = params.blackboard.getArtifacts();
    if (artifacts.length > 0) {
      const uniqueFiles = new Map<string, string>();
      for (const a of artifacts) {
        uniqueFiles.set(a.filePath, a.action);
      }
      const fileList = Array.from(uniqueFiles.entries())
        .map(([p, action]) => `- ${p} (${action})`)
        .join('\n');

      sections.push(
        `=== WORKSPACE DELTA (Modified Files) ===\n` +
        `${fileList}\n` +
        `Note: To inspect exact file contents, call 'read' with specific line ranges.`
      );
    }

    // TODO Checklist Progress
    const todos = params.blackboard.getTodos();
    if (todos.length > 0) {
      const todoList = todos
        .map((t) => `[${t.status.toUpperCase()}] ${t.content}`)
        .join('\n');

      sections.push(
        `=== CURRENT TODO CHECKLIST ===\n` +
        `${todoList}`
      );
    }

    // Soft Budget Warning (only injected when budget used exceeds 80% to avoid step-by-step cache bust)
    const budget = params.blackboard.getTokenBudgetStatus();
    if (budget.used > budget.total * 0.8) {
      sections.push(
        `⚠️ [BUDGET WARNING]: Consumed ${budget.used}/${budget.total} tokens (${budget.remaining} remaining). Conclude soon.`
      );
    }

    const systemPromptText = sections.join('\n\n');
    const systemMessage: ChatMessage = {
      role: 'system',
      content: systemPromptText,
    };

    // ================= 3. Layer 3: Ephemeral Messages & Sliding Window =================
    const recent = params.recentMessages || [];

    // Step A: Watermark check and macro-folding if context is very large
    const { messages: foldedMessages } = this.compactor.checkWatermarkAndFold(
      recent,
      params.maxCharacters ?? (Number(process.env.MAX_CONTEXT_CHARACTERS) || 48000),
      6
    );

    // Step B: Observation Masking - condense older tool outputs to eliminate O(N^2) token growth
    const maskedMessages = this.compactor.maskOldToolObservations(foldedMessages, 2);

    return [systemMessage, ...maskedMessages];
  }
}
