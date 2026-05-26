import type { ReplayEvent } from 'cli/commands/replay/replay.types.ts';

interface RawLogLine {
  readonly event?: unknown;
  readonly machine?: unknown;
  readonly value?: unknown;
  readonly status?: unknown;
  readonly capturedAtUtc?: unknown;
}

export function parseLog(jsonl: string): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const lines = jsonl.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: RawLogLine;
    try {
      parsed = JSON.parse(line) as RawLogLine;
    } catch {
      continue;
    }
    if (parsed.event !== 'state_machine.transition') continue;
    if (typeof parsed.machine !== 'string') continue;
    if (typeof parsed.status !== 'string') continue;
    if (typeof parsed.capturedAtUtc !== 'string') continue;
    events.push({
      machine: parsed.machine,
      value: parsed.value ?? null,
      status: parsed.status,
      capturedAtUtc: parsed.capturedAtUtc,
    });
  }
  return events;
}
