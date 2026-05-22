// Load .env.local (Node doesn't do this automatically like Next.js does)
const { readFileSync, existsSync } = require('fs');
const envPath = require('path').join(__dirname, '.env.local');

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx <= 0) return null;
  const key = trimmed.slice(0, eqIdx).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return null;
  let value = trimmed.slice(eqIdx + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const parsed = parseEnvLine(line);
    if (parsed && !process.env[parsed.key]) process.env[parsed.key] = parsed.value;
  }
}

const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { setupWebSocket, setupBroadcastRoute } = require('./ws-server');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000');
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    // Don't let Next.js handle WebSocket upgrade path
    if (parsedUrl.pathname === '/ws' || parsedUrl.pathname === '/chat/ws') {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
      return;
    }
    handle(req, res, parsedUrl);
  });

  setupWebSocket(server);
  setupBroadcastRoute(server);

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
    console.log(`> WebSocket available at ws://localhost:${port}/ws`);
  });
});
