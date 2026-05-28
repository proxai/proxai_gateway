import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

interface ManifestEntry {
  path: string;
  hash: string;
}

const MANIFEST_FILE = 'ai/.mapper-manifest.json';

export class Manifest {
  private entries: ManifestEntry[] = [];
  /**
   * Hash of the entire ai/ source tree at the time this manifest was written.
   * Used by the fast-skip path in `runSync()` — when the current source hash
   * matches this value AND every emitted file still exists, sync is a no-op.
   * Undefined for manifests written before this field was introduced; treat
   * as "always sync".
   */
  private storedSourceHash: string | undefined;
  constructor(private readonly repoRoot: string) {}

  recordEmit(relPath: string, hash: string): void {
    const normalized = relPath.replace(/\\/g, '/');
    this.entries.push({ path: normalized, hash });
  }

  files(): readonly ManifestEntry[] {
    return this.entries;
  }

  sourceHash(): string | undefined {
    return this.storedSourceHash;
  }

  setSourceHash(hash: string): void {
    this.storedSourceHash = hash;
  }

  static async load(repoRoot: string): Promise<Manifest> {
    const path = join(repoRoot, MANIFEST_FILE);
    try {
      await stat(path);
    } catch {
      return new Manifest(repoRoot);
    }
    const raw = await readFile(path, 'utf8');
    const m = new Manifest(repoRoot);
    try {
      const data = JSON.parse(raw) as {
        files: ManifestEntry[];
        sourceHash?: string;
      };
      for (const f of data.files) m.entries.push(f);
      if (typeof data.sourceHash === 'string') {
        m.storedSourceHash = data.sourceHash;
      }
    } catch (e) {
      throw new Error(`Corrupt manifest at ${path}: ${(e as Error).message}`, { cause: e });
    }
    return m;
  }

  async save(): Promise<void> {
    const path = join(this.repoRoot, MANIFEST_FILE);
    await mkdir(dirname(path), { recursive: true });
    const data = {
      version: 1,
      generatedAt: new Date().toISOString(),
      sourceHash: this.storedSourceHash,
      files: this.entries,
    };
    await writeFile(path, JSON.stringify(data, null, 2) + '\n');
  }

  /**
   * Files that were emitted by an earlier run (in `old`) but are NOT in this run.
   * The caller is responsible for deleting them (safe-wipe).
   */
  diffStale(old: Manifest): string[] {
    const currentPaths = new Set(this.entries.map((e) => e.path));
    return old.entries.filter((e) => !currentPaths.has(e.path)).map((e) => e.path);
  }
}
