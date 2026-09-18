import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { SkillRegistry } from '../dist/skills/skill-registry.js';
import { skillTool } from '../dist/tools/extended-tools.js';
import { WorkspaceJail } from '../dist/security/workspace-jail.js';
import { Blackboard } from '../dist/context/blackboard.js';

describe('Dynamic Skills Loading & Hot-Reloading', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));

  test('1. parseSkillMarkdown handles both YAML frontmatter and Markdown headings', () => {
    const registry = new SkillRegistry();

    // YAML Frontmatter format
    const yamlSkill = `---
name: SecurityAuditor
description: Audits code for vulnerabilities
allowedTools: [read, grep, bash]
---
You are a security auditor. Inspect code for OWASP Top 10 vulnerabilities.`;

    const parsed1 = registry.parseSkillMarkdown(yamlSkill, 'sec_auditor');
    assert.strictEqual(parsed1.id, 'securityauditor');
    assert.strictEqual(parsed1.name, 'SecurityAuditor');
    assert.strictEqual(parsed1.description, 'Audits code for vulnerabilities');
    assert.deepStrictEqual(parsed1.allowedTools, ['read', 'grep', 'bash']);
    assert.ok(parsed1.systemPrompt.includes('OWASP Top 10'));

    // Markdown heading format
    const mdSkill = `# DatabaseOptimizer
> Optimizes SQL queries and indexes

## Allowed Tools
read, grep, glob

## Instructions
Analyze database schemas and suggest index improvements.`;

    const parsed2 = registry.parseSkillMarkdown(mdSkill, 'db_opt');
    assert.strictEqual(parsed2.id, 'databaseoptimizer');
    assert.strictEqual(parsed2.name, 'DatabaseOptimizer');
    assert.strictEqual(parsed2.description, 'Optimizes SQL queries and indexes');
    assert.deepStrictEqual(parsed2.allowedTools, ['read', 'grep', 'glob']);
    assert.ok(parsed2.systemPrompt.includes('database schemas'));
  });

  test('2. loadSkillsFromDirectory scans directories and registers skills', async () => {
    const skillsDir = path.join(tempDir, '.agent', 'skills');
    fs.mkdirSync(path.join(skillsDir, 'perf-tuning'), { recursive: true });

    // Write SKILL.md in directory
    fs.writeFileSync(
      path.join(skillsDir, 'perf-tuning', 'SKILL.md'),
      `---
name: PerformanceTuner
description: Identifies CPU and memory bottlenecks
allowedTools: [read, bash]
---
Profile Node.js applications and eliminate bottlenecks.`
    );

    const registry = new SkillRegistry();
    const loaded = await registry.loadSkillsFromDirectory(skillsDir);

    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, 'performancetuner');
    assert.ok(registry.hasSkill('performancetuner'));

    const retrieved = registry.getSkill('performancetuner');
    assert.strictEqual(retrieved?.name, 'PerformanceTuner');
  });

  test('3. watchSkillsDirectory triggers hot-reload on file modification', async () => {
    const skillsDir = path.join(tempDir, 'watch-skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillPath = path.join(skillsDir, 'SKILL.md');

    fs.writeFileSync(
      skillPath,
      `---
name: HotReloadSkill
description: Version 1
---
Version 1 Prompt`
    );

    const registry = new SkillRegistry();
    await registry.loadSkillFromFile(skillPath);
    assert.strictEqual(registry.getSkill('hotreloadskill')?.description, 'Version 1');

    let updatedSkillId = '';
    const watcher = registry.watchSkillsDirectory(skillsDir, (_action, id) => {
      updatedSkillId = id;
    });

    try {
      // Modify file
      fs.writeFileSync(
        skillPath,
        `---
name: HotReloadSkill
description: Version 2 Updated
---
Version 2 Prompt`
      );

      // Wait for fs.watch event to fire and reload
      for (let i = 0; i < 30; i++) {
        if (registry.getSkill('hotreloadskill')?.description === 'Version 2 Updated') {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.strictEqual(registry.getSkill('hotreloadskill')?.description, 'Version 2 Updated');
    } finally {
      registry.closeWatchers();
    }
  });

  test('4. skillTool lists available skills and reads custom skill content', async () => {
    const jail = new WorkspaceJail(tempDir);
    const blackboard = new Blackboard();

    // List skills
    const listOutput = await skillTool.execute(
      { action: 'list' },
      {
        threadId: 't1',
        workspaceJail: jail,
        blackboard,
      }
    );

    assert.ok(listOutput.includes('analyst (built-in)'));
    assert.ok(listOutput.includes('developer (built-in)'));
    assert.ok(listOutput.includes('qa (built-in)'));

    // Get specific custom skill created in step 2
    const getOutput = await skillTool.execute(
      { skillName: 'perf-tuning' },
      {
        threadId: 't1',
        workspaceJail: jail,
        blackboard,
      }
    );

    assert.ok(getOutput.includes('PerformanceTuner'));
    assert.ok(getOutput.includes('Profile Node.js applications'));
  });
});
