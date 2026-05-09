const VERSION_REGEX = /^[\w.+:/-]{1,64}$/;
const HEAD_BYTES = 4096;

export type RolloutVersionReader = (filePath: string) => Promise<string | null>;

export async function extractRolloutCliVersion(
  filePath: string,
  readImpl?: (path: string, length: number) => Promise<string>,
): Promise<string | null> {
  const read = readImpl ?? defaultRead;
  let head: string;
  try {
    head = await read(filePath, HEAD_BYTES);
  } catch {
    return null;
  }
  const newlineIdx = head.indexOf('\n');
  const firstLine = (newlineIdx === -1 ? head : head.slice(0, newlineIdx)).trim();
  if (firstLine.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const payload = (parsed as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== 'object') return null;
  const cliVersion = (payload as { cli_version?: unknown }).cli_version;
  if (typeof cliVersion !== 'string') return null;
  if (!VERSION_REGEX.test(cliVersion)) return null;
  return cliVersion;
}

async function defaultRead(filePath: string, length: number): Promise<string> {
  return Bun.file(filePath).slice(0, length).text();
}
