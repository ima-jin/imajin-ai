const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { setupWebSocket, setupBroadcastRoute } = require('./ws-server');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3007');
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    // Don't let Next.js handle WebSocket upgrade path
    if (parsedUrl.pathname === '/ws') {
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
