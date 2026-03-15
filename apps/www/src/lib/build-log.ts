import fs from 'fs';
import path from 'path';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import html from 'remark-html';

const buildLogPath = fs.existsSync(path.join(process.cwd(), 'content/build-log.md'))
  ? path.join(process.cwd(), 'content/build-log.md')
  : path.join(process.cwd(), 'apps/www/content/build-log.md');

export interface BuildEntry {
  date: string;
  title: string;
  contentHtml: string;
}

/**
 * Parse build-log.md into individual entries.
 * Each H2 (## Date — Title) starts a new entry.
 */
export async function getBuildEntries(): Promise<BuildEntry[]> {
  const raw = fs.readFileSync(buildLogPath, 'utf8');

  // Split on H2 headings, keeping the heading with its content
  const sections = raw.split(/(?=^## )/m).filter((s) => s.trim().startsWith('## '));

  const entries: BuildEntry[] = [];

  for (const section of sections) {
    // Extract heading: ## March 14, 2026 — Settlement, Scopes & Sovereign Commerce
    const headingMatch = section.match(/^## (.+?)(?:\s*[—–-]\s*(.+))?$/m);
    if (!headingMatch) continue;

    const date = headingMatch[1].trim();
    const title = headingMatch[2]?.trim() || '';

    // Everything after the heading is the content
    const content = section.replace(/^## .+\n+/, '');

    const processed = await remark()
      .use(remarkGfm)
      .use(html, { sanitize: false })
      .process(content);

    entries.push({
      date,
      title,
      contentHtml: processed.toString(),
    });
  }

  return entries;
}
