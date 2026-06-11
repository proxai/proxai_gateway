import { isRecord } from 'core/utils';
import type { SourcePlatform } from 'services/contract';

const CODEX_CLI_PLATFORM: SourcePlatform = 'codex-cli';
const CODEX_DESKTOP_PLATFORM: SourcePlatform = 'codex-desktop';

export function classifyCodexPlatform(
  source: string | null | undefined,
  originator: string | null | undefined,
): SourcePlatform {
  if (source === 'vscode' || originator === 'Codex Desktop') {
    return CODEX_DESKTOP_PLATFORM;
  }
  return CODEX_CLI_PLATFORM;
}

export function codexPlatformFromSessionMeta(line: string): SourcePlatform | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed['type'] !== 'session_meta') {
    return null;
  }
  const payload = parsed['payload'];
  if (!isRecord(payload)) {
    return null;
  }
  const source = typeof payload['source'] === 'string' ? payload['source'] : null;
  const originator = typeof payload['originator'] === 'string' ? payload['originator'] : null;
  if (source === null && originator === null) {
    return null;
  }
  return classifyCodexPlatform(source, originator);
}
