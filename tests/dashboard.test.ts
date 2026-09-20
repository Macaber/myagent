import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { DashboardService } from '../dist/dashboard/dashboard-service.js';
import { handleDashboardHttpRequest } from '../dist/dashboard/dashboard-router.js';
import { HttpTransport } from '../dist/protocol/http-transport.js';
import { AgentDatabase } from '../dist/persistence/db.js';
import { TelemetryStore } from '../dist/persistence/telemetry-store.js';

describe('Agent Telemetry Dashboard & HTTP API', () => {
  let server: http.Server;
  let serverPort = 0;
  let testDbPath = '';

  before(async () => {
    // Start test HTTP server
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (handleDashboardHttpRequest(req, res, url)) return;
      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test('1. DashboardService scans databases and returns metadata', () => {
    const dbs = DashboardService.listDatabases();
    assert.ok(Array.isArray(dbs));
    assert.ok(dbs.length > 0, 'Should discover at least one database in ~/.myagent');

    const defaultDb = dbs.find((d) => d.isDefault);
    assert.ok(defaultDb, 'Should flag default database');
    assert.ok(defaultDb.name === 'data.db');
    assert.ok(typeof defaultDb.sizeFormatted === 'string');
  });

  test('2. DashboardService summarizes multiagent benchmark database with subagents', () => {
    const summary = DashboardService.getDashboardSummary('multiagent.db');
    assert.ok(summary.totalThreads >= 2, 'multiagent.db should have multiple threads');
    assert.ok(summary.subagentThreads >= 2, 'multiagent.db should have subagent threads');
    assert.ok(summary.totalTokens.total > 0, 'Total tokens should be tracked');
    assert.ok(summary.totalSteps > 0, 'Total steps should be tracked');
  });

  test('3. DashboardService constructs hierarchical thread tree with parent-child links', () => {
    const roots = DashboardService.getThreadList('multiagent.db');
    assert.ok(Array.isArray(roots));
    assert.ok(roots.length > 0);

    // Root threads should have null parentThreadId
    for (const root of roots) {
      assert.strictEqual(root.parentThreadId, null);
    }

    // At least one root thread should have children (the explore subagents from our live test)
    const threadWithSubagents = roots.find((r) => r.children.length > 0);
    assert.ok(threadWithSubagents, 'Should find parent thread with children subagents');
    assert.ok(threadWithSubagents.children.length >= 2, 'Parent should have at least 2 subagents');

    // Child should have explore role
    const firstChild = threadWithSubagents.children[0];
    assert.strictEqual(firstChild.parentThreadId, threadWithSubagents.threadId);
    assert.ok(firstChild.role.includes('explore'));
  });

  test('4. DashboardService retrieves granular thread detail with turns, steps, and tool usage', () => {
    const roots = DashboardService.getThreadList('multiagent.db');
    const target = roots.find((r) => r.children.length > 0) || roots[0];

    const detail = DashboardService.getThreadDetail('multiagent.db', target.threadId);
    assert.ok(detail, 'Thread detail should not be null');
    assert.strictEqual(detail.thread.threadId, target.threadId);
    assert.ok(detail.turns.length > 0, 'Should contain turn records');

    // Verify turn metrics aggregation
    const turn = detail.turns[0];
    assert.ok(typeof turn.metrics.toolCallsCount === 'number');
    assert.ok(typeof turn.metrics.subagentCallsCount === 'number');
    assert.ok(typeof turn.metrics.skillCallsCount === 'number');
    assert.ok(typeof turn.metrics.modelCallsCount === 'number');

    // Verify subagent summary on parent
    assert.ok(detail.subagentsSummary.length >= 2);
    assert.strictEqual(detail.subagentsSummary[0].role, 'explore');
  });

  test('5. DashboardService exports full database as structured JSON', () => {
    const fullExport = DashboardService.exportFullDatabaseJson('multiagent.db');
    assert.strictEqual(fullExport.exportVersion, '1.0');
    assert.ok(fullExport.exportedAt);
    assert.ok(fullExport.summary);
    assert.ok(Array.isArray(fullExport.threads));
  });

  test('6. HTTP Router serves /dashboard HTML and /api/dashboard/* endpoints', async () => {
    // 1. Test GET /dashboard
    const htmlRes = await fetch(`http://127.0.0.1:${serverPort}/dashboard`);
    assert.strictEqual(htmlRes.status, 200);
    assert.strictEqual(htmlRes.headers.get('content-type')?.includes('text/html'), true);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('MyAgent Telemetry'));
    assert.ok(htmlText.includes('id="thread-tree-list"'));

    // 2. Test GET /api/dashboard/databases
    const dbsRes = await fetch(`http://127.0.0.1:${serverPort}/api/dashboard/databases`);
    assert.strictEqual(dbsRes.status, 200);
    const dbs = await dbsRes.json();
    assert.ok(Array.isArray(dbs));

    // 3. Test GET /api/dashboard/summary?db=multiagent.db
    const summaryRes = await fetch(`http://127.0.0.1:${serverPort}/api/dashboard/summary?db=multiagent.db`);
    assert.strictEqual(summaryRes.status, 200);
    const summary = await summaryRes.json();
    assert.ok(summary.totalThreads > 0);

    // 4. Test GET /api/dashboard/threads?db=multiagent.db
    const threadsRes = await fetch(`http://127.0.0.1:${serverPort}/api/dashboard/threads?db=multiagent.db`);
    assert.strictEqual(threadsRes.status, 200);
    const threads = await threadsRes.json();
    assert.ok(Array.isArray(threads));

    // 5. Test GET /api/dashboard/thread/:threadId
    const threadId = threads[0].threadId;
    const detailRes = await fetch(`http://127.0.0.1:${serverPort}/api/dashboard/thread/${encodeURIComponent(threadId)}?db=multiagent.db`);
    assert.strictEqual(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.strictEqual(detail.thread.threadId, threadId);

    // 6. Test GET /api/dashboard/export
    const exportRes = await fetch(`http://127.0.0.1:${serverPort}/api/dashboard/export?db=multiagent.db`);
    assert.strictEqual(exportRes.status, 200);
    assert.ok(exportRes.headers.get('content-disposition')?.includes('attachment'));
    const exportData = await exportRes.json();
    assert.ok(exportData.exportVersion === '1.0');
  });

  test('7. HttpTransport natively serves /dashboard and /api/dashboard', async () => {
    const transport = new HttpTransport({ port: 0 });
    const port = await transport.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('MyAgent Telemetry'));

      const apiRes = await fetch(`http://127.0.0.1:${port}/api/dashboard/databases`);
      assert.strictEqual(apiRes.status, 200);
    } finally {
      await transport.close();
    }
  });
});
