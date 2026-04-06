import { randomBytes } from 'crypto';

export function generateId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}
