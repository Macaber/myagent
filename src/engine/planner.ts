import { OpenAIProvider } from '../provider/openai-provider.js';
import { ChatMessage } from '../provider/types.js';
import { ExecutionPlan, Milestone } from './dag.js';
import { TurnContext } from '../runtime/turn-context.js';
import { ToolRegistry, ToolExecutionContext } from '../tools/tool-registry.js';

export interface PlannerConfig {
  defaultSkills?: string[];
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

    // 1. If provider is available, ask LLM for structured DAG
    if (this.provider) {
      try {
        const systemPrompt = `You are an expert software project planner.
Decompose the user's objective into a milestone DAG (Directed Acyclic Graph).
Each milestone MUST be concrete, sequentially ordered, and specify dependencies and acceptance criteria.
Available worker skills: "analyst", "developer", "qa".

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
      "acceptanceCriteria": string (e.g. "cmd: npm test" or explicit file existence condition)
    }
  ]
}`;

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Goal: ${goal}\nProject Root: ${toolContext.workspaceJail.getWorkspaceRoot()}` },
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
