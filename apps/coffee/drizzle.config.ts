import { readFileSync, existsSync } from "fs";
const envPath = ".env.local";

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx <= 0) return null;
  const key = trimmed.slice(0, eqIdx).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return null;
  let value = trimmed.slice(eqIdx + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const parsed = parseEnvLine(line);
    if (parsed && !process.env[parsed.key]) process.env[parsed.key] = parsed.value;
  }
}


import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['coffee'],
});
