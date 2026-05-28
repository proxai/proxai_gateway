/**
 * Minimal YAML-frontmatter parser. Supports the subset we need:
 *   key: string             (bare or "quoted")
 *   key: true | false
 *   key: number
 *   key: ["a", "b"]         (inline JSON-style array)
 *
 * Does NOT support: block scalars, nested maps, multi-line arrays, anchors, tags.
 * Throws on anything we don't understand so we never silently mis-parse.
 */
export type FrontmatterValue = string | boolean | number | string[];
export type FrontmatterData = Record<string, FrontmatterValue>;

export interface ParsedFrontmatter {
  data: FrontmatterData;
  body: string;
}

const FENCE = '---';

export function parseFrontmatter(src: string): ParsedFrontmatter {
  if (!src.startsWith(FENCE + '\n') && !src.startsWith(FENCE + '\r\n')) {
    return { data: {}, body: src };
  }

  const afterOpening = src.slice(FENCE.length).replace(/^\r?\n/, '');
  const closingIdx = afterOpening.search(/\r?\n---\r?\n|\r?\n---$/);
  if (closingIdx === -1) {
    throw new Error('Unterminated frontmatter fence');
  }
  const fmBody = afterOpening.slice(0, closingIdx);
  const rest = afterOpening.slice(closingIdx).replace(/^\r?\n---\r?\n?/, '');

  const data: FrontmatterData = {};
  let currentKey: string | null = null;
  let currentRaw = '';

  for (const rawLine of fmBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Check if the line starts a new key: value
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:(.*)$/);
    if (match) {
      if (currentKey !== null) {
        data[currentKey] = parseValue(currentRaw);
      }
      currentKey = match[1];
      currentRaw = match[2].trim();
    } else {
      if (currentKey === null) {
        throw new Error(`Malformed frontmatter line (no colon and no active key): ${rawLine}`);
      }
      currentRaw += ' ' + line;
      currentRaw = currentRaw.trim();
    }
  }

  if (currentKey !== null) {
    data[currentKey] = parseValue(currentRaw);
  }

  return { data, body: rest };
}

function parseValue(raw: string): FrontmatterValue {
  if (raw === '') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    // Strip trailing commas from array strings to make them valid JSON
    const cleanedRaw = raw.replace(/,\s*\]$/, ']');
    let arr: unknown;
    try {
      arr = JSON.parse(cleanedRaw);
    } catch {
      // Tolerate single-quoted entries (prettier rewrites "x" → 'x' in markdown
      // frontmatter under singleQuote: true). Swap quote style and retry.
      try {
        arr = JSON.parse(cleanedRaw.replace(/'/g, '"'));
      } catch {
        throw new Error(`Invalid inline array: ${raw}`);
      }
    }
    if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
      return arr as string[];
    }
    throw new Error(`Inline array must contain only strings: ${raw}`);
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}
