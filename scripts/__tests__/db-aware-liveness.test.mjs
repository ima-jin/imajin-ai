import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { checkHealth, createProbe, POLICY } from '../../deploy/liveness-probe.mjs';
import { readFile } from 'node:fs/promises';

let server;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = undefined;
  }
});
it('restarts only prod-jin on DB-health 503, delivers a receipt and retains cooldown', async () => {
  let database = false;
  server = createServer((_req, res) => { res.writeHead(database ? 200 : 503); res.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = { app: 'prod-jin', port: server.address().port };
  const restart = vi.fn(async () => { database = true; });
  const deliver = vi.fn(async () => true);
  const probe = createProbe({}, { restart, deliver, pid: async () => 1 }, { ...POLICY, startupGraceMs: 0 });
  for (let i = 0; i < 3; i++) await probe.tick([target], { execute: true, kernelPort: target.port });
  expect(restart).toHaveBeenCalledOnce();
  expect(restart).toHaveBeenCalledWith('prod-jin');
  expect(deliver).toHaveBeenCalledOnce();
  expect(await checkHealth(target)).toBe(true);
  database = false;
  for (let i = 0; i < 3; i++) await probe.tick([target], { execute: true, kernelPort: target.port });
  expect(restart).toHaveBeenCalledOnce();
});
it('documents exact idempotent install/enable and verification for both instances', async () => {
  const readme = await readFile(new URL('../../deploy/README.md', import.meta.url), 'utf8');
  expect(readme).toContain('sudo install -m 0644');
  expect(readme).toContain('sudo systemctl daemon-reload');
  for (const action of ['enable --now', 'is-enabled', 'is-active']) {
    expect(readme).toContain(`sudo systemctl ${action} imajin-liveness@dev.service imajin-liveness@prod.service`);
  }
});
