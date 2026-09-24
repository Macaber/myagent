import { PermissionRiskLevel } from '../protocol/types.js';
import { WorkspaceJail } from './workspace-jail.js';

export interface SecurityPolicyConfig {
  autoApproveReadOnly?: boolean;
  autoApproveWorkspaceWrite?: boolean;
  strictMode?: boolean; // If true, even workspace write requires approval
}

export class PolicyEngine {
  constructor(
    private readonly jail: WorkspaceJail,
    private readonly config: SecurityPolicyConfig = {
      autoApproveReadOnly: true,
      autoApproveWorkspaceWrite: true,
      strictMode: false,
    }
  ) {}

  public evaluateToolCall(params: {
    toolName: string;
    riskLevel: PermissionRiskLevel;
    filePath?: string;
    command?: string;
  }): { requiresApproval: boolean; reason?: string } {
    const { filePath } = params;
    const riskLevel = (String(params.riskLevel || '').toUpperCase() || 'UNKNOWN') as PermissionRiskLevel;

    // 1. Verify workspace jail if path is provided
    if (filePath) {
      try {
        this.jail.resolvePath(filePath);
      } catch (err: any) {
        return {
          requiresApproval: true,
          reason: `Path check failed: ${err.message}`,
        };
      }
    }

    // 2. Evaluate based on risk tier
    switch (riskLevel) {
      case 'READ_ONLY':
        return { requiresApproval: false };

      case 'WORKSPACE_WRITE':
        if (this.config.strictMode) {
          return {
            requiresApproval: true,
            reason: 'Strict mode enabled: workspace file modifications require confirmation.',
          };
        }
        return { requiresApproval: false };

      case 'HIGH_RISK_EXEC':
        if (this.config.autoApproveReadOnly && params.command && this.isReadOnlyCommand(params.command)) {
          return { requiresApproval: false };
        }
        return {
          requiresApproval: true,
          reason: `Command/script execution requires human approval: ${params.command || params.toolName}`,
        };

      case 'NETWORK':
        return {
          requiresApproval: true,
          reason: `Outbound network access requested by tool '${params.toolName}'`,
        };

      default:
        return { requiresApproval: true, reason: 'Unknown risk tier' };
    }
  }

  /**
   * Evaluates if a shell command is strictly read-only inspection within workspace jail.
   */
  public isReadOnlyCommand(command: string): boolean {
    if (!command || command.trim().length === 0) return false;

    // 0. Reject shell expansions / home / glob metachars outright
    // ($VAR, ${VAR}, $(), ~, backticks are handled below but fail closed here)
    if (/[$`~]/.test(command)) {
      return false;
    }

    // 1. Disallow write/redirect operators (>, >>, &>, 1>, 2>, >|, <)
    if (/[<>]/.test(command)) {
      return false;
    }

    // 3. Known mutating commands or dangerous utilities
    const dangerousCommands = /\b(rm|rmdir|mv|cp|touch|mkdir|chmod|chown|kill|pkill|sudo|su|curl|wget|ssh|scp|rsync|tee|dd|mkfs|fdisk|reboot|shutdown|python|python3|perl|ruby|php|sh|bash|zsh|fish|nc|ncat|socat|ftp|tftp|lftp|apt|apt-get|yum|dnf|brew|pip|docker|kubectl|helm|ed|vi|vim|nano|emacs|sed)\b/i;
    if (dangerousCommands.test(command)) {
      // Allowlist narrow carve-outs below (e.g. safe git); sed is never read-only
      // (sed -i variants, w commands). Keep fail-closed for interpreters/shells.
      return false;
    }

    // 4. Split chained commands by ;, &&, ||, |
    const segments = command.split(/[;&|]+/).map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return false;

    const safeBinarySet = new Set([
      'cat', 'head', 'tail', 'wc', 'od', 'hexdump', 'file', 'nl', 'strings',
      'ls', 'pwd', 'dir',
      'echo', 'printf', 'grep', 'egrep', 'fgrep', 'awk', 'cut', 'sort', 'uniq', 'tr', 'column',
      'diff', 'cmp', 'test', '[', '[[',
      'which', 'whereis', 'uname', 'whoami',
      'git', 'node', 'npm', 'pnpm', 'yarn', 'cargo', 'go'
    ]);

    for (const segment of segments) {
      const tokens = segment.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;

      const baseCmd = tokens[0].toLowerCase();
      if (!safeBinarySet.has(baseCmd)) {
        return false;
      }

      // Specialized inspection for git / npm / node
      if (baseCmd === 'git') {
        const subCmd = tokens[1]?.toLowerCase();
        const safeGitSubcommands = new Set(['status', 'log', 'diff', 'branch', 'show', 'rev-parse', 'describe']);
        if (!subCmd || !safeGitSubcommands.has(subCmd)) {
          return false;
        }
      }

      if (baseCmd === 'npm' || baseCmd === 'pnpm' || baseCmd === 'yarn') {
        const subCmd = tokens[1]?.toLowerCase();
        // NOTE: view/info hit the registry (network) — not read-only.
        const safePkgSubcommands = new Set(['-v', '--version', 'list', 'ls']);
        if (!subCmd || !safePkgSubcommands.has(subCmd)) {
          return false;
        }
      }

      if (baseCmd === 'node' || baseCmd === 'cargo' || baseCmd === 'go') {
        const subCmd = tokens[1]?.toLowerCase();
        if (subCmd !== '-v' && subCmd !== '--version' && subCmd !== 'version') {
          return false;
        }
      }

      // Check file path arguments in this segment
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        // Skip flags like -n, -l, --format, etc.
        if (token.startsWith('-')) continue;
        // Skip string literals if wrapped in quotes
        const unquoted = token.replace(/^['"]|['"]$/g, '');
        // If token looks like a path (contains / or .)
        if (unquoted.includes('/') || unquoted.includes('.')) {
          // Verify against workspace jail
          try {
            this.jail.resolvePath(unquoted);
          } catch {
            return false;
          }
        }
      }
    }

    return true;
  }
}
