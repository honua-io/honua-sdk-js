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

export async function startFixture() {
  const sessions = new Map();
  const traffic = [];
  let nextSession = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'DELETE' ? 204 : 405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const message = JSON.parse(body);
    let session = req.headers['mcp-session-id'];
    traffic.push({ direction: 'http-request', session: session ?? null, body });
    let result;
    if (message.method === 'initialize') {
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
      res.writeHead(202).end();
      return;
    } else if (message.method === 'tools/list') {
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
    url: `http://127.0.0.1:${server.address().port}/mcp`, traffic, sessions,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export function startProxy(executable, url) {
  const child = spawn(process.execPath, [executable], {
    env: { ...process.env, HONUA_MCP_REMOTE_URL: url, HONUA_MCP_AUTH_TOKEN: '', HONUA_ADMIN_KEY: '', HONUA_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const traffic = [];
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    traffic.push({ direction: 'stdio-response', body: `${line}\n` });
    const message = JSON.parse(line);
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
    traffic, send,
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
