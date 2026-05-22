import fs from 'node:fs';
import path from 'node:path';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import html from 'remark-html';

const buildLogPath = path.join(process.cwd(), 'content/build-log.md');

export interface BuildEntry {
  date: string;
  title: string;
  contentHtml: string;
}

function splitSectionsByHeading(normalized: string): string[] {
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
  return sections;
}

function parseSectionHeader(section: string): { date: string; title: string; content: string } | null {
  const firstNewline = section.indexOf('\n');
  const headingLine = (firstNewline >= 0 ? section.slice(0, firstNewline) : section).trim();
  if (!headingLine.startsWith('## ')) return null;
  const headingBody = headingLine.slice(3).trim();
  const separatorIdx = headingBody.indexOf('—');
  const date = (separatorIdx >= 0 ? headingBody.slice(0, separatorIdx) : headingBody).trim();
  const title = (separatorIdx >= 0 ? headingBody.slice(separatorIdx + 1) : '').trim();
  const content = firstNewline >= 0 ? section.slice(firstNewline + 1).trimStart() : '';
  return { date, title, content };
}

/**
 * Parse build-log.md into individual entries.
 * Each H2 (## Date — Title) starts a new entry.
 */
export async function getBuildEntries(): Promise<BuildEntry[]> {
  const raw = fs.readFileSync(buildLogPath, 'utf8');
  const normalized = raw.split('\r\n').join('\n');
  const sections = splitSectionsByHeading(normalized);

  const entries: BuildEntry[] = [];

  for (const section of sections) {
    const parsed = parseSectionHeader(section);
    if (!parsed) continue;

    const processed = await remark()
      .use(remarkGfm)
      .use(html, { sanitize: false })
      .process(parsed.content);

    entries.push({
      date: parsed.date,
      title: parsed.title,
      contentHtml: processed.toString(),
    });
  }

  return entries;
}
