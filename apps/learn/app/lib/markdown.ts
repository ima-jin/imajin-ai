/**
 * Simple markdown → HTML renderer for slide/lesson content.
 * No external dependencies. Supports: headings, bold, italic, code,
 * code blocks, bullet lists, markdown tables, and paragraphs.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function parseTable(lines: string[]): string {
  if (lines.length < 2) return lines.map(l => `<p>${parseInline(l)}</p>`).join('\n');

  // Parse header
  const headerCells = lines[0].split('|').map(c => c.trim()).filter(Boolean);

  // Parse alignment from separator row
  const sepCells = lines[1].split('|').map(c => c.trim()).filter(Boolean);
  const aligns = sepCells.map(cell => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });

  // Parse body rows
  const bodyRows = lines.slice(2).map(line =>
    line.split('|').map(c => c.trim()).filter(Boolean)
  );

  let html = '<div class="overflow-x-auto my-4"><table class="w-full text-sm border-collapse">';
  html += '<thead><tr>';
  headerCells.forEach((cell, i) => {
    const align = aligns[i] || 'left';
    html += `<th class="py-2 px-3 text-${align} border-b-2 border-current/20 font-semibold">${parseInline(cell)}</th>`;
  });
  html += '</tr></thead><tbody>';

  bodyRows.forEach(row => {
    html += '<tr>';
    row.forEach((cell, i) => {
      const align = aligns[i] || 'left';
      html += `<td class="py-2 px-3 text-${align} border-b border-current/10">${parseInline(cell)}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  return html;
}

export function simpleMarkdown(text: string): string {
  // Escape HTML first
  const escaped = escapeHtml(text);

  // Split into lines for block-level parsing
  const lines = escaped.split('\n');
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push(
        `<pre class="bg-current/5 border border-current/10 rounded-lg p-4 text-sm font-mono opacity-70 overflow-x-auto my-4"><code>${codeLines.join('\n')}</code></pre>`
      );
      continue;
    }

    // Tables — detect by | pipe characters and separator row
    if (line.includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+[-:|  ]+\s*\|?$/.test(lines[i + 1])) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push(parseTable(tableLines));
      continue;
    }

    // Headings
    if (line.startsWith('### ')) {
      blocks.push(`<h3 class="text-xl font-bold mb-3 mt-6">${parseInline(line.slice(4))}</h3>`);
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push(`<h2 class="text-2xl font-bold mb-4 mt-6">${parseInline(line.slice(3))}</h2>`);
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push(`<h1 class="text-3xl font-bold mb-6 mt-6">${parseInline(line.slice(2))}</h1>`);
      i++;
      continue;
    }

    // Bullet lists — collect consecutive - lines
    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(lines[i].slice(2));
        i++;
      }
      const lis = items.map(item => `<li class="flex gap-3"><span class="opacity-30 mt-0.5 shrink-0">—</span><span>${parseInline(item)}</span></li>`).join('');
      blocks.push(`<ul class="space-y-2 my-4">${lis}</ul>`);
      continue;
    }

    // Empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#') && !lines[i].startsWith('- ') && !lines[i].startsWith('```') && !(lines[i].includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+/.test(lines[i + 1] || ''))) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(`<p class="leading-relaxed mb-4">${parseInline(paraLines.join(' '))}</p>`);
    }
  }

  return blocks.join('\n');
}
