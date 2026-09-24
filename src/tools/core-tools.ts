import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { AgentTool, ToolExecutionContext } from './tool-registry.js';
import { withFileLock } from './file-lock.js';

// =================== 1. bash ===================

// Minimal env whitelist: never leak secrets (OPENAI_API_KEY, etc.) to children.
function buildChildEnv(): Record<string, string> {
  const allowExact = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TZ', 'LANG',
    'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TMPDIR', 'TEMP', 'TMP',
  ]);
  const allowPrefix = ['LC_', 'npm_config_', 'npm_package_'];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (allowExact.has(k) || allowPrefix.some((p) => k.startsWith(p))) {
      env[k] = v;
    }
  }
  env.CI = 'true';
  env.DEBIAN_FRONTEND = 'noninteractive';
  env.npm_config_yes = 'true';
  env.PAGER = 'cat';
  return env;
}

export const bashTool: AgentTool<{ command: string; cwd?: string; timeoutMs?: number }> = {
  name: 'bash',
  description: 'Execute a shell command in the project environment (e.g. npm test, git status, build commands).',
  riskLevel: 'HIGH_RISK_EXEC',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Optional working directory relative to workspace root' },
      timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds (default 30000, max 300000)' },
    },
    required: ['command'],
  },
  async execute(params, context) {
    if (!params.command || typeof params.command !== 'string' || params.command.trim().length === 0) {
      throw new Error('bash requires a non-empty command string');
    }
    if (params.command.length > 8000) {
      throw new Error('bash command exceeds 8000 character limit');
    }
    const root = context.workspaceJail.getWorkspaceRoot();
    const effectiveCwd = params.cwd ? context.workspaceJail.resolvePath(params.cwd) : root;
    const timeout = Math.min(Math.max(params.timeoutMs || 30000, 1000), 300000);
    const MAX_OUTPUT = 512 * 1024;

    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        fn();
      };
      const append = (store: 'out' | 'err', chunk: string) => {
        if (store === 'out') {
          if (stdout.length + chunk.length > MAX_OUTPUT) {
            stdout += chunk.slice(0, MAX_OUTPUT - stdout.length);
            truncated = true;
          } else {
            stdout += chunk;
          }
        } else {
          if (stderr.length + chunk.length > MAX_OUTPUT) {
            stderr += chunk.slice(0, MAX_OUTPUT - stderr.length);
            truncated = true;
          } else {
            stderr += chunk;
          }
        }
      };

      let child;
      try {
        child = spawn('sh', ['-c', params.command], {
          cwd: effectiveCwd,
          env: buildChildEnv(),
          signal: context.abortSignal,
          timeout,
          killSignal: 'SIGKILL',
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (err: any) {
        reject(new Error(`Failed to spawn shell: ${err.message}`));
        return;
      }

      const killTimer = setTimeout(() => {
        // Belt and suspenders: spawn timeout should fire first; ensure group kill.
        try {
          if (child.pid && process.platform !== 'win32') {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {}
          }
          child.kill('SIGKILL');
        } catch {}
      }, timeout + 1000);
      (killTimer as any)?.unref?.();

      child.stdout?.on('data', (d) => append('out', String(d)));
      child.stderr?.on('data', (d) => append('err', String(d)));
      child.on('error', (err: any) => {
        settle(() => {
          if (err?.name === 'AbortError' || context.abortSignal?.aborted) {
            reject(new Error('Command aborted by client'));
          } else {
            reject(new Error(`Failed to execute command: ${err.message}`));
          }
        });
      });
      child.on('close', (code, signal) => {
        settle(() => {
          const tail = truncated ? '\n[Output truncated at 512KB]' : '';
          const combined = [
            stdout.trim().length > 0 ? `STDOUT:\n${stdout.trim()}` : '',
            stderr.trim().length > 0 ? `STDERR:\n${stderr.trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n\n');
          if (code === 0) {
            resolve((combined.length > 0 ? combined : 'Command executed successfully with no output.') + tail);
          } else if (context.abortSignal?.aborted || signal === 'SIGTERM') {
            reject(new Error(`Command aborted by client${stdout || stderr ? `: ${combined.slice(0, 500)}` : ''}`));
          } else {
            reject(
              new Error(
                `Command failed with exit code ${code ?? signal ?? 1}${stdout ? `\nSTDOUT:\n${stdout.trim().slice(-2000)}` : ''}${stderr ? `\nSTDERR:\n${stderr.trim().slice(-2000)}` : ''}`
              )
            );
          }
        });
      });
    });
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
    // Serialize writers per file: parallel edits must not read-modify-write over each other
    return withFileLock(fullPath, async () => {
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
    });
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
    return withFileLock(fullPath, async () => {
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
    });
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

    // Bound memory: refuse giant files, point at line-range slicing instead
    const MAX_READ_BYTES = 5 * 1024 * 1024;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_READ_BYTES) {
        throw new Error(
          `File '${params.filePath}' is ${(stat.size / 1024 / 1024).toFixed(1)}MB (limit 5MB). ` +
          `Use startLine/endLine to read it in slices.`
        );
      }
    } catch (err: any) {
      if (err?.message?.includes('limit 5MB')) throw err;
      // Non-stat errors (race/perm) surface at readFileSync below
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

// Shared async walker: never follows symlinks (escape + cycle safe),
// always skips .git, honors abort signals and filesystem caps.
interface WalkEntry {
  full: string;
  isDir: boolean;
}

async function walkAsync(
  root: string,
  opts: {
    recursive: boolean;
    signal?: AbortSignal;
    deadlineMs: number;
    maxEntries: number;
    skipHidden: boolean;
    onDir?: (dir: string, depth: number) => boolean;
  },
  onFile: (full: string) => void | Promise<void>,
  onEntry?: (entry: WalkEntry) => void | Promise<void>
): Promise<{ entries: number; aborted: boolean }> {
  let entries = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    if (opts.signal?.aborted) return { entries, aborted: true };
    if (Date.now() > opts.deadlineMs) {
      throw new Error('Search timed out — narrow dirPath or pattern');
    }
    const { dir, depth } = stack.pop()!;
    if (!opts.recursive && depth > 0) continue;
    if (opts.onDir && !opts.onDir(dir, depth)) continue;
    let dirHandle;
    try {
      dirHandle = await fsp.opendir(dir);
    } catch {
      continue;
    }
    try {
      for await (const entry of dirHandle) {
        if (opts.signal?.aborted) return { entries, aborted: true };
        if (++entries > opts.maxEntries) {
          throw new Error('Search scope too large — narrow dirPath or pattern');
        }
        const name = entry.name;
        if (name === '.git' || name === 'node_modules' || name === 'dist') continue;
        if (opts.skipHidden && name.startsWith('.')) continue;
        const full = path.join(dir, name);
        let st: fs.Stats;
        try {
          st = await fsp.lstat(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue; // never follow symlinks
        if (st.isDirectory()) {
          await onEntry?.({ full, isDir: true });
          stack.push({ dir: full, depth: depth + 1 });
        } else if (st.isFile()) {
          await onEntry?.({ full, isDir: false });
          await onFile(full);
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('too large') || err?.message?.includes('timed out')) throw err;
      // Unreadable directory — skip
    } finally {
      try {
        await dirHandle.close();
      } catch {}
    }
  }
  return { entries, aborted: false };
}

function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  return (async () => {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
      }
    });
    await Promise.all(workers);
  })();
}

export const grepTool: AgentTool<{ pattern: string; dirPath?: string; caseSensitive?: boolean; timeoutMs?: number }> = {
  name: 'grep',
  description: 'Search for matching lines using a regular expression pattern across files in the codebase.',
  riskLevel: 'READ_ONLY',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern to search for' },
      dirPath: { type: 'string', description: 'Directory to search within (defaults to workspace root)' },
      caseSensitive: { type: 'boolean', description: 'Whether search is case-sensitive (default true)' },
      timeoutMs: { type: 'number', description: 'Search timeout in milliseconds (default 30000)' },
    },
    required: ['pattern'],
  },
  async execute(params, context) {
    if (!params.pattern || typeof params.pattern !== 'string') {
      throw new Error('grep requires a non-empty pattern string');
    }
    if (params.pattern.length > 500) {
      throw new Error('grep pattern exceeds 500 character limit');
    }
    const searchRoot = params.dirPath
      ? context.workspaceJail.resolvePath(params.dirPath)
      : context.workspaceJail.getWorkspaceRoot();

    let regex: RegExp;
    try {
      regex = new RegExp(params.pattern, params.caseSensitive === false ? 'i' : '');
    } catch (err: any) {
      throw new Error(`Invalid regex pattern '${params.pattern}': ${err.message}`);
    }
    const results: string[] = [];
    const maxMatches = 50;
    const MAX_FILES = 5000;
    const MAX_BYTES = 20 * 1024 * 1024;
    const MAX_FILE_BYTES = 1024 * 1024;
    const deadlineMs = Date.now() + Math.min(Math.max(params.timeoutMs || 30000, 1000), 120000);
    let filesSeen = 0;
    let bytesSeen = 0;
    let done = false;

    const candidateFiles: string[] = [];
    await walkAsync(
      searchRoot,
      {
        recursive: true,
        signal: context.abortSignal,
        deadlineMs,
        maxEntries: MAX_FILES * 2,
        skipHidden: true,
      },
      async (full) => {
        if (done) return;
        if (++filesSeen > MAX_FILES) {
          done = true;
          return;
        }
        let size = 0;
        try {
          size = (await fsp.stat(full)).size;
        } catch {
          return;
        }
        if (size > MAX_FILE_BYTES) return; // skip binaries / giant files
        if (bytesSeen + size > MAX_BYTES) {
          done = true;
          return;
        }
        bytesSeen += size;
        candidateFiles.push(full);
      }
    );

    if (context.abortSignal?.aborted) {
      throw new Error('grep aborted by client');
    }

    await runWithConcurrency(candidateFiles, 8, async (full) => {
      if (done || results.length >= maxMatches) return;
      let content: string;
      try {
        content = await fsp.readFile(full, 'utf8');
      } catch {
        return; // binary / unreadable
      }
      if (content.includes('\0')) return; // binary heuristic
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let matched = false;
        try {
          matched = regex.test(lines[i]);
        } catch {
          return;
        }
        // Avoid lastIndex stickiness for /g patterns
        regex.lastIndex = 0;
        if (matched) {
          const rel = path.relative(searchRoot, full);
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 500)}`);
          if (results.length >= maxMatches) {
            done = true;
            break;
          }
        }
      }
    });

    if (results.length === 0) {
      return `No matches found for pattern: /${params.pattern}/`;
    }
    results.sort();
    return `Found ${results.length} match(es):\n${results.join('\n')}`;
  },
};

// =================== 6. glob ===================
function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export const globTool: AgentTool<{ pattern: string; dirPath?: string; timeoutMs?: number }> = {
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
      timeoutMs: { type: 'number', description: 'Search timeout in milliseconds (default 15000)' },
    },
    required: ['pattern'],
  },
  async execute(params, context) {
    const workspaceRoot = context.workspaceJail.getWorkspaceRoot();
    const rawRoot = params.dirPath
      ? context.workspaceJail.resolvePath(params.dirPath)
      : workspaceRoot;

    try {
      const st = await fsp.stat(rawRoot);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(`Directory not found: ${params.dirPath || '.'}`);
    }

    const pattern = (params.pattern || '*').trim();
    if (pattern.length > 500) {
      throw new Error('glob pattern exceeds 500 character limit');
    }
    const deadlineMs = Date.now() + Math.min(Math.max(params.timeoutMs || 15000, 1000), 60000);
    const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
    const isRecursive = pattern.includes('**');
    const isTopLevel = pattern === '*' || pattern === '.*' || pattern === './*' || pattern === '.';

    // Check if pattern targets a specific subdirectory, e.g. "src/*" or "scripts/*"
    const slashIdx = pattern.lastIndexOf('/');
    let searchDir = rawRoot;
    let filePattern = pattern;

    if (slashIdx !== -1 && !isRecursive) {
      const subDirPart = pattern.slice(0, slashIdx);
      filePattern = pattern.slice(slashIdx + 1) || '*';
      // Containment: never resolve outside the jail via crafted sub-patterns
      const resolvedSubDir = path.resolve(rawRoot, subDirPart);
      if (
        (resolvedSubDir === workspaceRoot || resolvedSubDir.startsWith(rootWithSep)) &&
        (resolvedSubDir === rawRoot || resolvedSubDir.startsWith(rawRoot + path.sep))
      ) {
        try {
          const sst = await fsp.stat(resolvedSubDir);
          if (sst.isDirectory() && !sst.isSymbolicLink()) {
            const lst = await fsp.lstat(resolvedSubDir);
            if (!lst.isSymbolicLink()) searchDir = resolvedSubDir;
          }
        } catch {
          // Fall through to rawRoot search
        }
      }
    }

    const isTopDirList = isTopLevel || filePattern === '*' || filePattern === '.*';

    // 1. Top-level directory listing (non-recursive)
    if (!isRecursive && isTopDirList) {
      const entries = await fsp.readdir(searchDir, { withFileTypes: true });
      const includeHidden = pattern.startsWith('.') || filePattern.startsWith('.') || pattern === '*';

      const dirs: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        if (entry.name === '.git') continue; // Always hide internal .git unless explicitly asked
        if (!includeHidden && entry.name.startsWith('.')) continue;

        const relPath = path.relative(workspaceRoot, path.join(searchDir, entry.name));
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
        return `Directory ${path.relative(workspaceRoot, searchDir) || '.'} is empty.`;
      }

      const dirLabel = path.relative(workspaceRoot, searchDir) || '.';
      return `Listing ${allItems.length} item(s) in '${dirLabel}':\n` + allItems.join('\n');
    }

    // 2. Recursive or pattern-filtered file search (async, symlink-safe, bounded)
    const extMatch = pattern.match(/\.([a-zA-Z0-9]+)$/);
    const targetExt = extMatch ? `.${extMatch[1]}` : undefined;
    // '**/' prefix means "at any depth" — match basenames against the remainder
    const namePart = filePattern.startsWith('**/') ? filePattern.slice(3) : filePattern;
    const nameMatchPattern = namePart !== '*' && namePart !== '**/*' ? namePart.split('*').map(escapeRegExp).join('.*') : undefined;
    const nameRegex = nameMatchPattern ? new RegExp(`^${nameMatchPattern}$`, 'i') : undefined;

    const matchedItems: Array<{ relPath: string; isDir: boolean; mtime: number }> = [];
    const MAX_MATCHED = 5000;

    await walkAsync(
      searchDir,
      {
        recursive: isRecursive,
        signal: context.abortSignal,
        deadlineMs,
        maxEntries: MAX_MATCHED * 2,
        skipHidden: !pattern.startsWith('.'),
      },
      async () => {},
      async ({ full, isDir }) => {
        if (matchedItems.length >= MAX_MATCHED) return;
        const name = path.basename(full);
        if (isDir) {
          if (isRecursive) return; // recursion handled by walker; dirs listed only in non-recursive mode
          if (!targetExt && (!nameRegex || nameRegex.test(name))) {
            const relPath = path.relative(rawRoot, full);
            matchedItems.push({ relPath: `${relPath}/`, isDir: true, mtime: 0 });
          }
          return;
        }
        const extMatches = !targetExt || full.endsWith(targetExt);
        const nameMatches = !nameRegex || nameRegex.test(name);
        if (extMatches && nameMatches) {
          const relPath = path.relative(rawRoot, full);
          let mtime = 0;
          try {
            mtime = (await fsp.stat(full)).mtimeMs;
          } catch {}
          matchedItems.push({ relPath, isDir: false, mtime });
        }
      }
    );

    if (context.abortSignal?.aborted) {
      throw new Error('glob aborted by client');
    }

    matchedItems.sort((a, b) => b.mtime - a.mtime);

    if (matchedItems.length === 0) {
      return `No files or directories found matching pattern: ${params.pattern}`;
    }

    const preview = matchedItems.slice(0, 60).map((f) => (f.isDir ? `[DIR]  ${f.relPath}` : `[FILE] ${f.relPath}`));
    const truncatedNote = matchedItems.length > 60 ? `\n... (${matchedItems.length - 60} more items omitted)` : '';

    return `Found ${matchedItems.length} match(es) for pattern '${params.pattern}':\n` + preview.join('\n') + truncatedNote;
  },
};
