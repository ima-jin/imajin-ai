#!/usr/bin/env node
// Shared by staged deployment, post-restart validation and the release check.
export async function checkHealth(port = '8787', attempts = 10) {
  const numericPort = Number.parseInt(port, 10);
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 ||
      !Number.isInteger(attempts) || attempts < 1 || attempts > 30) {
    console.error('Invalid health port or attempts (1–30)');
    return 2;
  }

  // Host/path are fixed; a CLI argument can only select a validated numeric port.
  const url = new URL('http://127.0.0.1/health');
  url.port = String(numericPort);
  return pollHealth(url, attempts);
}

async function pollHealth(url, remaining) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(25_000),
      redirect: 'error',
    });
    const body = await response.json();
    if (response.ok && body?.ok === true && Array.isArray(body.routes) &&
        body.routes.length > 0 && body.routes.every((route) => route?.ok === true)) return 0;
  } catch {
    // Never echo arbitrary response bodies, credentials or fetch errors.
  }
  if (remaining > 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return pollHealth(url, remaining - 1);
  }
  console.error('Mint health failed on /health; inspect route readiness for the cause and remedy');
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  process.exitCode = await checkHealth(process.argv[2], Number(process.env.INFER_HEALTH_ATTEMPTS ?? 10));
}
