// Scrape each failing test's verbose block (source snippet + error + diff +
// stack) from bun's console. bun's JUnit <failure> element is empty, so the
// rich diff only exists in the console. Blocks are delimited by the
// `(fail) <name> [time]` line; the preceding `<file>:` header names the file.
// Keyed by `<file> <name>` to match JUnit's file + name.

export function extractFailureDetails(testSection: string): Map<string, string> {
  const details = new Map<string, string>();
  let currentFile = '';
  let buf: string[] = [];
  for (const line of testSection.split('\n')) {
    const header = line.match(/^(\S.*\.(?:test|spec)\.ts):$/)?.[1];
    if (header !== undefined) {
      currentFile = header;
      buf = [];
      continue;
    }
    const failName = line.match(/^\(fail\) (.+?) \[[\d.]+m?s\]$/)?.[1];
    if (failName !== undefined) {
      details.set(`${currentFile} ${failName}`, buf.join('\n').trim());
      buf = [];
      continue;
    }
    if (/^\((?:pass|skip|todo)\)/.test(line)) {
      buf = [];
      continue;
    }
    buf.push(line);
  }
  return details;
}
