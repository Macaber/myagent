import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardService } from './dashboard-service.js';

function getDashboardHtmlPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // Candidate 1: relative to current file in dist or src: ./public/index.html
  const cand1 = path.join(currentDir, 'public', 'index.html');
  if (fs.existsSync(cand1)) return cand1;

  // Candidate 2: in src/dashboard/public/index.html
  const cand2 = path.resolve(process.cwd(), 'src', 'dashboard', 'public', 'index.html');
  if (fs.existsSync(cand2)) return cand2;

  // Candidate 3: in dist/dashboard/public/index.html
  const cand3 = path.resolve(process.cwd(), 'dist', 'dashboard', 'public', 'index.html');
  if (fs.existsSync(cand3)) return cand3;

  return cand1;
}

// Cache dashboard HTML in memory (mtime-guarded) instead of readFileSync per request
let cachedHtml: { mtimeMs: number; size: number; content: string; etag: string } | null = null;

function getCachedDashboardHtml(htmlPath: string): { content: string; etag: string } | null {
  try {
    const stat = fs.statSync(htmlPath);
    if (
      cachedHtml &&
      cachedHtml.mtimeMs === stat.mtimeMs &&
      cachedHtml.size === stat.size
    ) {
      return { content: cachedHtml.content, etag: cachedHtml.etag };
    }
    const content = fs.readFileSync(htmlPath, 'utf8');
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    cachedHtml = { mtimeMs: stat.mtimeMs, size: stat.size, content, etag };
    return { content, etag };
  } catch {
    cachedHtml = null;
    return null;
  }
}

// Bounded JSON body reader for dashboard POST routes (1MB cap, fail-closed)
function readBoundedJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onBody: (payload: any) => void
): void {
  let body = '';
  let rejected = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (rejected) return;
    body += chunk;
    if (body.length > 1024 * 1024) {
      rejected = true;
      try {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large (max 1MB)' }));
      } catch {}
      try {
        req.destroy();
      } catch {}
    }
  });
  req.on('end', () => {
    if (rejected) return;
    try {
      onBody(JSON.parse(body || '{}'));
    } catch (err: any) {
      try {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
      } catch {}
    }
  });
}

export function handleDashboardHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): boolean {
  const pathname = url.pathname;

  // 1. Static Dashboard HTML
  if (req.method === 'GET' && (pathname === '/dashboard' || pathname === '/dashboard/' || pathname === '/dashboard/index.html')) {
    const htmlPath = getDashboardHtmlPath();
    const cached = getCachedDashboardHtml(htmlPath);
    if (cached) {
      if (req.headers['if-none-match'] === cached.etag) {
        res.writeHead(304);
        res.end();
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        ETag: cached.etag,
      });
      res.end(cached.content);
      return true;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Dashboard HTML file not found');
      return true;
    }
  }

  // 2. API Routes
  if (!pathname.startsWith('/api/dashboard/')) {
    return false;
  }

  const requestedDb = url.searchParams.get('db') || undefined;

  // GET /api/dashboard/databases
  if (req.method === 'GET' && pathname === '/api/dashboard/databases') {
    const dbs = DashboardService.listDatabases();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dbs));
    return true;
  }

  // GET /api/dashboard/summary
  if (req.method === 'GET' && pathname === '/api/dashboard/summary') {
    const summary = DashboardService.getDashboardSummary(requestedDb);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    return true;
  }

  // GET /api/dashboard/sessions & GET /api/dashboard/threads
  if (req.method === 'GET' && (pathname === '/api/dashboard/sessions' || pathname === '/api/dashboard/threads')) {
    const sessions = DashboardService.getSessionList(requestedDb);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return true;
  }

  // GET /api/dashboard/session/:id & GET /api/dashboard/thread/:id
  const isSessionGet = pathname.startsWith('/api/dashboard/session/') || pathname === '/api/dashboard/session';
  const isThreadGet = pathname.startsWith('/api/dashboard/thread/') || pathname === '/api/dashboard/thread';
  if (req.method === 'GET' && (isSessionGet || isThreadGet)) {
    let id = url.searchParams.get('id') || '';
    if (pathname.startsWith('/api/dashboard/session/')) {
      id = decodeURIComponent(pathname.substring('/api/dashboard/session/'.length));
    } else if (pathname.startsWith('/api/dashboard/thread/')) {
      id = decodeURIComponent(pathname.substring('/api/dashboard/thread/'.length));
    }

    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId is required' }));
      return true;
    }

    const detail = DashboardService.getSessionDetail(requestedDb, id);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Session ${id} not found` }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
    return true;
  }

  // GET /api/dashboard/export (streamed: O(1) memory, capped sessions)
  if (req.method === 'GET' && pathname === '/api/dashboard/export') {
    const dbName = requestedDb || 'data.db';
    const filename = `myagent-export-${dbName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.json`;
    const limitRaw = Number(url.searchParams.get('limit') || '');
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 5000) : 500;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Transfer-Encoding': 'chunked',
    });
    try {
      DashboardService.streamDatabaseExport(
        requestedDb,
        (chunk) => {
          try {
            res.write(chunk);
          } catch {}
        },
        undefined,
        { limit }
      );
    } catch (err: any) {
      try {
        res.write(JSON.stringify({ exportError: err?.message || String(err) }));
      } catch {}
    }
    try {
      res.end();
    } catch {}
    return true;
  }

  // POST /api/dashboard/session/set-status & POST /api/dashboard/thread/set-status
  if (req.method === 'POST' && (pathname === '/api/dashboard/session/set-status' || pathname === '/api/dashboard/thread/set-status')) {
    readBoundedJsonBody(req, res, (payload) => {
      try {
        const id = payload.sessionId || payload.threadId;
        const status = payload.status || 'SUSPENDED';
        const db = payload.db || requestedDb;

        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId is required' }));
          return;
        }

        const success = DashboardService.updateSessionStatus(db, id, status);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success, sessionId: id, threadId: id, status }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/dashboard/session/resume & POST /api/dashboard/thread/resume
  if (req.method === 'POST' && (pathname === '/api/dashboard/session/resume' || pathname === '/api/dashboard/thread/resume')) {
    readBoundedJsonBody(req, res, async (payload) => {
      try {
        const id = payload.sessionId || payload.threadId;
        const prompt = payload.prompt;
        const mode = payload.mode || 'continue';
        const db = payload.db || requestedDb;

        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId is required' }));
          return;
        }

        const autoDiscoverProvider = payload.autoDiscoverProvider;
        const result = await DashboardService.resumeSession(db, id, { prompt, mode, autoDiscoverProvider });
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/dashboard/session/delete & POST /api/dashboard/thread/delete
  if (req.method === 'POST' && (pathname === '/api/dashboard/session/delete' || pathname === '/api/dashboard/thread/delete')) {
    readBoundedJsonBody(req, res, (payload) => {
      try {
        const id = payload.sessionId || payload.threadId;
        const db = payload.db || requestedDb;

        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId is required' }));
          return;
        }

        const success = DashboardService.deleteSession(db, id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success, sessionId: id, threadId: id }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/dashboard/database/clear
  if (req.method === 'POST' && pathname === '/api/dashboard/database/clear') {
    readBoundedJsonBody(req, res, (payload) => {
      try {
        const db = payload.db || requestedDb;
        const success = DashboardService.clearDatabaseHistory(db);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success, db: db || 'data.db' }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  return false;
}
