import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createProbe, POLICY } from '../deploy/liveness-probe.mjs';

/** No DB credentials or real pm2 commands: a real HTTP 503 stub and virtual minute ticks. */
export async function reproduceDatabaseWatchdog() {
  let healthy = false;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/health?liveness=1');
    response.writeHead(healthy ? 200 : 503);
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = { app: 'prod-jin', port: server.address().port };
  const restarts = [];
  let now = 0;
  let saved = {};
  try {
    for (let tick = 0; tick < 4; tick++) {
      // New probe each minute, like the cron entry: counters survive exit.
      const probe = createProbe(saved, {
        now: () => now, pid: async () => 123,
        restart: async app => { restarts.push(app); healthy = true; },
        deliver: async () => true,
        persist: async state => { saved = JSON.parse(JSON.stringify(state)); },
      }, POLICY);
      await probe.tick([target], { execute: true, kernelPort: target.port });
      assert.equal(restarts.length, tick < 2 ? 0 : 1);
      now += 60_000;
    }
    assert.deepEqual(restarts, ['prod-jin']);
    assert.equal(saved.apps['prod-jin'].failures, 0);
    return { failures: 3, restarts: restarts.length, recovered: healthy };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.info(JSON.stringify(await reproduceDatabaseWatchdog()));
}
