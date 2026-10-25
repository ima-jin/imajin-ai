#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = 'https://api.github.com/repos/ima-jin/imajin-ai';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function loadToken() {
  const directory = process.env.CREDENTIALS_DIRECTORY ??
    '/run/credentials/infer-passthrough-update.service';
  return readFileSync(join(directory, 'github-token'), 'utf8').trim();
}

/** Only read operations; the credential never enters argv, logs or candidate env. */
export async function productionApproved(sha, readToken = loadToken) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Invalid release SHA');
  const token = readToken();
  if (!token) throw new Error('Missing deployment read credential');
  async function readApi(url) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Production deployment lookup failed');
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error('Invalid deployment API response');
    return body;
  }
  return checkPage(sha, readApi, 1);
}

async function checkPage(sha, readApi, page) {
  const url = new URL(`${API_ROOT}/deployments`);
  url.search = new URLSearchParams({
    sha, environment: 'production', per_page: String(PAGE_SIZE), page: String(page),
  }).toString();
  const deployments = await readApi(url);
  const matching = deployments.filter((deployment) =>
    deployment?.sha === sha && deployment.environment === 'production');
  if (await checkLatestStatus(matching, readApi)) return true;
  if (deployments.length < PAGE_SIZE) return false;
  if (page >= MAX_PAGES) throw new Error('Deployment pagination limit reached');
  return checkPage(sha, readApi, page + 1);
}

async function checkLatestStatus(deployments, readApi) {
  if (deployments.length === 0) return false;
  const [deployment, ...remaining] = deployments;
  if (!Number.isSafeInteger(deployment.id) || deployment.id <= 0) {
    throw new Error('Invalid deployment ID');
  }
  // Build our own fixed-origin URL; never follow API-supplied statuses_url.
  const url = new URL(`${API_ROOT}/deployments/${deployment.id}/statuses`);
  url.searchParams.set('per_page', '1');
  const statuses = await readApi(url);
  // GitHub returns statuses newest first. An older success cannot override it.
  if (statuses[0]?.state === 'success') return true;
  return checkLatestStatus(remaining, readApi);
}

export async function verifyProduction(sha) {
  try {
    if (await productionApproved(sha)) return 0;
    console.error('No successful production deployment for release SHA; current release unchanged');
    return 1;
  } catch {
    // Upstream bodies, errors and credentials must never reach the journal.
    console.error('Production deployment verification unavailable; current release unchanged');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  process.exitCode = await verifyProduction(process.argv[2]);
}
