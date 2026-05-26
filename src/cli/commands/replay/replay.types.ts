import type { OutputSink } from 'cli/cli.types.ts';

export interface ReplayEvent {
  readonly machine: string;
  readonly value: unknown;
  readonly status: string;
  readonly capturedAtUtc: string;
}

export interface ReplayMachineSummary {
  readonly machine: string;
  readonly transitionCount: number;
  readonly firstAtUtc: string;
  readonly lastAtUtc: string;
  readonly finalValue: unknown;
  readonly finalStatus: string;
}

export interface ReplayReport {
  readonly totalEvents: number;
  readonly machineCount: number;
  readonly machines: readonly ReplayMachineSummary[];
}

export interface ReplayDeps {
  readonly output: OutputSink;
  readonly readFile: (path: string) => Promise<string>;
}

export interface ReplayOptions {
  readonly logPath: string;
  readonly machine?: string;
}
