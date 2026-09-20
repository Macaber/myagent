import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenAIProvider } from '../provider/openai-provider.js';
import { ChatMessage } from '../provider/types.js';
import { ExecutionPlan, Milestone } from './dag.js';
import { TurnContext } from '../runtime/turn-context.js';
import { ToolRegistry, ToolExecutionContext } from '../tools/tool-registry.js';

export interface PlannerConfig {
  defaultSkills?: string[];
}

export function isConversationalGoal(goal: string): boolean {
  if (!goal) return false;
  const trimmed = goal.trim().toLowerCase();

  const exactMatches = new Set([
    '你好', '您好', '嗨', '哈喽', '哈罗', '早', '早上好', '下午好', '晚上好',
    'hello', 'hi', 'hey', 'greetings', 'howdy', 'good morning', 'good afternoon', 'good evening',
    '你是谁', '你是谁？', 'who are you', 'who are you?',
    '你能做什么', '你能做什么？', '你能帮我做什么', 'what can you do', 'what can you do?',
    '介绍一下你自己', '介绍下你自己', '自我介绍', 'introduce yourself',
    '帮助', 'help', 'hi there', 'hello there', '谢谢', '多谢', '感谢', 'thanks', 'thank you',
    'ok', '好的', '收到', '明白'
  ]);

  if (exactMatches.has(trimmed)) return true;

  const clean = trimmed.replace(/[!！?？,，.~。\s]/g, '');
  if (exactMatches.has(clean)) return true;

  // Short greetings like "你好呀", "嗨~", "hello agent" (up to 15 chars)
  if (/^(你好|您好|哈喽|hello|hi|hey)[\s\S]{0,12}$/i.test(trimmed)) {
    // Avoid matching actual tasks like "hello, build project"
    if (!/(写|改|建|删|查|测|实现|run|build|create|write|delete|edit|fix|test|make)/i.test(trimmed)) {
      return true;
    }
  }

  return false;
}

export class Planner {
  constructor(
    private readonly provider?: OpenAIProvider,
    private readonly toolRegistry?: ToolRegistry
  ) {}

  public async createPlan(
    goal: string,
    turnContext: TurnContext,
    toolContext: ToolExecutionContext
  ): Promise<ExecutionPlan> {
    const step = turnContext.createStep({
      stepType: 'MODEL_CALL',
      metadata: { phase: 'goal_decomposition' },
    });

    // 0. Conversational Fast-Path: Greetings, pleasantries, who-are-you
    if (isConversationalGoal(goal)) {
      step.end({ status: 'SUCCESS' });
      const conversationalMilestone: Milestone = {
        id: 'ms_1',
        title: 'Direct Conversational Response',
        description: `Directly greet and respond to the user's message: "${goal}". Do NOT execute any tools (do not call bash, edit, or read). Respond politely, warmly, and helpfully in natural language.`,
        dependencies: [],
        assignedSkill: 'analyst',
        acceptanceCriteria: 'Direct conversational response provided to user',
        status: 'WAITING',
      };
      return new ExecutionPlan(goal, [conversationalMilestone]);
    }

    // 1. If provider is available, ask LLM for structured DAG
    if (this.provider) {
      try {
        turnContext.dispatcher?.emitSessionUpdate({
          sessionId: toolContext.threadId,
          updateType: 'agent_thought_chunk',
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Analyzing goal and preparing execution plan...\n' },
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Analyzing goal and preparing execution plan...\n' },
          },
          data: { text: 'Analyzing goal and preparing execution plan...\n' },
          timestamp: Date.now(),
        });

        const systemPrompt = `You are an expert software project planner.
Decompose the user's objective into a milestone DAG (Directed Acyclic Graph).
Each milestone MUST be concrete, sequentially ordered, and specify dependencies and acceptance criteria.
Available worker skills: "analyst", "developer", "qa".

PLANNING RULES:
1. For informational questions, explanations, directory inspection, or codebase inquiries: Create a SINGLE milestone (assignedSkill: "analyst"). Do NOT add implementation or QA milestones.
2. For simple single-step tasks (e.g. creating/deleting a file, minor single-file edits, running a specific script, or small localized edits): Create a SINGLE milestone (assignedSkill: "developer"). The developer can create, write, and verify within this single milestone. Do NOT create separate QA or verification milestones for simple file operations.
3. Only for complex multi-step feature implementations, major refactorings, or tasks explicitly requiring full test suite execution: Decompose into 2-3 logical milestones (e.g. implement, verify).
4. ACCEPTANCE CRITERIA FORMATTING:
   - For file creation or verification: Use format "file_exists: <path>" (e.g. "file_exists: hello.txt") or describe the condition in plain text. NEVER use "cmd: cat ..." to verify files!
   - For test/build execution: Use "cmd: <command>" where <command> MUST match the project's actual scripts (e.g. "cmd: npm test"). NEVER hallucinate uninstalled test runners (like vitest or jest) if not present in project scripts!
   - For reporting or query tasks: State acceptance criteria in plain text (e.g. "Test results reported").
5. Workers must prefer safe built-in tools (read, write, edit, glob, grep). Do NOT instruct workers to run shell commands (like cat, od, wc) for inspecting files when read/glob tools can do it.

Output ONLY valid JSON matching this schema:
{
  "goal": string,
  "milestones": [
    {
      "id": string (e.g. "ms_1"),
      "title": string,
      "description": string,
      "dependencies": string[] (array of milestone IDs that must complete first),
      "assignedSkill": "analyst" | "developer" | "qa",
      "acceptanceCriteria": string (e.g. "file_exists: hello.txt" or "cmd: npm test")
    }
  ]
}`;

        let userPromptContent = `Goal: ${goal}\nProject Root: ${toolContext.workspaceJail.getWorkspaceRoot()}`;
        try {
          const pkgPath = path.join(toolContext.workspaceJail.getWorkspaceRoot(), 'package.json');
          if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.scripts) {
              userPromptContent += `\nProject package.json scripts: ${JSON.stringify(pkg.scripts)}`;
            }
          }
        } catch {}

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPromptContent },
        ];

        const response = await this.provider.complete({
          messages,
          temperature: 0.1,
          abortSignal: toolContext.abortSignal,
        });

        step.end({
          status: 'SUCCESS',
          tokens: response.usage,
        });

        // Parse JSON from response
        const jsonMatch = response.content?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const milestones: Milestone[] = (parsed.milestones || []).map((m: any) => ({
            id: m.id,
            title: m.title,
            description: m.description,
            dependencies: m.dependencies || [],
            assignedSkill: m.assignedSkill || 'developer',
            acceptanceCriteria: m.acceptanceCriteria,
            status: 'WAITING',
          }));

          if (milestones.length > 0) {
            return new ExecutionPlan(goal, milestones);
          }
        }
      } catch (err: any) {
        step.end({ status: 'FAILED', errorMessage: err.message });
      }
    } else {
      step.end({ status: 'SUCCESS' });
    }

    // 2. Default fallback decomposition (for offline/testing or if LLM JSON fails)
    const fallbackMilestones: Milestone[] = [
      {
        id: 'ms_1',
        title: 'Inspect workspace and plan implementation',
        description: `Analyze current codebase structure relevant to: ${goal}`,
        dependencies: [],
        assignedSkill: 'analyst',
        acceptanceCriteria: 'Workspace inspected and files identified',
        status: 'WAITING',
      },
      {
        id: 'ms_2',
        title: 'Execute implementation changes',
        description: `Implement code modifications to accomplish: ${goal}`,
        dependencies: ['ms_1'],
        assignedSkill: 'developer',
        acceptanceCriteria: 'Required files created or updated',
        status: 'WAITING',
      },
      {
        id: 'ms_3',
        title: 'Verify deliverables and test acceptance',
        description: `Verify changes and ensure quality for: ${goal}`,
        dependencies: ['ms_2'],
        assignedSkill: 'qa',
        acceptanceCriteria: 'Acceptance verification confirmed',
        status: 'WAITING',
      },
    ];

    return new ExecutionPlan(goal, fallbackMilestones);
  }
}
