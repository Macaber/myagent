import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentTool, ToolExecutionContext } from './tool-registry.js';

const execAsync = promisify(exec);

// =================== 1. bash ===================
export const bashTool: AgentTool<{ command: string; cwd?: string; timeoutMs?: number }> = {
  name: 'bash',
  description: 'Execute a shell command in the project environment (e.g. npm test, git status, build commands).',
  riskLevel: 'HIGH_RISK_EXEC',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Optional working directory relative to workspace root' },
      timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds (default 30000)' },
    },
    required: ['command'],
  },
  async execute(params, context) {
    const root = context.workspaceJail.getWorkspaceRoot();
    const effectiveCwd = params.cwd ? context.workspaceJail.resolvePath(params.cwd) : root;
    const timeout = params.timeoutMs || 30000;

    try {
      const { stdout, stderr } = await execAsync(params.command, {
        cwd: effectiveCwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          CI: 'true',
          DEBIAN_FRONTEND: 'noninteractive',
          npm_config_yes: 'true',
          PAGER: 'cat',
        },
      });
      const combined = [
        stdout.trim().length > 0 ? `STDOUT:\n${stdout}` : '',
        stderr.trim().length > 0 ? `STDERR:\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return combined.length > 0 ? combined : 'Command executed successfully with no output.';
    } catch (err: any) {
      const stdout = err.stdout ? `\nSTDOUT:\n${err.stdout}` : '';
      const stderr = err.stderr ? `\nSTDERR:\n${err.stderr}` : '';
      throw new Error(`Command failed with exit code ${err.code || 1}: ${err.message}${stdout}${stderr}`);
    }
  },
};

// =================== 2. edit ===================
export const editTool: AgentTool<{ filePath: string; oldStr: string; newStr: string; allowMultiple?: boolean }> = {
  name: 'edit',
  description:
    'Modify an existing file by replacing an exact occurrences of oldStr with newStr. This is the primary way LLMs modify code.',
  riskLevel: 'WORKSPACE_WRITE',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file relative to workspace' },
      oldStr: { type: 'string', description: 'The exact string to be replaced' },
      newStr: { type: 'string', description: 'The replacement string' },
      allowMultiple: { type: 'boolean', description: 'Whether to replace multiple occurrences (default false)' },
    },
    required: ['filePath', 'oldStr', 'newStr'],
  },
  async execute(params, context) {
    const fullPath = context.workspaceJail.resolvePath(params.filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${params.filePath}`);
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const occurrences = content.split(params.oldStr).length - 1;

    if (occurrences === 0) {
      throw new Error(`Target oldStr not found in ${params.filePath}. Ensure exact whitespace and line matches.`);
    }

    if (occurrences > 1 && !params.allowMultiple) {
      throw new Error(
        `Target oldStr found ${occurrences} times in ${params.filePath}. Specify unique surrounding context or set allowMultiple=true.`
      );
    }

    const newContent = params.allowMultiple
      ? content.replaceAll(params.oldStr, params.newStr)
      : content.replace(params.oldStr, params.newStr);

    fs.writeFileSync(fullPath, newContent, 'utf8');

    // Record file modification in Blackboard
    context.blackboard.appendArtifact({
      artifactId: `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      filePath: params.filePath,
      action: 'MODIFY',
    });

    return `Successfully replaced ${params.allowMultiple ? occurrences : 1} occurrence(s) in ${params.filePath}.`;
  },
};

// =================== 3. write ===================
export const writeTool: AgentTool<{ filePath: string; content: string; overwrite?: boolean }> = {
  name: 'write',
  description: 'Create a new file or overwrite an existing file with the provided content.',
  riskLevel: 'WORKSPACE_WRITE',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file relative to workspace root' },
      content: { type: 'string', description: 'The full file content to write' },
      overwrite: { type: 'boolean', description: 'Whether to overwrite if file exists (default true)' },
    },
    required: ['filePath', 'content'],
  },
  async execute(params, context) {
    const fullPath = context.workspaceJail.resolvePath(params.filePath);
    const exists = fs.existsSync(fullPath);
    if (exists && params.overwrite === false) {
      throw new Error(`File already exists at ${params.filePath} and overwrite=false`);
    }

    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, params.content, 'utf8');

    context.blackboard.appendArtifact({
      artifactId: `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      filePath: params.filePath,
      action: exists ? 'MODIFY' : 'CREATE',
    });

    return `Successfully wrote ${params.content.length} characters to ${params.filePath}.`;
  },
};

// =================== 4. read ===================
export const readTool: AgentTool<{ filePath: string; startLine?: number; endLine?: number }> = {
  name: 'read',
  description: 'Read the contents of a file, with optional 1-indexed line range slicing for large files.',
  riskLevel: 'READ_ONLY',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file relative to workspace root' },
      startLine: { type: 'number', description: '1-indexed starting line number (inclusive)' },
      endLine: { type: 'number', description: '1-indexed ending line number (inclusive)' },
    },
    required: ['filePath'],
  },
  async execute(params, context) {
    const fullPath = context.workspaceJail.resolvePath(params.filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${params.filePath}`);
    }

    const raw = fs.readFileSync(fullPath, 'utf8');
    const lines = raw.split('\n');

    let start = params.startLine ? Math.max(1, params.startLine) : 1;
    let end = params.endLine ? Math.min(lines.length, params.endLine) : lines.length;

    if (start > end) {
      throw new Error(`Invalid line range: startLine (${start}) > endLine (${end})`);
    }

    const sliced = lines.slice(start - 1, end).map((line, idx) => `${start + idx}: ${line}`);
    return `File: ${params.filePath} (Lines ${start}-${end} of ${lines.length})\n\n${sliced.join('\n')}`;
  },
};

// =================== 5. grep ===================
export const grepTool: AgentTool<{ pattern: string; dirPath?: string; caseSensitive?: boolean }> = {
  name: 'grep',
  description: 'Search for matching lines using a regular expression pattern across files in the codebase.',
  riskLevel: 'READ_ONLY',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern to search for' },
      dirPath: { type: 'string', description: 'Directory to search within (defaults to workspace root)' },
      caseSensitive: { type: 'boolean', description: 'Whether search is case-sensitive (default true)' },
    },
    required: ['pattern'],
  },
  async execute(params, context) {
    const searchRoot = params.dirPath
      ? context.workspaceJail.resolvePath(params.dirPath)
      : context.workspaceJail.getWorkspaceRoot();

    const regex = new RegExp(params.pattern, params.caseSensitive === false ? 'i' : '');
    const results: string[] = [];
    const maxMatches = 50;

    function walk(dir: string) {
      if (results.length >= maxMatches) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                const rel = path.relative(searchRoot, full);
                results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                if (results.length >= maxMatches) break;
              }
            }
          } catch {
            // Ignore binary files or unreadable files
          }
        }
      }
    }

    walk(searchRoot);
    if (results.length === 0) {
      return `No matches found for pattern: /${params.pattern}/`;
    }
    return `Found ${results.length} match(es):\n${results.join('\n')}`;
  },
};

// =================== 6. glob ===================
export const globTool: AgentTool<{ pattern: string; dirPath?: string }> = {
  name: 'glob',
  description:
    'List directory contents or search for files/directories matching a pattern (e.g. "*", ".*", "src/*", "**/*.ts", "*.json"). ' +
    'Returns items marked with [DIR] or [FILE]. Use pattern "*" to list top-level files and directories.',
  riskLevel: 'READ_ONLY',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'File/directory pattern (e.g. "*", ".*", "src/*", "**/*.ts", "*.json")',
      },
      dirPath: {
        type: 'string',
        description: 'Directory to search within (defaults to workspace root)',
      },
    },
    required: ['pattern'],
  },
  async execute(params, context) {
    const rawRoot = params.dirPath
      ? context.workspaceJail.resolvePath(params.dirPath)
      : context.workspaceJail.getWorkspaceRoot();

    if (!fs.existsSync(rawRoot)) {
      throw new Error(`Directory not found: ${params.dirPath || '.'}`);
    }

    const pattern = (params.pattern || '*').trim();
    const isRecursive = pattern.includes('**');
    const isTopLevel = pattern === '*' || pattern === '.*' || pattern === './*' || pattern === '.';

    // Check if pattern targets a specific subdirectory, e.g. "src/*" or "scripts/*"
    const slashIdx = pattern.lastIndexOf('/');
    let searchDir = rawRoot;
    let filePattern = pattern;

    if (slashIdx !== -1 && !isRecursive) {
      const subDirPart = pattern.slice(0, slashIdx);
      filePattern = pattern.slice(slashIdx + 1) || '*';
      const resolvedSubDir = path.resolve(rawRoot, subDirPart);
      if (fs.existsSync(resolvedSubDir) && fs.statSync(resolvedSubDir).isDirectory()) {
        searchDir = resolvedSubDir;
      }
    }

    const isTopDirList = isTopLevel || filePattern === '*' || filePattern === '.*';

    // 1. Top-level directory listing (non-recursive)
    if (!isRecursive && isTopDirList) {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      const includeHidden = pattern.startsWith('.') || filePattern.startsWith('.') || pattern === '*';

      const dirs: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        if (entry.name === '.git') continue; // Always hide internal .git unless explicitly asked
        if (!includeHidden && entry.name.startsWith('.')) continue;

        const relPath = path.relative(context.workspaceJail.getWorkspaceRoot(), path.join(searchDir, entry.name));
        const displayName = relPath || entry.name;

        if (entry.isDirectory()) {
          dirs.push(`[DIR]  ${displayName}/`);
        } else {
          files.push(`[FILE] ${displayName}`);
        }
      }

      dirs.sort((a, b) => a.localeCompare(b));
      files.sort((a, b) => a.localeCompare(b));

      const allItems = [...dirs, ...files];
      if (allItems.length === 0) {
        return `Directory ${path.relative(context.workspaceJail.getWorkspaceRoot(), searchDir) || '.'} is empty.`;
      }

      const dirLabel = path.relative(context.workspaceJail.getWorkspaceRoot(), searchDir) || '.';
      return `Listing ${allItems.length} item(s) in '${dirLabel}':\n` + allItems.join('\n');
    }

    // 2. Recursive or pattern-filtered file search
    const extMatch = pattern.match(/\.([a-zA-Z0-9]+)$/);
    const targetExt = extMatch ? `.${extMatch[1]}` : undefined;
    const nameMatchPattern = filePattern !== '*' && filePattern !== '**/*' ? filePattern.replace(/\*/g, '.*') : undefined;
    const nameRegex = nameMatchPattern ? new RegExp(`^${nameMatchPattern}$`, 'i') : undefined;

    const matchedItems: Array<{ relPath: string; isDir: boolean; mtime: number }> = [];

    function walk(dir: string, currentDepth: number = 0) {
      if (!isRecursive && currentDepth > 0) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (!pattern.startsWith('.') && entry.name.startsWith('.')) continue;

        const full = path.join(dir, entry.name);
        const relPath = path.relative(rawRoot, full);

        if (entry.isDirectory()) {
          if (isRecursive) {
            walk(full, currentDepth + 1);
          } else {
            if (!targetExt && (!nameRegex || nameRegex.test(entry.name))) {
              matchedItems.push({ relPath: `${relPath}/`, isDir: true, mtime: Date.now() });
            }
          }
        } else if (entry.isFile()) {
          const extMatches = !targetExt || full.endsWith(targetExt);
          const nameMatches = !nameRegex || nameRegex.test(entry.name);
          if (extMatches && nameMatches) {
            try {
              const stat = fs.statSync(full);
              matchedItems.push({ relPath, isDir: false, mtime: stat.mtimeMs });
            } catch {
              matchedItems.push({ relPath, isDir: false, mtime: 0 });
            }
          }
        }
      }
    }

    walk(searchDir, 0);
    matchedItems.sort((a, b) => b.mtime - a.mtime);

    if (matchedItems.length === 0) {
      return `No files or directories found matching pattern: ${params.pattern}`;
    }

    const preview = matchedItems.slice(0, 60).map((f) => (f.isDir ? `[DIR]  ${f.relPath}` : `[FILE] ${f.relPath}`));
    const truncatedNote = matchedItems.length > 60 ? `\n... (${matchedItems.length - 60} more items omitted)` : '';

    return `Found ${matchedItems.length} match(es) for pattern '${params.pattern}':\n` + preview.join('\n') + truncatedNote;
  },
};
