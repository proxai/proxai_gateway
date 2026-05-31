// Scrape each failing test's verbose block (code frame + error + diff + stack)
// from bun's console. bun's JUnit <failure> element is empty, so the rich diff
// lives only in the console. bun prints the block(s) immediately BEFORE the
// `(fail) <name> [time]` marker; the preceding `<file>:` header names the file.
//
// Four console quirks must be handled:
//   1. the marker's name is the full describe path (`describe > leaf`), while
//      JUnit's `name` attribute is just the leaf — matching happens in
//      parse-run against the JUnit leaf, so we keep the full name here.
//   2. under `--retry`, the identical block is reprinted once per attempt and
//      the marker gains an ` (attempt N)` suffix. When several markers are
//      flushed back-to-back (multiple failures in one file), bun omits the
//      ` [time]` suffix on all but the last — so the time is optional.
//   3. a flaky test that recovers prints its failed-attempt block but NO marker,
//      so that block leaks into the buffer of the next failing test.
//   4. a TIMEOUT is the one shape whose detail prints AFTER its marker: bun
//      emits `(fail) <name> [t]` then `^ this test timed out after Nms.` on the
//      next line (no pre-marker block at all). That trailing line is attached
//      to the just-emitted block and kept out of the next test's buffer.
// Both repeats and any leaked prefix are removed by keeping only the block of
// the LAST `error:` line before the marker (`lastFailureBlock`).

export interface FailureBlock {
  file: string;
  name: string; // full describe-path name from the console marker
  detail: string;
}

// Every anchor tolerates leading whitespace: bun's GitHub Actions reporter
// indents test output under file headers (and emits `::error::` annotations),
// so a `^(fail)` / `^error:` pin matches nothing on CI even though the same run
// is flush-left locally.
export const HEADER_RE = /^\s*(\S.*\.(?:test|spec)\.ts):$/;
const FAIL_RE = /^\s*\(fail\) (.+?)(?: \(attempt \d+\))?(?: \[[\d.]+m?s\])?$/;
const PASSLIKE_RE = /^\s*\((?:pass|skip|todo)\)/;
const ERROR_RE = /^\s*error:/;
const FRAME_RE = /^\s*\d+ \|/;
const CARET_RE = /^\s*\^\s*$/;
const TIMEOUT_RE = /this test timed out|timed out after \d/;

// Drop blank lines from both ends but keep each line's indentation (a plain
// .trim() would strip the first code-frame line's alignment space).
function trimBlankEdges(lines: string[]): string[] {
  const body = [...lines];
  while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift();
  while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
  return body;
}

// Strip the shared leading indentation from a block — bun's GitHub Actions
// reporter indents every line — while preserving the relative alignment of code
// frames and the caret. Blank lines don't count toward the shared indent.
function dedent(lines: string[]): string[] {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const lead = l.length - l.trimStart().length;
    if (lead < min) min = lead;
  }
  if (!Number.isFinite(min) || min === 0) return lines;
  return lines.map((l) => l.slice(min));
}

// Fallback when no `error:` anchor exists (e.g. a timeout): if the buffer is a
// whole-number repetition of a shorter block, keep just one copy.
function collapseRepeats(lines: string[]): string[] {
  const body = trimBlankEdges(lines);
  const n = body.length;
  for (let period = 1; period <= Math.floor(n / 2); period += 1) {
    if (n % period !== 0) continue;
    let periodic = true;
    for (let i = period; i < n; i += 1) {
      if (body[i] !== body[i - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return body.slice(0, period);
  }
  return body;
}

// Keep only the block belonging to the marker's test: the last `error:` line and
// its preceding code frame, through end of buffer. Earlier blocks (retry repeats
// of the same test, or a recovered-flaky test's leaked block) are dropped.
function lastFailureBlock(lines: string[]): string[] {
  let lastErr = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (ERROR_RE.test(lines[i] ?? '')) {
      lastErr = i;
      break;
    }
  }
  if (lastErr < 0) return collapseRepeats(lines);
  let start = lastErr;
  while (start > 0) {
    const prev = lines[start - 1] ?? '';
    if (FRAME_RE.test(prev) || CARET_RE.test(prev) || prev.trim() === '') start -= 1;
    else break;
  }
  return lines.slice(start);
}

export function extractFailureBlocks(testSection: string): FailureBlock[] {
  const blocks: FailureBlock[] = [];
  let currentFile = '';
  let buf: string[] = [];
  // The most recent marker, kept open only until its trailing timeout line
  // (quirk 4) — cleared by the next marker, header, or pass-like line.
  let open: FailureBlock | null = null;
  for (const line of testSection.split('\n')) {
    const header = line.match(HEADER_RE)?.[1];
    if (header !== undefined) {
      currentFile = header;
      buf = [];
      open = null;
      continue;
    }
    const failName = line.match(FAIL_RE)?.[1];
    if (failName !== undefined) {
      const block: FailureBlock = {
        file: currentFile,
        name: failName,
        detail: dedent(trimBlankEdges(lastFailureBlock(buf))).join('\n'),
      };
      blocks.push(block);
      buf = [];
      open = block;
      continue;
    }
    if (PASSLIKE_RE.test(line)) {
      buf = [];
      open = null;
      continue;
    }
    if (open !== null && open.detail === '' && TIMEOUT_RE.test(line)) {
      open.detail = line.trim();
      continue;
    }
    buf.push(line);
  }
  return blocks;
}
