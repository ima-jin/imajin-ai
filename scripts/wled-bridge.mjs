#!/usr/bin/env node
/**
 * WLED Bridge — listens for check-in webhooks and flashes a WLED unit.
 *
 * Usage:
 *   UNIT_IP=192.168.1.149 node scripts/wled-bridge.mjs
 *   UNIT_IP=192.168.1.149 PORT=8080 FLASH_COLOR=255,0,0 node scripts/wled-bridge.mjs
 */

import http from 'node:http';

// --- Config -----------------------------------------------------------

function parseRgb(str, fallback) {
  const parts = (str || '').split(',').map(Number);
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) return parts;
  return fallback;
}

const UNIT_IP = process.env.UNIT_IP || null;
const PORT = parseInt(process.env.PORT || '7890', 10);
const FLASH_COLOR = parseRgb(process.env.FLASH_COLOR, [0, 255, 0]);
const AMBIENT_COLOR = parseRgb(process.env.AMBIENT_COLOR, [255, 165, 0]);
const FLASH_DURATION_MS = parseInt(process.env.FLASH_DURATION_MS || '3000', 10);
const AMBIENT_BRI = parseInt(process.env.AMBIENT_BRI || '128', 10);
const FLASH_BRI = parseInt(process.env.FLASH_BRI || '255', 10);

if (!UNIT_IP) {
  console.error('Error: UNIT_IP is required. Set it as an environment variable.');
  console.error('  UNIT_IP=192.168.1.149 node scripts/wled-bridge.mjs');
  process.exit(1);
}

// --- WLED API ---------------------------------------------------------

function wledPost(state) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(state);
    const req = http.request(
      {
        hostname: UNIT_IP,
        port: 80,
        path: '/json/state',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('WLED request timed out')));
    req.write(body);
    req.end();
  });
}

async function flash() {
  try {
    await wledPost({ on: true, bri: FLASH_BRI, seg: [{ col: [FLASH_COLOR] }] });
    console.log(`  → WLED flash rgb(${FLASH_COLOR.join(',')}) sent`);
  } catch (err) {
    console.error(`  → WLED flash failed: ${err.message}`);
  }

  setTimeout(async () => {
    try {
      await wledPost({ on: true, bri: AMBIENT_BRI, seg: [{ col: [AMBIENT_COLOR] }] });
      console.log(`  → WLED ambient rgb(${AMBIENT_COLOR.join(',')}) restored`);
    } catch (err) {
      console.error(`  → WLED ambient restore failed: ${err.message}`);
    }
  }, FLASH_DURATION_MS);
}

// --- HTTP Server ------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        unitIp: UNIT_IP,
        flashColor: FLASH_COLOR,
        ambientColor: AMBIENT_COLOR,
        flashDurationMs: FLASH_DURATION_MS,
      })
    );
    return;
  }

  if (req.method === 'POST') {
    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (payload.event !== 'checkin') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: true }));
      return;
    }

    console.log(
      `\nCheck-in: ${payload.eventTitle || payload.eventId} — ticket ${payload.ticketId}`
    );
    console.log(
      `  owner: ${payload.ownerDid || 'unknown'} | attendees so far: ${payload.attendeeCount}`
    );

    flash();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  const rgb = (c) => `rgb(${c.join(',')})`;
  console.log(`WLED Bridge listening on :${PORT}`);
  console.log(`Unit IP: ${UNIT_IP}`);
  console.log(`Flash: ${rgb(FLASH_COLOR)} for ${FLASH_DURATION_MS}ms → ambient ${rgb(AMBIENT_COLOR)}`);
  console.log('');
  console.log('Usage:');
  console.log(`  UNIT_IP=${UNIT_IP} node scripts/wled-bridge.mjs`);
  console.log(
    `  UNIT_IP=${UNIT_IP} PORT=8080 FLASH_COLOR=255,0,0 node scripts/wled-bridge.mjs`
  );
});
