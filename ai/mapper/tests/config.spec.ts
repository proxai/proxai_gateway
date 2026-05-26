import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config';

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `ai-mapper-cfg-${Date.now()}-${Math.random()}`);
  await mkdir(tmp, { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('loadConfig', () => {
  test('loads canonical mapper.config.toml', async () => {
    await writeFile(
      join(tmp, 'mapper.config.toml'),
      `
schema_version = 2
[tools]
claude = true
codex = true
cursor = false
gemini = true
antigravity = false
[paths]
claude_dir = ".claude"
cursor_dir = ".cursor"
codex_dir = ".codex"
gemini_dir = ".gemini"
antigravity_dir = ".agent"
`,
    );
    const cfg = await loadConfig(tmp);
    expect(cfg.schemaVersion).toBe(2);
    expect(cfg.tools).toEqual({
      claude: true,
      codex: true,
      cursor: false,
      gemini: true,
      antigravity: false,
    });
    expect(cfg.paths.claudeDir).toBe('.claude');
    expect(cfg.emitTools.excludeSubdirs).toEqual([]);
  });

  test('parses emit_tools.exclude_subdirs', async () => {
    await writeFile(
      join(tmp, 'mapper.config.toml'),
      `
schema_version = 2
[tools]
claude = true
codex = true
cursor = true
gemini = true
antigravity = true
[paths]
claude_dir = ".claude"
cursor_dir = ".cursor"
codex_dir = ".codex"
gemini_dir = ".gemini"
antigravity_dir = ".agent"
[emit_tools]
exclude_subdirs = ["coverage-orchestrator", "huge-helper"]
`,
    );
    const cfg = await loadConfig(tmp);
    expect(cfg.emitTools.excludeSubdirs).toEqual(['coverage-orchestrator', 'huge-helper']);
  });

  test('drops non-string entries from exclude_subdirs', async () => {
    await writeFile(
      join(tmp, 'mapper.config.toml'),
      `
schema_version = 2
[tools]
claude = true
codex = true
cursor = true
gemini = true
antigravity = true
[paths]
claude_dir = ".claude"
[emit_tools]
exclude_subdirs = ["ok", 7, true]
`,
    );
    const cfg = await loadConfig(tmp);
    expect(cfg.emitTools.excludeSubdirs).toEqual(['ok']);
  });

  test('throws on missing file', async () => {
    expect(loadConfig(tmp)).rejects.toThrow(/mapper.config.toml/);
  });

  test('throws on missing schema_version', async () => {
    await writeFile(join(tmp, 'mapper.config.toml'), `[tools]\nclaude = true\n`);
    expect(loadConfig(tmp)).rejects.toThrow(/schema_version/);
  });
});
