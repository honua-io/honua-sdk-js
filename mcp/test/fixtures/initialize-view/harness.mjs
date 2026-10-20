import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

export const initialize = (view) => ({
  jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'honua-terminal-journey-driver', version: '1' },
    ...(view ? { _meta: { 'honua.io/workflow-view': view } } : {}),
  },
});
export const catalog = (view) => ({
  tools: Array.from({ length: view === 'setup' ? 25 : view === 'full' ? 32 : 12 }, (_, i) => ({
    name: `${view}_tool_${i}`, inputSchema: { type: 'object' },
    _meta: { 'fixture/descriptor': i },
  })),
  _meta: { view, revision: view === 'setup' ? 'setup.v2' : `${view}.v1`, 'fixture/opaque': [1, 'unchanged'] },
});

export async function startFixture(options = {}) {
  const sessions = new Map();
  const traffic = [];
  let nextSession = 0;
  const streams = new Set();
  let initializeNotificationComplete = false;
  const server = createServer(async (req, res) => {
    const getSession = req.headers['mcp-session-id'];
    if (req.method === 'GET' && options.sse && sessions.has(getSession)) {
      // Standalone server-to-client stream for notifications such as list_changed.
      traffic.push({ direction: 'http-get', session: getSession });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': getSession });
      res.flushHeaders();
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'DELETE' ? 204 : 405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const message = JSON.parse(body);
    let session = req.headers['mcp-session-id'];
    traffic.push({ direction: 'http-request', session: session ?? null, protocolVersion: req.headers['mcp-protocol-version'] ?? null, body });
    let result;
    if (message.method === 'initialize' && options.hangInitialize) {
      return;
    } else if (message.method === 'initialize') {
      session = `fixture-session-${++nextSession}`;
      sessions.set(session, message.params?._meta?.['honua.io/workflow-view'] ?? 'default');
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: false } },
        serverInfo: { name: 'honua.operator.mcp', version: 'v1' },
        _meta: { 'fixture/initialize': 'preserve' },
      };
    } else if (!sessions.has(session)) {
      res.writeHead(400).end('missing initialized session');
      return;
    } else if (message.id === undefined) {
      if (message.method === 'notifications/initialized' && options.initializedDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.initializedDelayMs));
        initializeNotificationComplete = true;
      }
      res.writeHead(202).end();
      return;
    } else if (options.initializedDelayMs && !initializeNotificationComplete) {
      res.writeHead(409).end('initialized notification not accepted yet');
      return;
    } else if (message.method === 'tools/list' && options.brokenSse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': session });
      // send() returns before this asynchronous reader failure.
      res.write('event: message\ndata: invalid-json\n\n');
      return;
    } else if (message.method === 'tools/list') {
      if (message.params?.view === 'full' && req.headers['x-api-key'] !== 'fixture-key') {
        res.writeHead(403).end('fixture authorization required');
        return;
      }
      result = catalog(message.params?.view ?? sessions.get(session));
    } else {
      result = { _meta: { view: sessions.get(session) }, content: [{ type: 'text', text: sessions.get(session) }] };
    }
    const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    traffic.push({ direction: 'http-response', session, body: response });
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`, traffic, sessions, streams,
    notify(message) {
      for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      return streams.size;
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export function startProxy(executable, url, apiKey = '') {
  const child = spawn(process.execPath, [executable], {
    env: { ...process.env, HONUA_MCP_REMOTE_URL: url, HONUA_MCP_AUTH_TOKEN: '', HONUA_ADMIN_KEY: '', HONUA_API_KEY: apiKey },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const traffic = [];
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];
  let stderr = '';
  const exited = once(child, 'exit');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    traffic.push({ direction: 'stdio-response', body: `${line}\n` });
    const message = JSON.parse(line);
    if (message.id === undefined) {
      notifications.push(message);
      for (const waiter of notificationWaiters.splice(0)) waiter();
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`proxy exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  const send = (message) => {
    const body = `${JSON.stringify(message)}\n`;
    traffic.push({ direction: 'stdio-request', body });
    child.stdin.write(body);
  };
  return {
    traffic, send, notifications,
    async waitForNotification(method, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!notifications.some((message) => message.method === method)) {
        if (Date.now() > deadline) throw new Error(`proxy did not relay ${method}: ${stderr}`);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 50);
          notificationWaiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
      return notifications.find((message) => message.method === method);
    },
    async expectExit() {
      let timer;
      try {
        return await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('proxy did not exit after upstream failure')), 3000);
        })]);
      } finally { clearTimeout(timer); }
    },
    request(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(message.id); reject(new Error(`proxy request timeout: ${stderr}`)); }, 10000);
        pending.set(message.id, { resolve, reject, timer });
        send(message);
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    },
  };
}
