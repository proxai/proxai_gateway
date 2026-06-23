import { isAbsolute } from 'node:path';

import type { GatewayConfig } from 'services/config';
import { lexicalFolderKey } from 'services/exclusion';

export interface ExcludeDeps {
  loadConfig: () => Promise<GatewayConfig>;
  writeConfig: (config: GatewayConfig) => Promise<void>;
  print: (line: string) => void;
}

export type ExcludeAction =
  | { kind: 'add'; path: string }
  | { kind: 'remove'; path: string }
  | { kind: 'list' };

export interface ExcludeResult {
  exitCode: number;
}

/** Only `~` and `~/…` expand to a real home path; `~user` is rejected (it would never match). */
function isValidExclusionPath(path: string): boolean {
  return isAbsolute(path) || path === '~' || path.startsWith('~/');
}

export async function runExclude(deps: ExcludeDeps, action: ExcludeAction): Promise<ExcludeResult> {
  let config: GatewayConfig;
  try {
    config = await deps.loadConfig();
  } catch {
    deps.print('No gateway configuration found. Run `proxai-gateway setup` first.');
    return { exitCode: 1 };
  }
  const current = config.capture.excludedProjects;

  if (action.kind === 'list') {
    if (current.length === 0) {
      deps.print('No excluded projects.');
    } else {
      for (const p of current) deps.print(p);
    }
    return { exitCode: 0 };
  }

  const path = action.path.trim();
  if (path.length === 0 || !isValidExclusionPath(path)) {
    deps.print(`Invalid path: '${action.path}'. Provide an absolute or ~/-prefixed path.`);
    return { exitCode: 1 };
  }
  const key = lexicalFolderKey(path);

  if (action.kind === 'add') {
    if (current.some((p) => lexicalFolderKey(p) === key)) {
      deps.print(`Already excluded: ${path}`);
      return { exitCode: 0 };
    }
    config.capture.excludedProjects = [...current, path];
    await deps.writeConfig(config);
    deps.print(`Excluded ${path}`);
    return { exitCode: 0 };
  }

  const next = current.filter((p) => lexicalFolderKey(p) !== key);
  if (next.length === current.length) {
    deps.print(`Not in the exclusion list: ${path}`);
    return { exitCode: 0 };
  }
  config.capture.excludedProjects = next;
  await deps.writeConfig(config);
  deps.print(`Un-excluded ${path}`);
  return { exitCode: 0 };
}
