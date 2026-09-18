import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  filePath?: string;
  version?: string;
}

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  private activeWatchers: fs.FSWatcher[] = [];

  private activeTurnSkills = new Map<string, Set<string>>();

  constructor() {
    this.registerBuiltinSkills();
  }

  public registerSkill(skill: SkillDefinition): void {
    this.skills.set(skill.id, skill);
  }

  public unregisterSkill(id: string): boolean {
    return this.skills.delete(id);
  }

  public hasSkill(id: string): boolean {
    return this.skills.has(id);
  }

  public getSkill(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  public listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * L1 Compact Index: Generates an ultra-compact summary of available skills
   * to provide global capability awareness with minimal token overhead (<100 tokens).
   */
  public getCompactIndex(): string {
    const list = this.listSkills();
    if (list.length === 0) return 'None';
    return list.map((s) => `- [${s.id}] ${s.name}: ${s.description}`).join('\n');
  }

  /**
   * Activate a skill for a specific turn (L2 Full Guideline loading).
   */
  public activateSkillForTurn(turnId: string, skillId: string): SkillDefinition | undefined {
    const skill = this.getSkill(skillId);
    if (!skill) return undefined;

    let set = this.activeTurnSkills.get(turnId);
    if (!set) {
      set = new Set();
      this.activeTurnSkills.set(turnId, set);
    }
    set.add(skill.id);
    return skill;
  }

  /**
   * Get all active L2 skills for a specific turn.
   */
  public getActiveSkillsForTurn(turnId: string): SkillDefinition[] {
    const set = this.activeTurnSkills.get(turnId);
    if (!set || set.size === 0) return [];
    const res: SkillDefinition[] = [];
    for (const id of set) {
      const s = this.getSkill(id);
      if (s) res.push(s);
    }
    return res;
  }

  /**
   * Unload all L2 skills for a turn upon turn or milestone completion.
   */
  public clearTurnSkills(turnId: string): void {
    this.activeTurnSkills.delete(turnId);
  }

  /**
   * Parse a SKILL.md document content into a SkillDefinition.
   * Supports YAML frontmatter (--- ... ---) and standard markdown headings.
   */
  public parseSkillMarkdown(content: string, fallbackId: string, filePath?: string): SkillDefinition {
    let name = fallbackId;
    let description = '';
    let allowedTools: string[] = ['read', 'grep', 'glob'];
    let systemPrompt = content.trim();

    // Check for YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (frontmatterMatch) {
      const frontmatterText = frontmatterMatch[1];
      systemPrompt = frontmatterMatch[2].trim();

      for (const line of frontmatterText.split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;
        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const rawVal = line.slice(colonIndex + 1).trim();

        if (key === 'name' || key === 'id') {
          name = rawVal.replace(/^['"]|['"]$/g, '');
        } else if (key === 'description') {
          description = rawVal.replace(/^['"]|['"]$/g, '');
        } else if (key === 'allowedtools' || key === 'tools') {
          const clean = rawVal.replace(/^\[|\]$/g, '');
          allowedTools = clean.split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        }
      }
    } else {
      // Fallback markdown parsing: Look for # Skill Title and > description
      const titleMatch = content.match(/^#\s+(.+)$/m);
      if (titleMatch) {
        name = titleMatch[1].trim();
      }
      const descMatch = content.match(/^>\s*(.+)$/m);
      if (descMatch) {
        description = descMatch[1].trim();
      }
      const toolsMatch = content.match(/##\s*Allowed Tools\s*[\r\n]+([^\r\n#]+)/i);
      if (toolsMatch) {
        allowedTools = toolsMatch[1]
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }

    const id = (name || fallbackId).toLowerCase().replace(/[^a-z0-9_-]/g, '_');

    return {
      id,
      name: name || fallbackId,
      description: description || `Domain skill for ${name}`,
      systemPrompt: systemPrompt || `Follow domain instructions for ${name}`,
      allowedTools: allowedTools.length > 0 ? allowedTools : ['read', 'grep', 'glob'],
      filePath,
    };
  }

  /**
   * Load a single skill from a file path.
   */
  public async loadSkillFromFile(filePath: string): Promise<SkillDefinition> {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const fallbackId = path.basename(path.dirname(filePath)) || path.basename(filePath, path.extname(filePath));
    const skill = this.parseSkillMarkdown(content, fallbackId, filePath);
    this.registerSkill(skill);
    return skill;
  }

  /**
   * Recursively scan a directory for SKILL.md and *.skill.md files, dynamically registering them.
   */
  public async loadSkillsFromDirectory(dirPath: string): Promise<SkillDefinition[]> {
    if (!fs.existsSync(dirPath)) {
      return [];
    }

    const loaded: SkillDefinition[] = [];

    const scan = async (currentDir: string) => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          const skillMd = path.join(fullPath, 'SKILL.md');
          if (fs.existsSync(skillMd)) {
            try {
              const skill = await this.loadSkillFromFile(skillMd);
              loaded.push(skill);
            } catch (err) {
              console.error(`[SkillRegistry] Failed to load skill from ${skillMd}:`, err);
            }
          } else {
            await scan(fullPath);
          }
        } else if (entry.isFile() && (entry.name === 'SKILL.md' || entry.name.endsWith('.skill.md'))) {
          try {
            const skill = await this.loadSkillFromFile(fullPath);
            loaded.push(skill);
          } catch (err) {
            console.error(`[SkillRegistry] Failed to load skill from ${fullPath}:`, err);
          }
        }
      }
    };

    await scan(dirPath);
    return loaded;
  }

  /**
   * Watch a directory for changes, automatically reloading modified skills.
   */
  public watchSkillsDirectory(
    dirPath: string,
    onUpdate?: (action: 'add' | 'update' | 'remove', skillId: string) => void
  ): fs.FSWatcher | undefined {
    if (!fs.existsSync(dirPath)) {
      return undefined;
    }

    try {
      const watcher = fs.watch(dirPath, { recursive: true }, async (eventType, filename) => {
        if (!filename) return;
        if (filename.endsWith('SKILL.md') || filename.endsWith('.skill.md')) {
          const fullPath = path.join(dirPath, filename);
          if (fs.existsSync(fullPath)) {
            try {
              const skill = await this.loadSkillFromFile(fullPath);
              onUpdate?.('update', skill.id);
            } catch (err) {
              console.error(`[SkillRegistry] Hot-reload error for ${fullPath}:`, err);
            }
          }
        }
      });

      try {
        watcher.unref?.();
      } catch {}

      this.activeWatchers.push(watcher);
      return watcher;
    } catch (err) {
      console.warn(`[SkillRegistry] Could not set up watcher for ${dirPath}:`, err);
      return undefined;
    }
  }

  public closeWatchers(): void {
    for (const watcher of this.activeWatchers) {
      watcher.close();
    }
    this.activeWatchers = [];
  }

  private registerBuiltinSkills(): void {
    // 1. Analyst Skill (removed webfetch and websearch)
    this.registerSkill({
      id: 'analyst',
      name: 'Codebase Analyst',
      description: 'Explores the codebase architecture, examines dependencies, and designs implementation strategies.',
      systemPrompt:
        'You are an expert software architect. Analyze codebase structure using read, grep, and glob tools. Provide comprehensive design insights without modifying source code.',
      allowedTools: ['read', 'grep', 'glob', 'todowrite', 'skill', 'question'],
    });

    // 2. Developer Skill
    this.registerSkill({
      id: 'developer',
      name: 'Full-Stack Software Developer',
      description: 'Implements features, modifies code with precision edit, and writes clean, well-tested code.',
      systemPrompt:
        'You are a senior full-stack developer. Use edit for surgical code modifications and write for new files. Always verify that edits preserve existing functionality and follow established patterns.',
      allowedTools: ['read', 'edit', 'write', 'patch', 'bash', 'grep', 'glob', 'todowrite', 'skill'],
    });

    // 3. QA Skill
    this.registerSkill({
      id: 'qa',
      name: 'Quality Assurance & Testing Specialist',
      description: 'Executes test suites, diagnoses test failures, and verifies acceptance criteria.',
      systemPrompt:
        'You are a rigorous QA engineer. Run unit tests, type checkers, and linters via bash. If tests fail, analyze error logs and coordinate with developer to fix root causes.',
      allowedTools: ['bash', 'read', 'grep', 'glob', 'todowrite', 'question'],
    });
  }
}
