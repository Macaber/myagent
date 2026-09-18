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
   * Assembles the on-demand minimal context for the current step.
   * Core principle: Provide only what the model truly needs for the current decision,
   * keeping prompt size small, anchored to the top goal, and free of redundant clutter.
   */
  public assemble(params: AssembleContextParams): ChatMessage[] {
    const sections: string[] = [];

    // 1. Role & Operating Discipline
    sections.push(
      `You are an expert autonomous software engineering agent. Operate with precision, verify all changes, and follow high software engineering standards.`
    );

    // 2. Goal & Budget Invariant Anchor
    const budget = params.blackboard.getTokenBudgetStatus();
    sections.push(
      `=== GOAL & BUDGET ANCHOR ===\n` +
      `Global Task Goal: ${params.threadPrompt}\n` +
      (params.currentMilestoneTitle
        ? `Current Active Milestone: [${params.currentMilestoneTitle}] ${params.currentMilestoneDescription || ''}\n`
        : '') +
      `Token Budget: ${budget.used} used / ${budget.total} total (${budget.remaining} remaining)`
    );

    // 3. Workspace Delta Ledger (Artifacts)
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

    // 4. Completed Milestone Summaries (Compacted History)
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

    // 5. L1 Skills Index (Compact Overview)
    const compactIndex = params.skillRegistry.getCompactIndex();
    sections.push(
      `=== AVAILABLE SKILLS (L1 Index) ===\n` +
      `${compactIndex}\n` +
      `Call 'skill' tool with skillName to inspect or activate detailed domain instructions.`
    );

    // 6. L2 Active Skills Guidelines (Turn-Scoped Full Directives)
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

    // 7. TODO Checklist Progress
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

    // Build Master System Prompt
    const systemPromptText = sections.join('\n\n');
    const systemMessage: ChatMessage = {
      role: 'system',
      content: systemPromptText,
    };

    // 8. Filter and Fold Recent Messages through Watermark
    const recent = params.recentMessages || [];
    const { messages: foldedMessages } = this.compactor.checkWatermarkAndFold(
      recent,
      params.maxCharacters ?? 24000,
      6
    );

    return [systemMessage, ...foldedMessages];
  }
}
