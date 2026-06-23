import { describe, expect, test } from 'bun:test';

import { applyRedaction, createJsonlSliceRedactor, redactJsonlText } from 'services/redaction';

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

describe('redactJsonlText — per-line confinement of [\\s\\S]+? matches', () => {
  test('a BEGIN marker in line 1 and END marker in line 3 does NOT collapse records', () => {
    // The lazy private-key-block-fallback rule (/-----BEGIN [^-]{0,40}-----[\s\S]+?-----END .../)
    // matches \n via [\s\S], so over the whole body it bridges line 1 -> line 3 into ONE match,
    // swallowing the record separators. nest would then JSON.parse N-1 steps. Per-line redaction
    // must keep all three records intact.
    const line1 = JSON.stringify({
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      text: 'paste -----BEGIN CERTIFICATE-----',
    });
    const line2 = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      text: 'this middle record must survive intact',
    });
    const line3 = JSON.stringify({
      source: 'SYSTEM',
      type: 'CONVERSATION_HISTORY',
      text: 'tail -----END CERTIFICATE-----',
    });
    const body = `${[line1, line2, line3].join('\n')}\n`;

    const inputLines = nonEmptyLines(body);
    expect(inputLines).toHaveLength(3);

    // Guard: whole-body redaction (the bug) DOES collapse the records — proves the fixture bites.
    expect(nonEmptyLines(applyRedaction(body).redacted).length).toBeLessThan(inputLines.length);

    const redacted = redactJsonlText(body);
    const outLines = nonEmptyLines(redacted);

    // (a) same non-empty line count as input — no record was merged or dropped.
    expect(outLines).toHaveLength(inputLines.length);
    // (b) every output line is still valid JSON.
    for (const line of outLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // The surviving middle record keeps its content verbatim.
    expect(redacted).toContain('this middle record must survive intact');
  });

  test('a real single-physical-line PEM key (literal \\n inside one JSON string) is STILL redacted', () => {
    // No coverage lost: within one JSON string the newlines are the two-char \n escape, not real
    // 0x0A bytes, so the whole key sits on one physical line and per-line redaction still catches it.
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJBAK7SecretKeyMaterialHere\\n-----END RSA PRIVATE KEY-----';
    const line = JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', text: pem });
    const body = `${line}\n`;

    const redacted = redactJsonlText(body);
    expect(redacted).toContain('[REDACTED:private-key]');
    expect(redacted).not.toContain('MIIBOgIBAAJBAK7SecretKeyMaterialHere');
    // Still exactly one record, still valid JSON.
    const outLines = nonEmptyLines(redacted);
    expect(outLines).toHaveLength(1);
    for (const outLine of outLines) {
      expect(() => JSON.parse(outLine)).not.toThrow();
    }
  });

  test('preserves line count and ordering for a body with no secrets (behaviour-identical)', () => {
    const lines = [
      '{"source":"USER_EXPLICIT","type":"USER_INPUT","text":"hello"}',
      '{"source":"MODEL","type":"PLANNER_RESPONSE","text":"world"}',
    ];
    const body = `${lines.join('\n')}\n`;
    // No bridging rule fires, so per-line and whole-body must agree exactly.
    expect(redactJsonlText(body)).toBe(applyRedaction(body).redacted);
    expect(redactJsonlText(body)).toBe(body);
  });
});

describe('createJsonlSliceRedactor', () => {
  test('redacts per line and memoizes by slice identity', () => {
    const line1 = JSON.stringify({ type: 'USER_INPUT', text: 'x -----BEGIN CERTIFICATE-----' });
    const line2 = JSON.stringify({ type: 'PLANNER_RESPONSE', text: 'middle survives' });
    const line3 = JSON.stringify({
      type: 'CONVERSATION_HISTORY',
      text: 'y -----END CERTIFICATE-----',
    });
    const slice = ENCODER.encode(`${[line1, line2, line3].join('\n')}\n`);

    const redact = createJsonlSliceRedactor();
    const first = redact(slice);
    const second = redact(slice);
    // Memoized: identical object returned for the same slice instance.
    expect(second).toBe(first);

    const outLines = nonEmptyLines(DECODER.decode(first.redactedBytes));
    expect(outLines).toHaveLength(3);
    for (const line of outLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(first.compressed.byteLength).toBeGreaterThan(0);
  });
});
