import { join } from 'node:path';
import { stat } from 'node:fs/promises';

export interface MapperConfig {
  schemaVersion: number;
  tools: {
    claude: boolean;
    codex: boolean;
    cursor: boolean;
    gemini: boolean;
    antigravity: boolean;
  };
  paths: {
    claudeDir: string;
    cursorDir: string;
    codexDir: string;
    geminiDir: string;
    antigravityDir: string;
  };
  emitTools: {
    excludeSubdirs: string[];
  };
}

export async function loadConfig(aiRoot: string): Promise<MapperConfig> {
  const path = join(aiRoot, 'mapper.config.toml');
  try {
    await stat(path);
  } catch {
    throw new Error(`mapper.config.toml not found at ${path}`);
  }
  const raw = (await import(path, { with: { type: 'toml' } })).default as Record<string, unknown>;

  if (typeof raw.schema_version !== 'number') {
    throw new Error('mapper.config.toml: missing or invalid schema_version (must be a number)');
  }
  const tools = (raw.tools ?? {}) as Record<string, boolean>;
  const paths = (raw.paths ?? {}) as Record<string, string>;
  const emitTools = (raw.emit_tools ?? {}) as Record<string, unknown>;
  const rawExclude = emitTools.exclude_subdirs;
  const excludeSubdirs: string[] = Array.isArray(rawExclude)
    ? rawExclude.filter((v): v is string => typeof v === 'string')
    : [];

  return {
    schemaVersion: raw.schema_version,
    tools: {
      claude: !!tools.claude,
      codex: !!tools.codex,
      cursor: !!tools.cursor,
      gemini: !!tools.gemini,
      antigravity: !!tools.antigravity,
    },
    paths: {
      claudeDir: paths.claude_dir ?? '.claude',
      cursorDir: paths.cursor_dir ?? '.cursor',
      codexDir: paths.codex_dir ?? '.codex',
      geminiDir: paths.gemini_dir ?? '.gemini',
      antigravityDir: paths.antigravity_dir ?? '.agent',
    },
    emitTools: { excludeSubdirs },
  };
}
