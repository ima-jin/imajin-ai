import { expect, it } from 'vitest';
import { isDatabaseTimeout, databaseTimeoutResponse } from '../database-timeout';

it.each([null, 'DB_ACQUIRE_TIMEOUT', new Error('DB_QUERY_TIMEOUT'),
  Object.assign(new Error('unknown'), { name: 'DatabaseTimeoutError', code: 'OTHER' }),
])('does not map an unrelated error to a retryable response', error => {
  expect(isDatabaseTimeout(error)).toBe(false);
  expect(databaseTimeoutResponse(error, {})).toBeUndefined();
});

it('terminates cyclic cause traversal', () => {
  const error = new Error('cycle');
  error.cause = error;
  expect(isDatabaseTimeout(error)).toBe(false);
});
