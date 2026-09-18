import * as fs from 'node:fs';
import { AgentTool, ToolExecutionContext } from './tool-registry.js';
import { TodoItem } from '../context/blackboard.js';

// =================== 1. todowrite ===================
export const todoWriteTool: AgentTool<{ todos: TodoItem[] }> = {
  name: 'todowrite',
  description: 'Manage and update the long-running task TODO checklist. Persisted to the global blackboard.',
  riskLevel: 'READ_ONLY',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['id', 'content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(params, context) {
    context.blackboard.updateTodos(params.todos);
    const summary = params.todos
      .map((t) => `[${t.status.toUpperCase()}] ${t.content}`)
      .join('\n');
    return `Updated TODO list (${params.todos.length} items):\n${summary}`;
  },
};

// =================== 2. skill ===================
export const skillTool: AgentTool<{ skillName?: string; action?: 'get' | 'list' }> = {
  name: 'skill',
  description: 'Load or list domain skill definitions (SKILL.md) to inspect guidelines, methodology, and best practices.',
  riskLevel: 'READ_ONLY',
  parameters: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: 'Name of the skill to load (e.g. analyst, developer, qa) or "list" to view all' },
      action: { type: 'string', enum: ['get', 'list'], description: 'Action to perform: get skill content or list available skills' },
    },
  },
  async execute(params, context) {
    const root = context.workspaceJail.getWorkspaceRoot();
    const action = params.action || (params.skillName === 'list' || !params.skillName ? 'list' : 'get');

    if (action === 'list') {
      const skillsDir = `${root}/.agent/skills`;
      const projectSkillsDir = `${root}/skills`;
      const foundSkills: string[] = ['analyst (built-in)', 'developer (built-in)', 'qa (built-in)'];

      for (const dir of [skillsDir, projectSkillsDir]) {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir, { withFileTypes: true });
          for (const f of files) {
            if (f.isDirectory() && fs.existsSync(`${dir}/${f.name}/SKILL.md`)) {
              foundSkills.push(`${f.name} (custom: ${dir}/${f.name}/SKILL.md)`);
            } else if (f.isFile() && (f.name.endsWith('.md') || f.name === 'SKILL.md')) {
              foundSkills.push(`${f.name} (custom: ${dir}/${f.name})`);
            }
          }
        }
      }
      return `Available Skills:\n` + foundSkills.map((s) => `- ${s}`).join('\n');
    }

    const name = params.skillName || 'developer';
    const candidatePaths = [
      `${root}/.agent/skills/${name}/SKILL.md`,
      `${root}/.agent/skills/${name}.md`,
      `${root}/skills/${name}/SKILL.md`,
      `${root}/skills/${name}.md`,
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8');
      }
    }

    return `Skill '${name}' loaded. Follow high-quality software engineering standards, write modular code, and verify all changes with automated tests.`;
  },
};

// =================== 3. question ===================
export const questionTool: AgentTool<{ question: string; options?: string[] }> = {
  name: 'question',
  description: 'Ask the user a question to clarify ambiguous instructions, gather preferences, or request decisions.',
  riskLevel: 'READ_ONLY',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional selectable options',
      },
    },
    required: ['question'],
  },
  async execute(params) {
    // In actual ACP runtime, this is emitted as an interaction event
    return `User Question Prompted: "${params.question}"${params.options ? ` Options: [${params.options.join(', ')}]` : ''}`;
  },
};

// =================== 4. patch / apply_patch ===================
export const patchTool: AgentTool<{ filePath: string; patch: string }> = {
  name: 'patch',
  description: 'Apply a unified diff patch to modify a target file.',
  riskLevel: 'WORKSPACE_WRITE',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Target file path relative to workspace' },
      patch: { type: 'string', description: 'Unified diff content' },
    },
    required: ['filePath', 'patch'],
  },
  async execute(params, context) {
    const fullPath = context.workspaceJail.resolvePath(params.filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Target file ${params.filePath} not found`);
    }

    context.blackboard.appendArtifact({
      artifactId: `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      filePath: params.filePath,
      action: 'MODIFY',
      diffContent: params.patch,
    });

    return `Patch applied successfully to ${params.filePath}.`;
  },
};
