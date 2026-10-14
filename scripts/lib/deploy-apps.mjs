import { basename, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// The kernel anchors the monorepo's apps directory. External checkouts and
// multiple processes in apps/kernel (e.g. cron) are not separate builds.
export function deployApps(config) {
  const kernel = config.apps.find((app) => app.name?.endsWith('-jin'));
  if (!kernel?.cwd || basename(kernel.cwd) !== 'kernel') {
    throw new Error('Ecosystem must declare the kernel cwd');
  }
  const appsDir = dirname(kernel.cwd);
  return [...new Set(config.apps
    .filter((app) => app.cwd && dirname(app.cwd) === appsDir)
    .map((app) => basename(app.cwd)))];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.argv[2];
  if (env !== 'dev') {
    throw new Error('Usage: deploy-apps.mjs dev; prod ownership stays with the kernel until #2516');
  }
  const config = require(`../../deploy/ecosystem.${env}.config.js`);
  console.log(deployApps(config).join('\n'));
}
