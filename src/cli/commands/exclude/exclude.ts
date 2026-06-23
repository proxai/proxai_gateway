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

/** Write the mutated config, reporting a disk/permission failure cleanly instead of throwing. */
async function persist(
  deps: ExcludeDeps,
  config: GatewayConfig,
  successMessage: string,
): Promise<ExcludeResult> {
  try {
    await deps.writeConfig(config);
  } catch (err) {
    deps.print(
      `Failed to update the configuration: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: 1 };
  }
  deps.print(successMessage);
  return { exitCode: 0 };
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
      for (const p of current) {
        deps.print(isValidExclusionPath(p) ? p : `${p}  (ignored — not an absolute or ~/ path)`);
      }
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
    return persist(deps, config, `Excluded ${path}`);
  }

  const next = current.filter((p) => lexicalFolderKey(p) !== key);
  if (next.length === current.length) {
    deps.print(`Not in the exclusion list: ${path}`);
    return { exitCode: 0 };
  }
  config.capture.excludedProjects = next;
  return persist(deps, config, `Un-excluded ${path}`);
}
