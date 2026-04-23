import type { ReactorHandler } from './types';

const handlers = new Map<string, ReactorHandler>();

export function registerReactor(type: string, handler: ReactorHandler): void {
  handlers.set(type, handler);
}

export function getReactor(type: string): ReactorHandler | undefined {
  return handlers.get(type);
}
