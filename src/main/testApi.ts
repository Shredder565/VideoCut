import http from 'node:http';
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';

import type { TestApiRequest } from '../shared/api';

// A small local HTTP API for automated tests: POST /api/<action> with a JSON body, answered with JSON.
// Only started with --test-api <port>, and only listens on 127.0.0.1.
export function startTestApi(port: number, getWindow: () => BrowserWindow | undefined) {
  let nextId = 1;
  const pending = new Map<number, (result: { ok: boolean, value?: unknown, error?: string }) => void>();
  ipcMain.on('testResponse', (_e, id: number, result: { ok: boolean, value?: unknown, error?: string }) => {
    pending.get(id)?.(result);
    pending.delete(id);
  });

  const server = http.createServer((req, res) => {
    const match = /^\/api\/(open|clips|export|settings|state)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || match == null || req.headers.origin != null) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: unknown;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        body = text ? JSON.parse(text) : undefined;
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      const win = getWindow();
      if (win == null) {
        res.writeHead(503).end('no window');
        return;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, (result) => {
        res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      });
      const request: TestApiRequest = { id, action: match[1] as TestApiRequest['action'], body };
      win.webContents.send('testRequest', request);
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}
