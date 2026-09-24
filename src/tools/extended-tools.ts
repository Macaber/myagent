import * as fs from 'node:fs';
import { AgentTool, ToolExecutionContext } from './tool-registry.js';
import { TodoItem } from '../context/blackboard.js';
import { getSkillsDir } from '../config/paths.js';
import { withFileLock } from './file-lock.js';

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
    const globalSkillsDir = getSkillsDir();

    if (action === 'list') {
      const skillsDir = `${root}/.agent/skills`;
      const projectSkillsDir = `${root}/skills`;
      const foundSkills: string[] = ['analyst (built-in)', 'developer (built-in)', 'qa (built-in)'];

      for (const dir of [globalSkillsDir, skillsDir, projectSkillsDir]) {
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
    // Block path traversal (../../etc/passwd) — skill names are bare identifiers.
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Invalid skill name '${name}': must match /^[a-zA-Z0-9_-]+$/`);
    }
    const candidatePaths = [
      `${globalSkillsDir}/${name}/SKILL.md`,
      `${globalSkillsDir}/${name}.md`,
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
  description:
    'Ask the user a question to clarify ambiguous instructions, gather preferences, or request decisions. ' +
    'Blocks on elicitation when an ACP client is connected; otherwise records the question for later review.',
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
  async execute(params, context) {
    if (!params.question || typeof params.question !== 'string' || params.question.trim().length === 0) {
      throw new Error('question requires a non-empty question string');
    }
    const question = params.question.slice(0, 2000);
    if (context.requestElicitation) {
      const res = await context.requestElicitation({
        question,
        options: params.options,
        threadId: context.threadId,
        turnId: context.turnId,
      });
      const answer = res.answer ?? `[${res.action}]`;
      try {
        context.blackboard.set(`question_${Date.now()}`, { question, answer, action: res.action });
      } catch {}
      return `User response (${res.action}): ${answer}`;
    }
    // Headless fallback: record explicitly as UNANSWERED so the model
    // does not hallucinate a user reply.
    try {
      context.blackboard.set(`question_${Date.now()}`, { question, answer: null, action: 'unanswered' });
    } catch {}
    return `User Question Recorded (UNANSWERED — no ACP client connected): "${question}"${params.options ? ` Options: [${params.options.join(', ')}]` : ''}. Proceed with best judgement and note the assumption.`;
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
    if (!params.patch || typeof params.patch !== 'string') {
      throw new Error('patch requires a unified diff string');
    }
    if (params.patch.length > 256 * 1024) {
      throw new Error('patch exceeds 256KB limit');
    }
    const fullPath = context.workspaceJail.resolvePath(params.filePath);
    // Serialize writers per file (see file-lock.ts)
    return withFileLock(fullPath, async () => {
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Target file ${params.filePath} not found`);
    }

    const original = fs.readFileSync(fullPath, 'utf8').split('\n');
    const patchLines = params.patch.split('\n');
    interface Hunk {
      oldStart: number;
      oldLines: number;
      newLines: string[];
      removals: string[];
    }
    const hunks: Hunk[] = [];
    let i = 0;
    while (i < patchLines.length) {
      const line = patchLines[i];
      const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (m) {
        const oldStart = Number(m[1]);
        const oldLines = m[2] === undefined ? 1 : Number(m[2]);
        const hunk: Hunk = { oldStart, oldLines, newLines: [], removals: [] };
        i++;
        while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
          const h = patchLines[i];
          if (h === '' && i === patchLines.length - 1) {
            i++; // patch trailing newline — not a hunk line
            continue;
          }
          if (h.startsWith('---') || h.startsWith('+++')) {
            i++;
            continue;
          }
          const marker = h[0];
          const text = h.slice(1);
          if (marker === ' ') {
            hunk.newLines.push(text);
          } else if (h === '' && i !== patchLines.length - 1) {
            // Bare empty line inside a hunk = empty context line (not patch trailing newline)
            hunk.newLines.push('');
          } else if (marker === '-') {
            hunk.removals.push(text);
          } else if (marker === '+') {
            hunk.newLines.push(text);
          } else if (marker === '\\') {
            // "\ No newline at end of file" — ignore
          } else {
            throw new Error(`Invalid hunk line: '${h.slice(0, 60)}' (expected ' '/-/+/@@)`);
          }
          i++;
        }
        hunks.push(hunk);
        continue;
      }
      i++;
    }
    if (hunks.length === 0) {
      throw new Error('No @@ hunks found in patch — refusing to apply');
    }

    // Apply bottom-up so earlier line numbers stay valid
    const result = [...original];
    const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
    for (const h of sorted) {
      const idx = h.oldStart - 1; // 1-based to 0-based
      if (idx < 0 || idx + h.oldLines > result.length + (h.oldLines === 0 ? 1 : 0)) {
        throw new Error(`Hunk at line ${h.oldStart} out of range (file has ${result.length} lines)`);
      }
      const slice = result.slice(idx, idx + h.oldLines);
      let si = 0;
      for (const r of h.removals) {
        const found = slice.indexOf(r, si);
        if (found === -1) {
          throw new Error(
            `Hunk at line ${h.oldStart} does not match file: expected to remove '${r.slice(0, 80)}'`
          );
        }
        si = found + 1;
      }
      result.splice(idx, h.oldLines, ...h.newLines);
    }

    fs.writeFileSync(fullPath, result.join('\n'), 'utf8');

    const { randomUUID } = await import('node:crypto');
    context.blackboard.appendArtifact({
      artifactId: `art_${randomUUID().slice(0, 8)}`,
      filePath: params.filePath,
      action: 'MODIFY',
      diffContent: params.patch.slice(0, 8000),
    });

    return `Patch applied successfully to ${params.filePath} (${hunks.length} hunk(s)).`;
    });
  },
};
