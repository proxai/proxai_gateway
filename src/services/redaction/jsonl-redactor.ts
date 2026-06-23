import { zstdCompressSync } from 'core/utils';
import { applyRedaction } from 'services/redaction/redaction.ts';

const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

export interface JsonlSliceRedaction {
  redactedBytes: Uint8Array;
  compressed: Uint8Array;
}

/**
 * Redact a decoded JSONL body PER LINE.
 *
 * The capture collectors ship jsonl bodies that nest re-splits on `0x0A` and `JSON.parse`s one
 * record at a time. Several redaction rules use a lazy `[\s\S]+?` span (e.g. the BEGIN/END
 * private-key fallback, PuTTY, minisign) whose `[\s\S]` class matches `\n` too — so a `-----BEGIN-----`
 * marker in one record plus a matching `-----END-----` in a LATER record lets a single match swallow
 * the record separator(s) and collapse N JSONL lines into one. nest then silently sees N-1 steps and
 * advances its watermark over the merged span: permanent, unrecoverable loss.
 *
 * Splitting on `\n` and redacting each line independently confines any `[\s\S]+?` match to one
 * record, so the line count and record boundaries are preserved exactly. For the common case (no
 * cross-record bridging) this is behaviour-identical to whole-body redaction; it only differs —
 * correctly — when a match would otherwise have bridged records. A real single-physical-line PEM
 * key (newlines stored as the literal two-char `\n` escape inside one JSON string) is still fully
 * redacted, because those escapes are not real `0x0A` bytes and never split a line here.
 */
export function redactJsonlText(text: string): string {
  return text
    .split('\n')
    .map((line) => applyRedaction(line).redacted)
    .join('\n');
}

/**
 * Build a memoized per-slice redactor for the JSONL capture path.
 *
 * Each call decodes the slice, redacts it PER LINE (see {@link redactJsonlText}), re-encodes, and
 * zstd-compresses; results are cached by slice identity so `splitJsonlAtBoundary`'s repeated
 * `measureCompressed` probes do not re-redact the same bytes. Returns the redacted bytes plus the
 * compressed body the collector ships.
 */
export function createJsonlSliceRedactor(): (slice: Uint8Array) => JsonlSliceRedaction {
  const cache = new WeakMap<Uint8Array, JsonlSliceRedaction>();
  return (slice) => {
    let entry = cache.get(slice);
    if (entry === undefined) {
      const redactedBytes = ENCODER.encode(redactJsonlText(DECODER.decode(slice)));
      const compressed = zstdCompressSync(redactedBytes);
      entry = { redactedBytes, compressed };
      cache.set(slice, entry);
    }
    return entry;
  };
}
