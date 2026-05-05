import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { GENERIC_TOKENS_RULES } from 'services/redaction/rules/generic-tokens.ts';

test('redacts a standard JWT', () => {
  const input =
    'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const result = applyRedaction(input, GENERIC_TOKENS_RULES);
  expect(result.redacted).toContain('[REDACTED:jwt]');
});

test('does not match strings without eyJ on both header and payload', () => {
  const input = 'abc.def.ghi';
  const result = applyRedaction(input, GENERIC_TOKENS_RULES);
  expect(result.matchCount).toBe(0);
});
