import { AgentTool } from './tool-registry.js';
import { TodoItem } from '../context/blackboard.js';

export interface PlanItem {
  id?: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanTaskParams {
  title: string;
  todos: PlanItem[];
  notes?: string;
}

export const planTaskTool: AgentTool<PlanTaskParams> = {
  name: 'plan_task',
  description:
    'Create or update a structured execution plan and todo checklist for complex multi-step coding tasks. Call this autonomously when a user task requires multiple sequential steps, refactoring, or test-driven development to track progress.',
  riskLevel: 'READ_ONLY',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title or objective of the execution plan' },
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Item ID (e.g. 1, 2, step_1)' },
            title: { type: 'string', description: 'Actionable step title or description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['title', 'status'],
        },
        description: 'Checklist of concrete steps',
      },
      notes: { type: 'string', description: 'Optional architectural notes or context' },
    },
    required: ['title', 'todos'],
  },
  async execute(params, context) {
    if (context.blackboard) {
      context.blackboard.set('execution_plan', {
        title: params.title,
        todos: params.todos,
        notes: params.notes,
        updatedAt: Date.now(),
      });

      const todoItems: TodoItem[] = params.todos.map((item, idx) => ({
        id: item.id || `step_${idx + 1}`,
        content: item.title,
        status: item.status,
      }));
      context.blackboard.updateTodos(todoItems);
    }

    const pending = params.todos.filter((t) => t.status === 'pending').length;
    const inProgress = params.todos.filter((t) => t.status === 'in_progress').length;
    const completed = params.todos.filter((t) => t.status === 'completed').length;

    return `Plan updated successfully: "${params.title}" (Completed: ${completed}, In Progress: ${inProgress}, Pending: ${pending}). Total steps: ${params.todos.length}.`;
  },
};
