const { readFileSync, existsSync } = require('fs');

function parseEnvLine(line) {
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

function readEnvValueFromFile(envPath, targetKey) {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const parsed = parseEnvLine(line);
    if (parsed?.key === targetKey) return parsed.value;
  }
  return undefined;
}

function loadEnvFileIntoProcessEnv(envPath) {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const parsed = parseEnvLine(line);
    if (parsed && !process.env[parsed.key]) process.env[parsed.key] = parsed.value;
  }
}

module.exports = {
  parseEnvLine,
  readEnvValueFromFile,
  loadEnvFileIntoProcessEnv,
};
