import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { profileRootDir } from 'core/io/fs/profile.ts';

export const LEGACY_MIGRATED_MARKER = '.migrated-legacy-root';

export function getLegacyRootDir(): string {
  if (process.env['PROXAI_TEST_LEGACY_ROOT']) {
    return process.env['PROXAI_TEST_LEGACY_ROOT'];
  }
  // Always ~/.proxai/proxai-gateway on macOS/Linux
  return join(homedir(), '.proxai', 'proxai-gateway');
}

export function relocateLegacyRoot(): void {
  // Only apply to POSIX (darwin/linux)
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return;
  }

  const legacyRoot = getLegacyRootDir();
  const newRoot = profileRootDir();

  // If the legacy directory doesn't exist, we have nothing to migrate.
  if (!existsSync(legacyRoot)) {
    return;
  }

  // If the legacy directory exists but we've already migrated it (marker file present), do nothing
  const markerPath = join(legacyRoot, LEGACY_MIGRATED_MARKER);
  if (existsSync(markerPath)) {
    return;
  }

  // If the new directory already exists (for some reason, e.g. clean setup ran first), we don't overwrite it.
  // We'll just write the marker to the legacy folder to mark it as skipped/migrated.
  if (existsSync(newRoot)) {
    writeMigrationMarker(legacyRoot);
    return;
  }

  try {
    // Create the parent directories of the new root path
    mkdirSync(dirname(newRoot), { recursive: true });

    // Perform atomic rename (move)
    renameSync(legacyRoot, newRoot);

    // Now, rewrite any absolute paths inside config.toml to point to the new location.
    // The profiles we have are `prod` and `dev`.
    for (const profile of ['prod', 'dev']) {
      const configPath = join(newRoot, profile, 'config.toml');
      if (existsSync(configPath)) {
        try {
          let content = readFileSync(configPath, 'utf8');
          // Replace legacy absolute path references with new absolute path references
          const oldProfileRoot = legacyRoot;
          const newProfileRoot = newRoot;

          if (content.includes(oldProfileRoot)) {
            content = content.replaceAll(oldProfileRoot, newProfileRoot);
            writeFileSync(configPath, content, 'utf8');
          }
        } catch (configErr) {
          // Non-blocking error: print warning and continue
          console.warn(
            `[warning] failed to update config.toml paths for profile ${profile}:`,
            configErr,
          );
        }
      }
    }

    // Write the migration marker inside the relocated directory (which is now at the newRoot)
    writeMigrationMarker(newRoot);
  } catch (err) {
    console.error(
      `[error] failed to migrate legacy gateway root from ${legacyRoot} to ${newRoot}:`,
      err,
    );
  }
}

function writeMigrationMarker(dir: string): void {
  try {
    writeFileSync(join(dir, LEGACY_MIGRATED_MARKER), `migrated-at=${new Date().toISOString()}\n`);
  } catch {}
}
