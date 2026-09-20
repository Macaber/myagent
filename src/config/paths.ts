import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Returns the centralized MyAgent home directory.
 * Defaults to `~/.myagent` (e.g. `/Users/<user>/.myagent`), or overridden by `MYAGENT_HOME` env var.
 */
export function getMyAgentHome(): string {
  if (process.env.MYAGENT_HOME && process.env.MYAGENT_HOME.trim() !== '') {
    return path.resolve(process.env.MYAGENT_HOME.trim());
  }
  return path.join(os.homedir(), '.myagent');
}

/**
 * Ensures that the ~/.myagent home directory exists.
 */
export function ensureMyAgentHome(): string {
  const home = getMyAgentHome();
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true });
  }
  return home;
}

/**
 * Returns the default SQLite database path in ~/.myagent.
 */
export function getDefaultDbPath(): string {
  return path.join(getMyAgentHome(), 'data.db');
}

/**
 * Returns the centralized skills directory in ~/.myagent/skills.
 */
export function getSkillsDir(): string {
  return path.join(getMyAgentHome(), 'skills');
}

/**
 * Returns the centralized tasks directory in ~/.myagent/tasks.
 */
export function getTasksDir(): string {
  return path.join(getMyAgentHome(), 'tasks');
}

/**
 * Returns the centralized MCP config file path in ~/.myagent/mcp.json.
 */
export function getMcpConfigPath(): string {
  return path.join(getMyAgentHome(), 'mcp.json');
}

/**
 * Returns the centralized .env file path in ~/.myagent/.env.
 */
export function getEnvFilePath(): string {
  return path.join(getMyAgentHome(), '.env');
}

/**
 * Safely migrates legacy `.agent` directory files from workspace to ~/.myagent.
 */
export function migrateLegacyAgentDirectory(workspaceRoot: string = process.cwd()): {
  migrated: string[];
  skipped: string[];
} {
  const legacyDir = path.join(workspaceRoot, '.agent');
  if (!fs.existsSync(legacyDir)) {
    return { migrated: [], skipped: [] };
  }

  const targetDir = ensureMyAgentHome();
  const migrated: string[] = [];
  const skipped: string[] = [];

  try {
    const entries = fs.readdirSync(legacyDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(legacyDir, entry.name);
      const destPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.cpSync(srcPath, destPath, { recursive: true });
          migrated.push(entry.name);
        } else {
          skipped.push(entry.name);
        }
      } else if (entry.isFile()) {
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(srcPath, destPath);
          migrated.push(entry.name);
        } else {
          // If source is larger or modified more recently, update it
          const srcStat = fs.statSync(srcPath);
          const destStat = fs.statSync(destPath);
          if (srcStat.mtimeMs > destStat.mtimeMs || srcStat.size > destStat.size) {
            fs.copyFileSync(srcPath, destPath);
            migrated.push(entry.name);
          } else {
            skipped.push(entry.name);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Paths] Migration from ${legacyDir} to ${targetDir} encountered error:`, err);
  }

  return { migrated, skipped };
}
