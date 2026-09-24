import * as fs from 'node:fs';
import * as path from 'node:path';

export class WorkspaceJail {
  private readonly normalizedRoot: string;
  private readonly blockedPatterns = [
    /\.env($|\..*)/i,
    /id_rsa($|\..*)/i,
    /\.git\/config/i,
    /\.ssh\//i,
    /\.gnupg\//i,
    /\.pem$/i,
    /\.key$/i,
    /\.p12$/i,
    /\.pfx$/i,
    /\.aws\//i,
    /\.docker\/config\.json/i,
    /\.npmrc$/i,
    /credentials/i,
    /secrets?/i,
    /token/i,
    /\.pki\//i,
  ];

  constructor(workspaceRoot: string) {
    this.normalizedRoot = path.resolve(workspaceRoot);
  }

  public getWorkspaceRoot(): string {
    return this.normalizedRoot;
  }

  /**
   * Resolves a target path relative to workspace root and verifies it doesn't escape.
   * Uses realpath for existing paths to defeat symlink escapes, plus a
   * separator-aware prefix check to block sibling-prefix bypass (ws vs ws2).
   */
  public resolvePath(targetPath: string): string {
    const resolved = path.resolve(this.normalizedRoot, targetPath);

    // Separator-aware containment (blocks /tmp/ws2 escaping /tmp/ws)
    const rootWithSep = this.normalizedRoot.endsWith(path.sep)
      ? this.normalizedRoot
      : this.normalizedRoot + path.sep;
    if (resolved !== this.normalizedRoot && !resolved.startsWith(rootWithSep)) {
      throw new Error(
        `[Security Error] Path '${targetPath}' escapes workspace root '${this.normalizedRoot}'`
      );
    }

    // Symlink-aware check: resolve existing paths (or nearest existing parent).
    // Best-effort only — if nothing on disk exists yet (e.g. fresh workspace),
    // skip symlink verification and rely on the prefix + pattern checks.
    try {
      let checkPath = resolved;
      let resolvedSomething = false;
      try {
        checkPath = fs.realpathSync(resolved);
        resolvedSomething = true;
      } catch {
        // Target may not exist yet — resolve nearest existing ancestor
        let dir = path.dirname(resolved);
        let suffix = path.basename(resolved);
        for (let depth = 0; depth < 8; depth++) {
          try {
            const realDir = fs.realpathSync(dir);
            checkPath = path.join(realDir, suffix);
            resolvedSomething = true;
            break;
          } catch {
            suffix = path.join(path.basename(dir), suffix);
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
        }
      }
      if (!resolvedSomething) {
        // Nothing verifiable on disk — skip to pattern checks.
      } else if (checkPath !== this.normalizedRoot && !checkPath.startsWith(rootWithSep)) {
        // Re-check against real root in case root itself is a symlink (e.g. /tmp on macOS)
        let realRoot: string | null = null;
        try {
          realRoot = fs.realpathSync(this.normalizedRoot);
        } catch {
          realRoot = null;
        }
        if (realRoot === null) {
          // Root doesn't exist yet — prefix check above already passed, skip.
        } else {
          const realRootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
          if (checkPath !== realRoot && !checkPath.startsWith(realRootSep)) {
            throw new Error(
              `[Security Error] Path '${targetPath}' escapes workspace root via symlink`
            );
          }
        }
      }
    } catch (err: any) {
      if (err?.message?.startsWith('[Security Error]')) throw err;
      // Non-security fs errors fall through to pattern checks below
    }

    // Check against sensitive file patterns (relative path + basename)
    const relative = path.relative(this.normalizedRoot, resolved);
    const basename = path.basename(resolved);
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(relative) || pattern.test(basename)) {
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
