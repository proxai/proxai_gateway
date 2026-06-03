import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LEGACY_MIGRATED_MARKER,
  getLegacyRootDir,
  relocateLegacyRoot,
} from 'core/io/fs/migrate-legacy-root.ts';

describe('relocateLegacyRoot', () => {
  let tempDir: string;
  let legacyRoot: string;
  let newRoot: string;
  let originalPlatform: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `proxai-test-relocate-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    legacyRoot = join(tempDir, 'legacy-root');
    newRoot = join(tempDir, 'new-root');

    process.env['PROXAI_TEST_LEGACY_ROOT'] = legacyRoot;
    process.env['PROXAI_TEST_PROFILE_ROOT'] = newRoot;

    originalPlatform = process.platform;
  });

  afterEach(() => {
    delete process.env['PROXAI_TEST_LEGACY_ROOT'];
    delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    rmSync(tempDir, { recursive: true, force: true });
    // Restore platform
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('does nothing if the platform is not darwin or linux', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    mkdirSync(legacyRoot, { recursive: true });
    relocateLegacyRoot();

    expect(existsSync(newRoot)).toBe(false);
  });

  it('does nothing if the legacy directory does not exist', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    relocateLegacyRoot();

    expect(existsSync(newRoot)).toBe(false);
  });

  it('does nothing if already migrated (marker present in legacy folder)', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, LEGACY_MIGRATED_MARKER), 'migrated');

    relocateLegacyRoot();

    expect(existsSync(newRoot)).toBe(false);
  });

  it('marks as skipped/migrated if new root already exists', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    mkdirSync(legacyRoot, { recursive: true });
    mkdirSync(newRoot, { recursive: true });

    relocateLegacyRoot();

    expect(existsSync(join(legacyRoot, LEGACY_MIGRATED_MARKER))).toBe(true);
    // Verifies it didn't rename it
    expect(existsSync(legacyRoot)).toBe(true);
  });

  it('performs the relocation and updates config.toml references', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    mkdirSync(join(legacyRoot, 'prod'), { recursive: true });
    mkdirSync(join(legacyRoot, 'dev'), { recursive: true });

    const prodConfigPath = join(legacyRoot, 'prod', 'config.toml');
    const devConfigPath = join(legacyRoot, 'dev', 'config.toml');

    const configContent = `
[capture]
buffer_path = "${legacyRoot}/prod/buffer.db"
`;
    writeFileSync(prodConfigPath, configContent);
    writeFileSync(devConfigPath, `some content with no match`);

    relocateLegacyRoot();

    expect(existsSync(legacyRoot)).toBe(false);
    expect(existsSync(newRoot)).toBe(true);

    const migratedProdConfig = readFileSync(join(newRoot, 'prod', 'config.toml'), 'utf8');
    expect(migratedProdConfig).toContain(newRoot);
    expect(migratedProdConfig).not.toContain(legacyRoot);

    expect(existsSync(join(newRoot, LEGACY_MIGRATED_MARKER))).toBe(true);
  });

  it('recovers gracefully if rename or write operations fail', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    mkdirSync(legacyRoot, { recursive: true });

    // Make the parent of newRoot read-only or uncreatable to trigger a throw.
    // To trigger a throw in renameSync safely, let's pass a path containing null bytes or invalid paths.
    process.env['PROXAI_TEST_PROFILE_ROOT'] = '\0invalid-path';

    // Verify it doesn't crash the program, but catches the error
    expect(() => relocateLegacyRoot()).not.toThrow();
  });

  it('handles config.toml read errors gracefully (e.g. if it is a directory)', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    mkdirSync(join(legacyRoot, 'prod'), { recursive: true });
    // Create config.toml as a directory to force readFileSync to fail (EISDIR)
    mkdirSync(join(legacyRoot, 'prod', 'config.toml'), { recursive: true });

    expect(() => relocateLegacyRoot()).not.toThrow();
  });

  it('resolves the real legacy directory when the test env override is absent', () => {
    delete process.env['PROXAI_TEST_LEGACY_ROOT'];
    const resolved = getLegacyRootDir();
    expect(resolved).toContain('.proxai');
    expect(resolved).toContain('proxai-gateway');
  });
});
