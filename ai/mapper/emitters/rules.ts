import { join } from 'node:path';
import { writeFileAtomic, hashOf } from '../safe-fs';
import type { AiTree } from '../loader';
import type { MapperConfig } from '../config';
import type { Manifest } from '../manifest';

export async function emitRules(
  repoRoot: string,
  tree: AiTree,
  cfg: MapperConfig,
  mani: Manifest,
): Promise<void> {
  for (const rule of tree.rules) {
    const body = rule.body.trim();
    const fm = rule.frontmatter || {};
    const activation = (fm.activation as string) || 'global';
    const name = (fm.name as string) || rule.basename;
    const desc = (fm.description as string) || name;

    const globsArray = Array.isArray(fm.globs) ? (fm.globs as string[]) : [];

    // Option B: If activation is 'lazy-load', skip Claude and Cursor folders entirely
    if (cfg.tools.claude && activation !== 'lazy-load') {
      const rel = join(cfg.paths.claudeDir, 'rules', `${rule.subpath}.md`);
      let content = '';
      if (activation === 'contextual') {
        const pathsYaml = globsArray.map((g) => `  - "${g}"`).join('\n');
        content = `---\npaths:\n${pathsYaml}\n---\n\n${body}\n`;
      } else {
        content = body + '\n';
      }
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.cursor && activation !== 'lazy-load') {
      // Flatten nested subpaths for Cursor rules
      const flatName = rule.subpath.replace(/\//g, '-');
      const rel = join(cfg.paths.cursorDir, 'rules', `${flatName}.mdc`);

      let alwaysApply = 'true';
      let cursorGlobs = '';
      if (activation === 'contextual') {
        alwaysApply = 'false';
        cursorGlobs = globsArray.join(', ');
      }

      const content = `---\ndescription: ${desc}\nglobs: "${cursorGlobs}"\nalwaysApply: ${alwaysApply}\n---\n\n${body}\n`;
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.codex) {
      const rel = join(cfg.paths.codexDir, 'rules', `${rule.subpath}.md`);
      const content = body + '\n';
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.antigravity) {
      const rel = join(cfg.paths.antigravityDir, 'rules', `${rule.subpath}.md`);
      let content = '';
      if (activation === 'contextual') {
        const globsYaml = globsArray.map((g) => `  - "${g}"`).join('\n');
        content = `---\ntrigger: glob\nglobs:\n${globsYaml}\ndescription: "${desc.replace(/"/g, '\\"')}"\n---\n\n${body}\n`;
      } else if (activation === 'lazy-load') {
        content = `---\ntrigger: model_decision\ndescription: "${desc.replace(/"/g, '\\"')}"\n---\n\n${body}\n`;
      } else {
        content = `---\ntrigger: always_on\ndescription: "${desc.replace(/"/g, '\\"')}"\n---\n\n${body}\n`;
      }
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }
  }
}
