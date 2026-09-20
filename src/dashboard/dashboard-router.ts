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

export function handleDashboardHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): boolean {
  const pathname = url.pathname;

  // 1. Static Dashboard HTML
  if (req.method === 'GET' && (pathname === '/dashboard' || pathname === '/dashboard/' || pathname === '/dashboard/index.html')) {
    const htmlPath = getDashboardHtmlPath();
    if (fs.existsSync(htmlPath)) {
      const content = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
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

  // GET /api/dashboard/export
  if (req.method === 'GET' && pathname === '/api/dashboard/export') {
    const fullJson = DashboardService.exportFullDatabaseJson(requestedDb);
    const dbName = requestedDb || 'data.db';
    const filename = `myagent-export-${dbName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.json`;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.end(JSON.stringify(fullJson, null, 2));
    return true;
  }

  // POST /api/dashboard/session/set-status & POST /api/dashboard/thread/set-status
  if (req.method === 'POST' && (pathname === '/api/dashboard/session/set-status' || pathname === '/api/dashboard/thread/set-status')) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
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
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
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
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
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
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
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
