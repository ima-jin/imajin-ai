import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

/**
 * Shared boilerplate for `app/<service>/api/spec/__tests__/route.test.ts` (#1997).
 *
 * Every kernel spec route (chat, calendar, ...) is a static-file server with
 * an identical contract: pin `process.cwd()` to `apps/kernel`, call its `GET`
 * handler, and return the YAML text it serves. Only the per-service path
 * assertions differ, so this fetch-and-decode plumbing — plus resolving
 * `apps/kernel` from the test file's own location, five levels below it at
 * `app/<service>/api/spec/__tests__/` — was duplicated verbatim across every
 * spec-route test file before this extraction (SonarCloud flagged the
 * chat/calendar overlap as new-code duplication on #2131).
 *
 * Pass the test file's own `import.meta.url` so `apps/kernel` resolves
 * relative to whichever service's `__tests__` directory calls in.
 */
export async function renderSpecRoute(
  getHandler: () => Promise<Response>,
  testFileUrl: string,
): Promise<{ res: Response; body: string }> {
  const kernelRoot = resolve(dirname(fileURLToPath(testFileUrl)), '../../../../..');
  vi.spyOn(process, 'cwd').mockReturnValue(kernelRoot);

  const res = await getHandler();
  const body = await res.text();
  return { res, body };
}
