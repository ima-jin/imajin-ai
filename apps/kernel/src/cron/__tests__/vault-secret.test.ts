import { describe, it, expect, vi } from 'vitest';
import {
  BOOTSTRAP_DID_ENV,
  BOOTSTRAP_PRIVATE_KEY_ENV,
  DEFAULT_VAULT_FETCH_TIMEOUT_MS,
  VAULT_FETCH_RETRY_INTERVAL_MS,
  loadCronSecretFromVault,
} from '../vault-secret';

const SECRET = 'vault-delivered-cron-secret';
const PRIVATE_KEY = 'bootstrap-private-key-for-tests';
const AUTH_URL = 'http://127.0.0.1:7000/auth';
const ENV = { [BOOTSTRAP_DID_ENV]: 'did:imajin:kernel-cron-test', [BOOTSTRAP_PRIVATE_KEY_ENV]: PRIVATE_KEY };

function credentials(value: string | null = SECRET) {
  const ack = { used: vi.fn(), failed: vi.fn(), discarded: vi.fn() };
  return {
    ack,
    result: {
      values: value === null ? {} : { CRON_SECRET: value },
      dids: {},
      degraded: [],
      acks: value === null ? {} : { CRON_SECRET: ack },
    },
  };
}

/** A clock that advances only when the retry loop sleeps. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe('loadCronSecretFromVault', () => {
  it('fetches the current grant by purpose as the bootstrap identity and returns the secret with its ack', async () => {
    const { result, ack } = credentials();
    const loadFromVault = vi.fn(async () => result);

    const fetched = await loadCronSecretFromVault(ENV, AUTH_URL, { loadFromVault });

    expect(fetched).toEqual({ secret: SECRET, ack });
    expect(loadFromVault).toHaveBeenCalledTimes(1);
    expect(loadFromVault).toHaveBeenCalledWith({
      resolveGrantByPurpose: 'kernel.cron-secret',
      purpose: 'kernel-cron.boot.cron-secret',
      keys: [{ key: 'CRON_SECRET', onMissing: 'fail' }],
      identity: { did: 'did:imajin:kernel-cron-test', privateKey: PRIVATE_KEY },
      authServiceUrl: AUTH_URL,
    });
    // The fetch itself never acks: the single ack is deferred to first use.
    expect(ack.used).not.toHaveBeenCalled();
    expect(ack.failed).not.toHaveBeenCalled();
    expect(ack.discarded).not.toHaveBeenCalled();
  });

  it('never reads a CRON_SECRET env var', async () => {
    const { result } = credentials();
    const loadFromVault = vi.fn(async () => result);
    const fetched = await loadCronSecretFromVault({ ...ENV, CRON_SECRET: 'hand-pasted' }, AUTH_URL, { loadFromVault });
    expect(fetched.secret).toBe(SECRET);
  });

  it('fails immediately, pointing at provisioning, when the bootstrap identity is missing', async () => {
    const loadFromVault = vi.fn();
    const failure = loadCronSecretFromVault({}, AUTH_URL, { loadFromVault });
    await expect(failure).rejects.toThrow(/KERNEL_CRON_VAULT_BOOTSTRAP_DID/);
    await expect(failure).rejects.toThrow(/provision-service-bootstrap/);
    expect(loadFromVault).not.toHaveBeenCalled();
  });

  it('treats a half-set identity pair as missing', async () => {
    const loadFromVault = vi.fn();
    await expect(
      loadCronSecretFromVault({ [BOOTSTRAP_DID_ENV]: 'did:imajin:x', [BOOTSTRAP_PRIVATE_KEY_ENV]: '  ' }, AUTH_URL, { loadFromVault }),
    ).rejects.toThrow(/not set/);
    expect(loadFromVault).not.toHaveBeenCalled();
  });

  it('retries while the kernel is still booting, then succeeds', async () => {
    const { result } = credentials();
    const loadFromVault = vi
      .fn()
      .mockRejectedValueOnce(new Error('loadFromVault: failed to obtain an auth challenge (status 502)'))
      .mockResolvedValueOnce(result);
    const clock = fakeClock();
    const log = vi.fn();

    const fetched = await loadCronSecretFromVault(ENV, AUTH_URL, { loadFromVault, ...clock, log });

    expect(fetched.secret).toBe(SECRET);
    expect(loadFromVault).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep).toHaveBeenCalledWith(VAULT_FETCH_RETRY_INTERVAL_MS);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', event: 'cron.vault-fetch-retry' }));
  });

  it('fails closed after the retry window with an error that points at the vault, not .env.local, and never echoes secrets', async () => {
    const loadFromVault = vi.fn().mockRejectedValue(new Error('loadFromVault: no active grant for purpose'));
    const clock = fakeClock();

    const failure = loadCronSecretFromVault({ ...ENV, CRON_VAULT_FETCH_TIMEOUT_MS: '12000' }, AUTH_URL, { loadFromVault, ...clock });

    await expect(failure).rejects.toThrow(/from the vault \(purpose 'kernel\.cron-secret'/);
    await expect(failure).rejects.toThrow(/no active grant for purpose/);
    await expect(failure).rejects.toThrow(/not an \.env\.local one/);
    await expect(failure).rejects.not.toThrow(new RegExp(PRIVATE_KEY));
    // 12s window at a 5s interval: attempts at t=0, 5, 10, then give up (15 > 12).
    expect(loadFromVault).toHaveBeenCalledTimes(3);
  });

  it('retries when the vault returns no value for the grant', async () => {
    const empty = credentials(null);
    const full = credentials();
    const loadFromVault = vi.fn().mockResolvedValueOnce(empty.result).mockResolvedValueOnce(full.result);
    const fetched = await loadCronSecretFromVault(ENV, AUTH_URL, { loadFromVault, ...fakeClock() });
    expect(fetched.secret).toBe(SECRET);
    expect(loadFromVault).toHaveBeenCalledTimes(2);
  });

  it('defaults the retry window to two minutes and ignores a nonsensical override', async () => {
    expect(DEFAULT_VAULT_FETCH_TIMEOUT_MS).toBe(120_000);
    const loadFromVault = vi.fn().mockRejectedValue(new Error('down'));
    const clock = fakeClock();
    await expect(
      loadCronSecretFromVault({ ...ENV, CRON_VAULT_FETCH_TIMEOUT_MS: 'soon' }, AUTH_URL, { loadFromVault, ...clock }),
    ).rejects.toThrow(/within 120s/);
  });
});
