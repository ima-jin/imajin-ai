// #2384: this app is master of its own schema. createAppHealthHandler
// (packages/db/src/health-route.ts) is the single shared implementation
// every schema-owning app's own /api/health route uses, so this file only
// needs to name the app.
import { createAppHealthHandler } from '@imajin/db';

export const GET = createAppHealthHandler({ service: 'dykil' });
