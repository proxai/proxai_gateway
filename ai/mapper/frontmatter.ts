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
  for (const rawLine of fmBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new Error(`Malformed frontmatter line (no colon): ${rawLine}`);
    }
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    data[key] = parseValue(raw);
  }

  return { data, body: rest };
}

function parseValue(raw: string): FrontmatterValue {
  if (raw === '') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      // Tolerate single-quoted entries (prettier rewrites "x" → 'x' in markdown
      // frontmatter under singleQuote: true). Swap quote style and retry.
      try {
        arr = JSON.parse(raw.replace(/'/g, '"'));
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
