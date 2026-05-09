export interface DetectGeminiCliVersionDeps {
  which?: (cmd: string) => string | null;
  spawn?: (argv: string[]) => Promise<{ stdout: string; exitCode: number }>;
}

const VERSION_PATTERN = /^[\w.+:/-]{1,64}$/;
const SPAWN_TIMEOUT_MS = 3_000;

export async function detectGeminiCliVersion(
  deps: DetectGeminiCliVersionDeps = {},
): Promise<string | null> {
  const which = deps.which ?? defaultWhich;
  const spawn = deps.spawn ?? defaultSpawn;

  const resolved = which('gemini');
  if (resolved === null) return null;

  let outcome: { stdout: string; exitCode: number };
  try {
    outcome = await spawn([resolved, '--version']);
  } catch {
    return null;
  }
  if (outcome.exitCode !== 0) return null;

  const firstLine = outcome.stdout.trim().split('\n')[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return null;
  if (!VERSION_PATTERN.test(firstLine)) return null;
  return firstLine;
}

export function defaultWhich(cmd: string): string | null {
  return Bun.which(cmd);
}

export async function defaultSpawn(argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}
