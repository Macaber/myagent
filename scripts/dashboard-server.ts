import * as http from 'node:http';
import { exec } from 'node:child_process';
import { handleDashboardHttpRequest } from '../dist/dashboard/dashboard-router.js';
import { getMyAgentHome, getDefaultDbPath } from '../dist/config/paths.js';

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd = '';
  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      // Ignored: headless or user terminal
    }
  });
}

function startServer(initialPort: number = 3000): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    let port = initialPort;

    function tryListen() {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        // Redirect root / to /dashboard
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(302, { Location: '/dashboard' });
          res.end();
          return;
        }

        if (handleDashboardHttpRequest(req, res, url)) {
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      });

      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          port++;
          server.close();
          tryListen();
        } else {
          reject(err);
        }
      });

      server.listen(port, '127.0.0.1', () => {
        resolve({ server, port });
      });
    }

    tryListen();
  });
}

async function main() {
  const requestedPort = parseInt(process.env.PORT || '3000', 10);
  const { port } = await startServer(requestedPort);

  const dashboardUrl = `http://127.0.0.1:${port}/dashboard`;
  const dbHome = getMyAgentHome();
  const defaultDb = getDefaultDbPath();

  console.log('\n\x1b[36m╔══════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[36m║                  MyAgent Telemetry Dashboard                     ║\x1b[0m');
  console.log('\x1b[36m╠══════════════════════════════════════════════════════════════════╣\x1b[0m');
  console.log(`\x1b[36m║\x1b[0m  \x1b[1mDashboard URL:\x1b[0m  \x1b[32m${dashboardUrl}\x1b[0m`);
  console.log(`\x1b[36m║\x1b[0m  \x1b[1mStorage Home:\x1b[0m   \x1b[33m${dbHome}\x1b[0m`);
  console.log(`\x1b[36m║\x1b[0m  \x1b[1mDefault DB:\x1b[0m     \x1b[35m${defaultDb}\x1b[0m`);
  console.log('\x1b[36m╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n');
  console.log(`[Dashboard] 正在自动在浏览器中打开看板页面... (按 Ctrl+C 退出)`);

  if (!process.env.NO_OPEN) {
    openBrowser(dashboardUrl);
  }
}

main().catch((err) => {
  console.error('[Dashboard Server Error]:', err);
  process.exit(1);
});
