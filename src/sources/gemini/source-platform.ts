import { homedir } from 'node:os';
import { join } from 'node:path';

import { GEMINI_ANTIGRAVITY_BASE_SUBPATH } from 'sources/gemini/gemini.constants.ts';

export function defaultGeminiAntigravityBaseDir(): string {
  return join(homedir(), GEMINI_ANTIGRAVITY_BASE_SUBPATH);
}
