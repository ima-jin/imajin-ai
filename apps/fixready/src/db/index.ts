import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

// For MVP, we'll use a mock database if DATABASE_URL is not set
const connectionString = process.env.DATABASE_URL || '';

const sql = neon(connectionString);
export const db = drizzle(sql, { schema });
