#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { confirm } from '@inquirer/prompts';

import { PublishAbortError, parseArgv, runPublish, type GitOps } from 'scripts/release/publish.ts';

function defaultGitOps(): GitOps {
  return {
    status: () => execSync('git status --porcelain', { encoding: 'utf8' }),
    currentBranch: () => execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
    fetchOrigin: () => {
      execSync('git fetch origin main', { stdio: 'inherit' });
    },
    localHead: () => execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
    remoteHead: (branch: string) =>
      execSync(`git rev-parse origin/${branch}`, { encoding: 'utf8' }).trim(),
    listTags: (pattern: string) => {
      const out = execSync(`git tag --list "${pattern}"`, { encoding: 'utf8' }).trim();
      return out.length === 0 ? [] : out.split('\n');
    },
    createTag: (name: string, message: string) => {
      execSync(`git tag -a ${name} -m "${message}"`, { stdio: 'inherit' });
    },
    pushTag: (name: string) => {
      execSync(`git push origin ${name}`, { stdio: 'inherit' });
    },
    stageFile: (path: string) => {
      execSync(`git add ${path}`, { stdio: 'inherit' });
    },
    commit: (message: string) => {
      const escaped = message.replace(/"/g, '\\"');
      execSync(`git commit -m "${escaped}"`, { stdio: 'inherit' });
    },
    pushBranch: (branch: string) => {
      execSync(`git push origin ${branch}`, { stdio: 'inherit' });
    },
  };
}

function defaultRunValidate(): void {
  execSync('bun run validate', { stdio: 'inherit' });
}

async function defaultPrompt(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}

const options = parseArgv(process.argv.slice(2));
try {
  const result = await runPublish(
    {
      git: defaultGitOps(),
      runValidate: defaultRunValidate,
      prompt: defaultPrompt,
      log: (line) => {
        console.log(line);
      },
      readPackageJson: () => readFileSync('package.json', 'utf8'),
      writePackageJson: (content: string) => writeFileSync('package.json', content, 'utf8'),
    },
    options,
  );
  if (!result.pushed) {
    process.exit(0);
  }
} catch (err) {
  if (err instanceof PublishAbortError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
