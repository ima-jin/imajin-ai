import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// Connection for queries
const client = postgres(connectionString);
export const db = drizzle(client, { schema });

// Re-export schema
export * from './schema';
