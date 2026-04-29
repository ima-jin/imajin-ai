import { NextRequest, NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PM2_LOGS_DIR = join(homedir(), '.pm2', 'logs');

function getLogPath(service: string, type: 'out' | 'error'): string | null {
  // Try common pm2 log naming patterns
  const candidates = [
    join(PM2_LOGS_DIR, `${service}-${type}.log`),
    join(PM2_LOGS_DIR, `${service}.log`),
    join(PM2_LOGS_DIR, `${service}-${type}-0.log`),
    join(PM2_LOGS_DIR, `${service}-${type}.log.0`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function tailFile(filePath: string, lines: number): string {
  try {
    // execFileSync bypasses the shell — no injection risk
    return execFileSync('tail', ['-n', String(lines), filePath], { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return '';
  }
}

export const GET = withLogger('kernel', async (req: NextRequest, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const service = searchParams.get('service') || '';
  const lines = Math.min(500, Math.max(1, Number(searchParams.get('lines') || '100')));

  if (!service) {
    return NextResponse.json({ error: 'Missing service' }, { status: 400 });
  }

  // Sanitize service name to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(service)) {
    return NextResponse.json({ error: 'Invalid service name' }, { status: 400 });
  }

  const outPath = getLogPath(service, 'out');
  const errPath = getLogPath(service, 'error');

  const out = outPath ? tailFile(outPath, lines) : '';
  const err = errPath ? tailFile(errPath, lines) : '';

  log.info({ service, lines, outPath: outPath ?? null, errPath: errPath ?? null }, 'raw logs fetched');

  return NextResponse.json({
    service,
    lines,
    out: outPath ? { path: outPath, content: out } : null,
    err: errPath ? { path: errPath, content: err } : null,
  });
});
