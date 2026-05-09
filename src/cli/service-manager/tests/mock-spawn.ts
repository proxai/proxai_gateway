import type { SpawnFn } from 'cli/service-manager';

export interface SpawnInvocation {
  argv: string[];
}

export interface MockResponse {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export function mockSpawn(handler: (argv: string[]) => MockResponse): {
  spawn: SpawnFn;
  invocations: SpawnInvocation[];
} {
  const invocations: SpawnInvocation[] = [];
  const spawn: SpawnFn = (argv) => {
    invocations.push({ argv: [...argv] });
    const resp = handler(argv);
    const stdoutText = resp.stdout ?? '';
    const stderrText = resp.stderr ?? '';
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdoutText));
        controller.close();
      },
    });
    const stderrStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderrText));
        controller.close();
      },
    });
    return {
      stdout: stdoutStream,
      stderr: stderrStream,
      exited: Promise.resolve(resp.exitCode),
      exitCode: resp.exitCode,
    };
  };
  return { spawn, invocations };
}
