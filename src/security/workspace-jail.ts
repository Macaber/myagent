import * as path from 'node:path';

export class WorkspaceJail {
  private readonly normalizedRoot: string;
  private readonly blockedPatterns = [
    /\.env($|\..*)/i,
    /id_rsa($|\..*)/i,
    /\.git\/config/i,
    /\.ssh\//i,
    /\.gnupg\//i,
  ];

  constructor(workspaceRoot: string) {
    this.normalizedRoot = path.resolve(workspaceRoot);
  }

  public getWorkspaceRoot(): string {
    return this.normalizedRoot;
  }

  /**
   * Resolves a target path relative to workspace root and verifies it doesn't escape
   */
  public resolvePath(targetPath: string): string {
    const resolved = path.resolve(this.normalizedRoot, targetPath);

    // Check if the resolved path starts with the workspace root
    if (!resolved.startsWith(this.normalizedRoot)) {
      throw new Error(
        `[Security Error] Path '${targetPath}' escapes workspace root '${this.normalizedRoot}'`
      );
    }

    // Check against sensitive file patterns
    const relative = path.relative(this.normalizedRoot, resolved);
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(relative)) {
        throw new Error(
          `[Security Error] Access to sensitive file '${relative}' is strictly prohibited`
        );
      }
    }

    return resolved;
  }

  public isWithinWorkspace(targetPath: string): boolean {
    try {
      this.resolvePath(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
