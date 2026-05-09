import type { CommandRunResult, SpawnFn } from 'cli/service-manager/types.ts';

export async function runCommand(spawn: SpawnFn, argv: string[]): Promise<CommandRunResult> {
  const proc = spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdoutText, stderr: stderrText };
}

export function defaultSpawn(): SpawnFn {
  return ((argv, options) => Bun.spawn(argv, options) as unknown as ReturnType<SpawnFn>) as SpawnFn;
}
