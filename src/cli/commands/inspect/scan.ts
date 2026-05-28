import { handleInspect } from 'services/polling/poll-worker.ts';
import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';

import { INSPECT_MAX_DECOMPRESSED_BYTES } from 'cli/commands/inspect/inspect.constants.ts';
import type {
  InspectBaseDirs,
  InspectCommandDeps,
  InspectCommandOptions,
  SourceResult,
} from 'cli/commands/inspect/inspect.types.ts';

export interface InspectWorkerLike {
  onmessage: ((event: MessageEvent<WorkerOutput>) => void) | null;
  onerror: ((event: unknown) => void) | null;
  postMessage: (message: WorkerInput) => void;
  terminate: () => void;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isCompiledRuntime(): boolean {
  return import.meta.url.includes('$bunfs') || import.meta.url.includes('bun:wrap');
}

export function resolveSourceBaseDir(
  sourceName: string,
  baseDirs: InspectBaseDirs | undefined,
): string | undefined {
  if (baseDirs === undefined) return undefined;
  if (sourceName === 'claude-code') return baseDirs.claudeCode;
  if (sourceName === 'cursor') return baseDirs.cursor;
  if (sourceName === 'gemini-cli') return baseDirs.geminiCli;
  if (sourceName === 'codex') return baseDirs.codex;
  if (sourceName === 'claude-desktop') return baseDirs.claudeDesktop;
  return undefined;
}

export function buildScanOptions(
  gatewayVersion: string,
  baseDir: string | undefined,
): WorkerInput['options'] {
  const options: WorkerInput['options'] = {
    gatewayVersion,
    maxDecompressedBytes: INSPECT_MAX_DECOMPRESSED_BYTES,
    captureSubAgents: true,
  };
  if (baseDir !== undefined) {
    options.baseDir = baseDir;
  }
  return options;
}

export function emptySourceResult(sourceName: string, errors: string[]): SourceResult {
  return {
    sourceName,
    filesProcessed: 0,
    recordCount: 0,
    totalBytes: 0,
    telemetryRawBytes: 0,
    telemetryCompressedBytes: 0,
    telemetryRecordCount: 0,
    promptCount: 0,
    oldestDate: null,
    newestDate: null,
    errors,
  };
}

export async function scanViaDirect(
  sourceName: string,
  options: WorkerInput['options'],
  runInspect: typeof handleInspect = handleInspect,
): Promise<SourceResult> {
  try {
    const result = await runInspect(sourceName, options);
    return { sourceName, ...result };
  } catch (err) {
    return emptySourceResult(sourceName, [describeError(err)]);
  }
}

function createInspectWorker(): InspectWorkerLike {
  const workerUrl = new URL('../../../services/polling/poll-worker.ts', import.meta.url).href;
  const worker: unknown = new Worker(workerUrl, { type: 'module' });
  return worker as InspectWorkerLike;
}

export function scanViaWorker(
  sourceName: string,
  options: WorkerInput['options'],
  createWorker: () => InspectWorkerLike = createInspectWorker,
): Promise<SourceResult> {
  return new Promise<SourceResult>((resolve) => {
    try {
      const worker = createWorker();
      worker.onmessage = (event: MessageEvent<WorkerOutput>): void => {
        worker.terminate();
        const message = event.data;
        if (message.success && message.inspectResult) {
          resolve({ sourceName, ...message.inspectResult });
        } else {
          resolve(
            emptySourceResult(sourceName, [message.error ?? 'inspect worker returned no result']),
          );
        }
      };
      worker.onerror = (): void => {
        worker.terminate();
        resolve(emptySourceResult(sourceName, ['inspect worker error']));
      };
      worker.postMessage({ task: 'inspect', sourceName, options });
    } catch (err) {
      resolve(emptySourceResult(sourceName, [describeError(err)]));
    }
  });
}

export async function scanSingleSource(
  sourceName: string,
  deps: InspectCommandDeps,
  options: InspectCommandOptions,
  compiled: boolean = isCompiledRuntime(),
): Promise<SourceResult> {
  const baseDir = resolveSourceBaseDir(sourceName, options.baseDirs);
  const scanOptions = buildScanOptions(deps.gatewayVersion, baseDir);
  if (compiled) {
    return scanViaDirect(sourceName, scanOptions);
  }
  return scanViaWorker(sourceName, scanOptions);
}
