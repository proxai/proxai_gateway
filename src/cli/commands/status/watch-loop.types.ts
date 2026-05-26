import type { OutputSink } from 'cli/cli.types.ts';
import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';

export interface WatchLoopDeps {
  readonly output: OutputSink;
  readonly stdin: ReadableInputStream;
  readonly render: (inputs: RenderInputs) => string;
  readonly gatherFrame: () => Promise<RenderInputs>;
  readonly intervalMs?: number;
  readonly clearScreen?: boolean;
}

export interface WatchLoopHandle {
  wait(): Promise<void>;
  stop(): Promise<void>;
}
