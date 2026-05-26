import type {
  ReplayEvent,
  ReplayMachineSummary,
  ReplayReport,
} from 'cli/commands/replay/replay.types.ts';

export function buildReport(events: readonly ReplayEvent[], machineFilter?: string): ReplayReport {
  const filtered =
    machineFilter !== undefined ? events.filter((e) => e.machine === machineFilter) : events;
  const grouped = new Map<string, ReplayEvent[]>();
  for (const event of filtered) {
    const list = grouped.get(event.machine);
    if (list === undefined) {
      grouped.set(event.machine, [event]);
    } else {
      list.push(event);
    }
  }
  const machines: ReplayMachineSummary[] = [];
  for (const [name, entries] of grouped.entries()) {
    if (entries.length === 0) continue;
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;
    machines.push({
      machine: name,
      transitionCount: entries.length,
      firstAtUtc: first.capturedAtUtc,
      lastAtUtc: last.capturedAtUtc,
      finalValue: last.value,
      finalStatus: last.status,
    });
  }
  machines.sort((a, b) => a.machine.localeCompare(b.machine));
  return {
    totalEvents: filtered.length,
    machineCount: machines.length,
    machines,
  };
}
