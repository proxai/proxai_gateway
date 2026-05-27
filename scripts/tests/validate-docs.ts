import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const DOCS_DIR = resolve(import.meta.dirname, '../../docs');

interface Issue {
  file: string;
  type: 'timestamp' | 'link' | 'anchor' | 'mermaid';
  message: string;
}

const issues: Issue[] = [];

async function walk(dir: string, callback: (path: string) => Promise<void>) {
  const entries = await readdir(dir, { withFileTypes: true });
  const promises: Promise<void>[] = [];
  for (const entry of entries) {
    const res = join(dir, entry.name);
    if (entry.isDirectory()) {
      promises.push(walk(res, callback));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      promises.push(callback(res));
    }
  }
  await Promise.all(promises);
}

// Map of file path -> Set of heading slugs
const headingSlugsCache = new Map<string, Set<string>>();

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // remove special chars
    .replace(/\s+/g, '-') // replace spaces with hyphens
    .replace(/-+/g, '-') // remove multiple consecutive hyphens
    .trim();
}

async function getHeadingSlugs(filePath: string): Promise<Set<string>> {
  const cached = headingSlugsCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  const slugs = new Set<string>();
  if (!existsSync(filePath)) {
    return slugs;
  }
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match && match[2] !== undefined) {
      const headingText = match[2].trim();
      // Support custom anchor overrides if any, otherwise standard slug
      const slugMatch = headingText.match(/(.+)\s+\{#(.+)\}/);
      if (slugMatch && slugMatch[2] !== undefined) {
        slugs.add(slugMatch[2].trim());
      } else {
        slugs.add(slugify(headingText));
      }
    }
  }
  headingSlugsCache.set(filePath, slugs);
  return slugs;
}

await walk(DOCS_DIR, async (filePath) => {
  const relativeFilePath = filePath.replace(DOCS_DIR + '/', '');
  const content = await readFile(filePath, 'utf-8');

  // 1. Verify timestamp presence right below H1 (skip for architecture diagrams)
  if (!relativeFilePath.startsWith('architecture/')) {
    const lines = content.split('\n');
    const h1Index = lines.findIndex((l) => l.startsWith('# '));
    if (h1Index === -1) {
      issues.push({
        file: relativeFilePath,
        type: 'timestamp',
        message: 'No H1 heading found in the document.',
      });
    } else {
      // Look in the next few lines for the Last Updated timestamp
      let foundTimestamp = false;
      for (let i = h1Index + 1; i <= Math.min(h1Index + 4, lines.length - 1); i++) {
        const line = lines[i];
        if (line !== undefined && line.includes('Last Updated: 2026-05-27')) {
          foundTimestamp = true;
          break;
        }
      }
      if (!foundTimestamp) {
        issues.push({
          file: relativeFilePath,
          type: 'timestamp',
          message:
            'Could not find standard "*Last Updated: 2026-05-27*" timestamp right below the H1 heading.',
        });
      }
    }
  }

  // 2. Parse and verify relative links
  // Match relative links e.g. [foo](./bar.md#section) or [baz](../baz/README.md)
  // Negative lookahead to skip full HTTP URLs and email links
  const linkRegex = /\[([^\]]+)\]\(((?!\/)(?!\w+:\/\/)(?!mailto:)[^)]+)\)/g;
  let match;
  const checks: {
    linkTarget: string;
    pathPart: string | undefined;
    anchorPart: string | undefined;
    targetFilePath: string;
  }[] = [];
  while ((match = linkRegex.exec(content)) !== null) {
    const linkTarget = match[2];
    if (linkTarget === undefined) {
      continue;
    }
    const parts = linkTarget.split('#');
    const pathPart = parts[0];
    const anchorPart = parts[1];

    let targetFilePath = filePath;
    if (pathPart !== undefined && pathPart !== '') {
      targetFilePath = resolve(dirname(filePath), pathPart);
    }
    checks.push({ linkTarget, pathPart, anchorPart, targetFilePath });
  }

  await Promise.all(
    checks.map(async ({ linkTarget, anchorPart, targetFilePath }) => {
      const relativeTargetDisplay = targetFilePath.replace(DOCS_DIR + '/', '');

      // Check if file exists
      if (!existsSync(targetFilePath)) {
        issues.push({
          file: relativeFilePath,
          type: 'link',
          message: `Broken relative link to file: "${linkTarget}" (resolved to: "${relativeTargetDisplay}").`,
        });
        return;
      }

      // Check if anchor exists in target file
      if (anchorPart) {
        const targetSlugs = await getHeadingSlugs(targetFilePath);
        const decAnchor = decodeURIComponent(anchorPart);
        if (!targetSlugs.has(decAnchor) && !targetSlugs.has(anchorPart)) {
          issues.push({
            file: relativeFilePath,
            type: 'anchor',
            message: `Anchor "#${anchorPart}" not found in target file: "${relativeTargetDisplay}". Available anchors: ${Array.from(
              targetSlugs,
            )
              .map((s) => `"#${s}"`)
              .join(', ')}`,
          });
        }
      }
    }),
  );

  // 3. Parse and verify Mermaid code blocks
  const mermaidStartTag = '```mermaid';
  let currentIndex = 0;
  while ((currentIndex = content.indexOf(mermaidStartTag, currentIndex)) !== -1) {
    const nextFence = content.indexOf('```', currentIndex + mermaidStartTag.length);
    if (nextFence === -1) {
      issues.push({
        file: relativeFilePath,
        type: 'mermaid',
        message: 'Unclosed Mermaid code block (missing trailing triple backticks).',
      });
      break;
    }

    // Extract the inner code block
    const mermaidCode = content.substring(currentIndex + mermaidStartTag.length, nextFence);
    const lines = mermaidCode.split('\n');

    const isStateDiagram = lines.some((l) => {
      const t = l.trim();
      return t.startsWith('stateDiagram') || t.startsWith('stateDiagram-v2');
    });

    // Check for nested ```mermaid inside without a closing ```
    const nextStart = content.indexOf(mermaidStartTag, currentIndex + mermaidStartTag.length);
    if (nextStart !== -1 && nextStart < nextFence) {
      issues.push({
        file: relativeFilePath,
        type: 'mermaid',
        message: 'Nested or unclosed Mermaid code block before next tag.',
      });
    }

    // Verify Init blocks
    const initLines = lines.filter((l) => l.trim().startsWith('%%{init:'));
    for (const initLine of initLines) {
      const openBraces = (initLine.match(/{/g) || []).length;
      const closeBraces = (initLine.match(/}/g) || []).length;
      if (openBraces !== closeBraces) {
        issues.push({
          file: relativeFilePath,
          type: 'mermaid',
          message: `Mermaid init block has mismatched braces: ${openBraces} open vs ${closeBraces} close.`,
        });
      }
    }

    // Verify visual elements & syntax within lines
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (line === undefined) continue;
      const lineNum = idx + 1;
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('%%')) continue;

      // 1. Unclosed quotes check
      const quoteCount = (trimmed.match(/"/g) || []).length;
      if (quoteCount % 2 !== 0) {
        issues.push({
          file: relativeFilePath,
          type: 'mermaid',
          message: `Unclosed double quotes in Mermaid line ${lineNum}: "${trimmed}".`,
        });
      }

      // 2. Unquoted label special character check
      // Arrow labels containing parentheses (), braces {}, or brackets [] must be quoted
      const unquotedLabelRegex = /[=-]+\.?->\s*\|([^"]*?[(){}[\]][^"]*?)\|/;
      if (unquotedLabelRegex.test(trimmed)) {
        issues.push({
          file: relativeFilePath,
          type: 'mermaid',
          message: `Mermaid line ${lineNum} has an unquoted arrow label containing parentheses, braces, or brackets: "${trimmed}". Wrap the label in double quotes (e.g. |"Text"|).`,
        });
      }

      // 3. Bracket matching check for custom shape elements (flowcharts only)
      if (!isStateDiagram) {
        const brackets = [
          { open: '([', close: '])', name: 'stadium shape' },
          { open: '((', close: '))', name: 'circle shape' },
          { open: '[(', close: ')]', name: 'database shape' },
          { open: '{', close: '}', name: 'diamond shape' },
          { open: '[', close: ']', name: 'rectangle shape' },
        ];
        for (const b of brackets) {
          const openCount = trimmed.split(b.open).length - 1;
          const closeCount = trimmed.split(b.close).length - 1;
          if (openCount !== closeCount) {
            issues.push({
              file: relativeFilePath,
              type: 'mermaid',
              message: `Mismatched ${b.name} brackets ("${b.open}" vs "${b.close}") in Mermaid line ${lineNum}: "${trimmed}".`,
            });
          }
        }
      }
    }

    currentIndex = nextFence + 3;
  }
});

console.log('\n--- Documentation Validation Results ---');
if (issues.length === 0) {
  console.log(
    '✅ Success! All docs are verified, contain timestamps, and have unbroken relative links and anchors!',
  );
  process.exit(0);
} else {
  console.error(`❌ Found ${issues.length} issue(s) in documentation:\n`);
  for (const issue of issues) {
    console.error(`[${issue.file}] (${issue.type}): ${issue.message}`);
  }
  process.exit(1);
}
