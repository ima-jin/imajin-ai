import fs from 'fs';
import path from 'path';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import html from 'remark-html';

const buildLogPath = path.join(process.cwd(), 'content/build-log.md');

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
  const normalized = raw.split('\r\n').join('\n');

  // Split on H2 headings, keeping the heading with its content
  const sections: string[] = [];
  let current = '';
  for (const line of normalized.split('\n')) {
    if (line.startsWith('## ')) {
      if (current.trim()) sections.push(current);
      current = `${line}\n`;
      continue;
    }
    if (current) current += `${line}\n`;
  }
  if (current.trim()) sections.push(current);

  const entries: BuildEntry[] = [];

  for (const section of sections) {
    // Extract heading: ## March 12–14, 2026 — Title
    // Use em-dash (—) as the separator between date and title.
    // En-dashes (–) and hyphens (-) in date ranges must NOT be treated as separators.
    const firstNewline = section.indexOf('\n');
    const headingLine = (firstNewline >= 0 ? section.slice(0, firstNewline) : section).trim();
    if (!headingLine.startsWith('## ')) continue;
    const headingBody = headingLine.slice(3).trim();
    const separatorIdx = headingBody.indexOf('—');
    const date = (separatorIdx >= 0 ? headingBody.slice(0, separatorIdx) : headingBody).trim();
    const title = (separatorIdx >= 0 ? headingBody.slice(separatorIdx + 1) : '').trim();

    // Everything after the heading is the content
    const content = firstNewline >= 0 ? section.slice(firstNewline + 1).trimStart() : '';

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
