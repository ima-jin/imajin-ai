import { getClient } from './client';

/** Checks the application's real pool, not a separate emergency connection. */
export async function checkDatabaseLiveness(timeoutMs = 1500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = getClient().unsafe('SELECT 1');
    return await Promise.race([
      Promise.resolve(pending).then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => { resolve(false); pending.cancel(); }, timeoutMs);
      }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
