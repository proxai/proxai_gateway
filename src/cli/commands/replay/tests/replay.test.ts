import { expect, test } from 'bun:test';
import { buildReport, parseLog, renderReport, runReplay } from 'cli/commands/replay';

const SAMPLE_LOG = `
{"event":"state_machine.transition","machine":"batch-lifecycle","value":"uploading","status":"active","capturedAtUtc":"2026-05-25T12:00:00.000Z"}
{"event":"state_machine.transition","machine":"batch-lifecycle","value":"delivered","status":"done","capturedAtUtc":"2026-05-25T12:00:01.000Z"}
{"event":"state_machine.transition","machine":"capture-loop","value":"waiting","status":"active","capturedAtUtc":"2026-05-25T12:00:00.500Z"}
{"event":"unrelated.event","machine":"batch-lifecycle"}
not-json
`;

test('parseLog filters out non-transition events and malformed lines', () => {
  const events = parseLog(SAMPLE_LOG);
  expect(events.length).toBe(3);
  expect(events.every((e) => e.machine === 'batch-lifecycle' || e.machine === 'capture-loop')).toBe(
    true,
  );
});

test('parseLog returns empty array for empty body', () => {
  expect(parseLog('')).toEqual([]);
});

test('buildReport groups transitions by machine and computes final values', () => {
  const events = parseLog(SAMPLE_LOG);
  const report = buildReport(events);
  expect(report.totalEvents).toBe(3);
  expect(report.machineCount).toBe(2);
  const batch = report.machines.find((m) => m.machine === 'batch-lifecycle')!;
  expect(batch.transitionCount).toBe(2);
  expect(batch.finalValue).toBe('delivered');
  expect(batch.finalStatus).toBe('done');
});

test('buildReport with machine filter narrows the report', () => {
  const events = parseLog(SAMPLE_LOG);
  const report = buildReport(events, 'capture-loop');
  expect(report.machineCount).toBe(1);
  expect(report.machines[0]?.machine).toBe('capture-loop');
});

test('renderReport produces a multi-line summary including machine names', () => {
  const events = parseLog(SAMPLE_LOG);
  const report = buildReport(events);
  const text = renderReport(report);
  expect(text).toContain('Replay summary');
  expect(text).toContain('batch-lifecycle');
  expect(text).toContain('capture-loop');
});

test('renderReport handles empty events', () => {
  const report = buildReport([]);
  expect(renderReport(report)).toContain('No state-machine transitions');
});

test('runReplay reads the file and prints a summary', async () => {
  const lines: string[] = [];
  const deps = {
    output: {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(`WARN ${m}`),
      error: (m: string) => lines.push(`ERR ${m}`),
      success: (m: string) => lines.push(`OK ${m}`),
    },
    readFile: () => Promise.resolve(SAMPLE_LOG),
  };
  const result = await runReplay(deps, { logPath: '/fake.jsonl' });
  expect(result.exitCode).toBe(0);
  expect(lines.some((l) => l.includes('batch-lifecycle'))).toBe(true);
});

test('runReplay returns error exit when readFile throws', async () => {
  const lines: string[] = [];
  const deps = {
    output: {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(`WARN ${m}`),
      error: (m: string) => lines.push(`ERR ${m}`),
      success: (m: string) => lines.push(`OK ${m}`),
    },
    readFile: () => Promise.reject(new Error('ENOENT')),
  };
  const result = await runReplay(deps, { logPath: '/missing.jsonl' });
  expect(result.exitCode).toBeGreaterThan(0);
  expect(lines.some((l) => l.startsWith('ERR'))).toBe(true);
});
