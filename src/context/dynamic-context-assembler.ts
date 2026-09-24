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

  private static readonly LAYER1_PREFIX = `You are an expert software engineering assistant.
Operating Principles:
1. Conversational & Informational requests: If the user is greeting you (e.g. "你好", "hello"), asking a question, seeking clarification, or having a chat, answer DIRECTLY and politely in markdown. DO NOT call tools (especially do not run 'bash' or inspect files) for greetings or general questions.
2. Tool Selection & Safety:
   - For listing files or finding directory structure: ALWAYS use 'glob' with pattern '*' to view top-level files and directories (or 'src/*', 'tests/*' for subdirectories). 'glob' returns [DIR] and [FILE] markers directly in 1 step. NEVER use 'bash' (e.g. ls, find) to list files when 'glob' is available.
   - For searching text in codebase: ALWAYS use 'grep'.
   - For reading files: ALWAYS use 'read'.
   - For editing or creating files: Use 'edit' or 'write'.
   - 'bash' requires strict human approval: Reserve 'bash' ONLY for running build scripts (npm run build), test suites (npm test), git commands, or commands explicitly requested by the user.
3. Clarity and Conciseness: Provide direct, clear, and helpful answers.
4. Project Overview & Explanation Discipline: For questions asking about project purpose, architecture, or codebase overview: Inspecting 1-2 high-level files (such as README.md, package.json, or top-level directory listing) is SUFFICIENT. You MUST immediately synthesize and deliver the final answer once the main purpose and stack are identified. DO NOT recursively inspect or read implementation files line-by-line.`;

  private cachedMaxChars?: number;

  // L2 memoization: milestone-scoped sections are invariant across ReAct steps
  // until the blackboard changes. Keyed by turn + blackboard version.
  private readonly l2Cache = new Map<string, string[]>();
  private static readonly L2_CACHE_MAX = 100;

  private resolveMaxChars(override?: number): number {
    if (override !== undefined) return override;
    if (this.cachedMaxChars === undefined) {
      this.cachedMaxChars = Number(process.env.MAX_CONTEXT_CHARACTERS) || 48000;
    }
    return this.cachedMaxChars;
  }

  private l2Key(params: AssembleContextParams): string {
    const skillNames = params.skillRegistry
      .getActiveSkillsForTurn(params.turnId)
      .map((s) => s.name)
      .sort()
      .join(',');
    let h = 0x811c9dc5;
    const feed = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    };
    feed(params.threadPrompt);
    feed(params.currentMilestoneTitle || '');
    feed(params.currentMilestoneDescription || '');
    return [
      params.turnId,
      params.blackboard.getVersion(),
      (h >>> 0).toString(16),
      skillNames,
    ].join('|');
  }

  private buildL2(params: AssembleContextParams): string[] {
    const sections: string[] = [];
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

    // Workspace Delta Ledger (paths + actions only — never pull diff_content on the hot path)
    const ledger = params.blackboard.getFileLedger();
    if (ledger.length > 0) {
      const fileList = ledger.map(({ filePath, action }) => `- ${filePath} (${action})`).join('\n');

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

    return sections;
  }
  private l2Cached(params: AssembleContextParams): string[] {
    const key = this.l2Key(params);
    const hit = this.l2Cache.get(key);
    if (hit) {
      // Refresh recency
      this.l2Cache.delete(key);
      this.l2Cache.set(key, hit);
      return hit;
    }
    const sections = this.buildL2(params);
    this.l2Cache.set(key, sections);
    if (this.l2Cache.size > DynamicContextAssembler.L2_CACHE_MAX) {
      const oldest = this.l2Cache.keys().next().value;
      if (oldest !== undefined) this.l2Cache.delete(oldest);
    }
    return sections;
  }

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
    // Module-level constant: no per-step rebuild, stable prefix-cache key.
    sections.push(DynamicContextAssembler.LAYER1_PREFIX);

    // L1 Skills Index (Compact Overview - Static)
    const compactIndex = params.skillRegistry.getCompactIndex();
    sections.push(
      `=== AVAILABLE SKILLS (L1 Index) ===\n` +
      `${compactIndex}\n` +
      `Call 'skill' tool with skillName to inspect or activate detailed domain instructions.`
    );

    // L2 sections come from the milestone-scoped memoization cache
    sections.push(...this.l2Cached(params));

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
      this.resolveMaxChars(params.maxCharacters),
      6
    );

    // Step B: Observation Masking - condense older tool outputs to eliminate O(N^2) token growth
    const maskedMessages = this.compactor.maskOldToolObservations(foldedMessages, 2);

    return [systemMessage, ...maskedMessages];
  }
}
