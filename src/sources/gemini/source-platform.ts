import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SourcePlatform } from 'services/contract';
import {
  ANTIGRAVITY_CLI_PLATFORM,
  ANTIGRAVITY_IDE_PLATFORM,
  GEMINI_CLI_VARIANT_DIR,
  GEMINI_CONVERSATIONS_DIR,
  GEMINI_HOME_SUBPATH,
  GEMINI_IDE_VARIANT_DIR,
} from 'sources/gemini/gemini.constants.ts';

export type GeminiRootKind = 'cli' | 'ide';

export function geminiPlatformForRoot(rootKind: GeminiRootKind): SourcePlatform {
  return rootKind === 'ide' ? ANTIGRAVITY_IDE_PLATFORM : ANTIGRAVITY_CLI_PLATFORM;
}

export function defaultGeminiCliConversationsDir(): string {
  return join(homedir(), GEMINI_HOME_SUBPATH, GEMINI_CLI_VARIANT_DIR, GEMINI_CONVERSATIONS_DIR);
}

export function defaultGeminiIdeConversationsDir(): string {
  return join(homedir(), GEMINI_HOME_SUBPATH, GEMINI_IDE_VARIANT_DIR, GEMINI_CONVERSATIONS_DIR);
}
