import { expect, test } from 'bun:test';

import { stripMarkerBlock } from 'core/utils/strip-marker-block.ts';

const MARKER = '# Added by ProxAI Gateway installer';
const HINT = '.proxai/bin';

test('removes marker + next line + leading blank line', () => {
  const before =
    [
      'export EDITOR=vim',
      '',
      '# Added by ProxAI Gateway installer',
      'export PATH="$HOME/.proxai/bin:$PATH"',
      '# end',
    ].join('\n') + '\n';
  const result = stripMarkerBlock(before, { marker: MARKER, followingLineSubstring: HINT });
  expect(result.changed).toBe(true);
  expect(result.unmatchedMarker).toBe(false);
  expect(result.newContent).toBe(['export EDITOR=vim', '# end', ''].join('\n'));
});

test('leaves marker block alone if next line does not match install dir hint', () => {
  const before = ['# Added by ProxAI Gateway installer', 'unrelated line', 'rest'].join('\n');
  const result = stripMarkerBlock(before, { marker: MARKER, followingLineSubstring: HINT });
  expect(result.changed).toBe(false);
  expect(result.unmatchedMarker).toBe(true);
  expect(result.newContent).toBe(before);
});

test('no-op when no marker present', () => {
  const before = 'alias ll="ls -la"\nexport PAGER=less\n';
  const result = stripMarkerBlock(before, { marker: MARKER, followingLineSubstring: HINT });
  expect(result.changed).toBe(false);
  expect(result.unmatchedMarker).toBe(false);
  expect(result.newContent).toBe(before);
});

test('handles marker as the very first line', () => {
  const before =
    ['# Added by ProxAI Gateway installer', 'export PATH="$HOME/.proxai/bin:$PATH"', 'rest'].join(
      '\n',
    ) + '\n';
  const result = stripMarkerBlock(before, { marker: MARKER, followingLineSubstring: HINT });
  expect(result.changed).toBe(true);
  expect(result.newContent).toBe('rest\n');
});

test('handles marker as the last block (no trailing rest)', () => {
  const before = [
    'first',
    '',
    '# Added by ProxAI Gateway installer',
    'export PATH="$HOME/.proxai/bin:$PATH"',
  ].join('\n');
  const result = stripMarkerBlock(before, { marker: MARKER, followingLineSubstring: HINT });
  expect(result.changed).toBe(true);
  expect(result.newContent).toBe('first');
});

test('marker without a following line keeps it untouched', () => {
  const before = 'first\n# Added by ProxAI Gateway installer';
  const result = stripMarkerBlock(before, { marker: MARKER, followingLineSubstring: HINT });
  expect(result.changed).toBe(false);
  expect(result.unmatchedMarker).toBe(true);
  expect(result.newContent).toBe(before);
});

test('works with arbitrary marker and hint values', () => {
  const result = stripMarkerBlock('A\nMARKER\nfoo-HINT-bar\nB\n', {
    marker: 'MARKER',
    followingLineSubstring: 'HINT',
  });
  expect(result.changed).toBe(true);
  expect(result.newContent).toBe('A\nB\n');
});
