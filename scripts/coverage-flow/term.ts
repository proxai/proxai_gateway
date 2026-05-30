// Terminal/render primitives: color setup, width detection, section dividers,
// and the responsive word-wrapping table. Pure presentation; no report content.

import chalk from 'chalk';

// CI logs are not a TTY, but GitHub's viewer renders ANSI -- force color there.
if (
  process.env['NO_COLOR'] === undefined &&
  process.env['GITHUB_ACTIONS'] === 'true' &&
  chalk.level === 0
) {
  chalk.level = 1;
}

export { chalk };

// Width of the report's own stdout: the live terminal when interactive, else
// COLUMNS or a sensible default.
export const TERM_WIDTH =
  process.stdout.columns !== undefined && process.stdout.columns > 0
    ? process.stdout.columns
    : Number.parseInt(process.env['COLUMNS'] ?? '', 10) || 120;

export function divider(): string {
  return chalk.cyan('='.repeat(Math.min(TERM_WIDTH, 100)));
}

export function section(title: string): string {
  const bar = divider();
  return `\n${bar}\n${chalk.bold.cyan(`  ${title.toUpperCase()}`)}\n${bar}`;
}

// Greedy word-wrap to `width`; words longer than the column (e.g. a file path)
// are hard-broken so nothing is ever truncated.
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = '';
  for (const rawWord of text.split(' ')) {
    let word = rawWord;
    while (word.length > width) {
      if (line !== '') {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (word === '') continue;
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}

export interface TableCell {
  text: string;
  width: number;
  align: 'left' | 'right';
  paint: (s: string) => string;
  // Fixed columns render only on the row's first physical line; wrapping columns
  // continue onto subsequent lines.
  firstLineOnly: boolean;
}

// One logical table row -> as many physical lines as the tallest wrapping cell
// needs, so every row fits the terminal width with nothing trimmed.
export function composeRow(cells: TableCell[], indent: string, gap: string): string[] {
  const wrapped = cells.map((c) => (c.firstLineOnly ? [c.text] : wrapText(c.text, c.width)));
  let height = 1;
  cells.forEach((c, i) => {
    if (!c.firstLineOnly) height = Math.max(height, wrapped[i]?.length ?? 1);
  });
  const phys: string[] = [];
  for (let r = 0; r < height; r++) {
    const parts = cells.map((c, i) => {
      const content = c.firstLineOnly ? (r === 0 ? c.text : '') : (wrapped[i]?.[r] ?? '');
      const padded = c.align === 'right' ? content.padStart(c.width) : content.padEnd(c.width);
      return content === '' ? padded : c.paint(padded);
    });
    phys.push(indent + parts.join(gap));
  }
  return phys;
}
