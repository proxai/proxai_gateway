export interface StripMarkerBlockOptions {
  marker: string;
  followingLineSubstring: string;
}

export interface StripMarkerBlockResult {
  changed: boolean;
  newContent: string;
  unmatchedMarker: boolean;
}

export function stripMarkerBlock(
  content: string,
  options: StripMarkerBlockOptions,
): StripMarkerBlockResult {
  const lines = content.split('\n');
  const out: string[] = [];
  let changed = false;
  let unmatchedMarker = false;
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === options.marker) {
      const next = lines[i + 1];
      if (next !== undefined && next.includes(options.followingLineSubstring)) {
        if (out.length > 0 && out[out.length - 1] === '') {
          out.pop();
        }
        changed = true;
        i += 2;
        continue;
      }
      unmatchedMarker = true;
    }
    out.push(lines[i] ?? '');
    i += 1;
  }
  return { changed, newContent: out.join('\n'), unmatchedMarker };
}
