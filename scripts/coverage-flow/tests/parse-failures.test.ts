// Locks in the bun-console parsing contract that the failure report depends on.
// Two regressions are guarded explicitly: a timeout's detail prints AFTER its
// `(fail)` marker (quirk 4), and a batched marker omits its ` [time]` suffix
// (quirk 2) — both previously rendered `(no console detail captured)`.

import { describe, expect, test } from 'bun:test';

import { extractFailureBlocks } from '../parse-failures.ts';

// bun emits one console entry per line; build a section the same way.
function section(...lines: string[]): string {
  return lines.join('\n');
}

describe('extractFailureBlocks', () => {
  test('captures an assertion failure: frame + error + stack before its marker', () => {
    const blocks = extractFailureBlocks(
      section(
        'src/a.test.ts:',
        '1 | code line',
        '2 | expect(received).toBe(expected)',
        '        ^',
        'error: expect(received).toBe(expected)',
        'Expected: 2',
        'Received: 1',
        '    at <anonymous> (src/a.test.ts:2:5)',
        '(fail) a does thing [1.23ms]',
      ),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.file).toBe('src/a.test.ts');
    expect(blocks[0]?.name).toBe('a does thing');
    expect(blocks[0]?.detail.startsWith('1 | code line')).toBe(true);
    expect(blocks[0]?.detail).toContain('error: expect(received).toBe(expected)');
  });

  test('recognizes a marker with no [time] suffix (batched markers)', () => {
    const blocks = extractFailureBlocks(
      section(
        'src/b.test.ts:',
        '1 | code',
        'error: boom one',
        '(fail) b first (attempt 3)', // batched: no [time]
        '(fail) b second (attempt 3) [2.00ms]', // last in the batch keeps [time]
      ),
    );
    expect(blocks.map((b) => b.name)).toEqual(['b first', 'b second']);
    expect(blocks[0]?.detail).toContain('boom one');
    expect(blocks[1]?.detail).toBe('');
  });

  test('attaches a timeout message printed AFTER the marker to that marker', () => {
    const blocks = extractFailureBlocks(
      section(
        'src/c.test.ts:',
        '(fail) c times out [201.00ms]',
        '  ^ this test timed out after 200ms.',
      ),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.name).toBe('c times out');
    expect(blocks[0]?.detail).toBe('^ this test timed out after 200ms.');
  });

  test('a pass/skip marker resets the buffer so a prior frame does not leak', () => {
    const blocks = extractFailureBlocks(
      section(
        'src/d.test.ts:',
        '1 | leaked frame',
        '(pass) d ok [0.50ms]',
        'error: real error',
        '(fail) d fails [1.00ms]',
      ),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.name).toBe('d fails');
    expect(blocks[0]?.detail).toBe('error: real error');
    expect(blocks[0]?.detail).not.toContain('leaked frame');
  });

  test('walk-back stops at a non-frame line before the error', () => {
    const blocks = extractFailureBlocks(
      section('src/e.test.ts:', 'some narrative line', 'error: e boom', '(fail) e fails [1.00ms]'),
    );
    expect(blocks[0]?.detail).toBe('error: e boom');
    expect(blocks[0]?.detail).not.toContain('narrative');
  });

  test('collapses an error-less repeated block to a single copy', () => {
    const blocks = extractFailureBlocks(
      section(
        'src/f.test.ts:',
        '^ this test timed out after 5ms.',
        '^ this test timed out after 5ms.',
        '(fail) f times out',
      ),
    );
    expect(blocks[0]?.detail).toBe('^ this test timed out after 5ms.');
  });

  test('keeps a non-periodic error-less block intact', () => {
    const blocks = extractFailureBlocks(
      section(
        'src/g.test.ts:',
        'line one',
        'line two',
        'line three',
        'line four',
        'line five',
        '(fail) g fails',
      ),
    );
    expect(blocks[0]?.detail).toBe('line one\nline two\nline three\nline four\nline five');
  });

  test('trims blank lines from both edges of the detail', () => {
    const blocks = extractFailureBlocks(
      section('src/h.test.ts:', '', 'error: h boom', '', '(fail) h fails [1.00ms]'),
    );
    expect(blocks[0]?.detail).toBe('error: h boom');
  });

  test('returns no blocks for output with no failure markers', () => {
    const blocks = extractFailureBlocks(section('src/i.test.ts:', '(pass) i ok [0.10ms]'));
    expect(blocks).toHaveLength(0);
  });
});
