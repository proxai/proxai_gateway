import { confirm, input } from '@inquirer/prompts';

import { UserAbortedError } from 'core/utils';

export interface PromptSink {
  askApiKey(message?: string): Promise<string>;
  confirmPhrase(message: string, requiredPhrase: string): Promise<boolean>;
  confirmUpgrade(message: string): Promise<boolean>;
}

const ABORT_ERROR_NAMES = new Set(['ExitPromptError', 'AbortPromptError', 'CancelPromptError']);

function isPromptAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (ABORT_ERROR_NAMES.has(err.name)) return true;
  const message = err.message.toLowerCase();
  return message.includes('force closed') || message.includes('user force');
}

async function rethrowAborts<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isPromptAbort(err)) throw new UserAbortedError();
    throw err;
  }
}

export function inquirerPrompts(): PromptSink {
  return {
    askApiKey: (message) =>
      rethrowAborts(() =>
        input({
          message: message ?? 'Enter your ProxAI ingestion key:',
          validate: (v) => (v.trim().length > 0 ? true : 'ingestion key is required'),
        }),
      ),
    confirmPhrase: (message, requiredPhrase) =>
      rethrowAborts(async () => {
        const answer = await input({
          message,
          validate: (v) => {
            const trimmed = v.trim();
            if (trimmed === '' || trimmed === requiredPhrase) return true;
            return `type '${requiredPhrase}' to confirm, or leave empty to abort`;
          },
        });
        return answer.trim() === requiredPhrase;
      }),
    confirmUpgrade: (message) => rethrowAborts(() => confirm({ message, default: true })),
  };
}

export function scriptedPrompts(answers: {
  apiKey?: string;
  apiKeys?: string[];
  phrase?: string | boolean;
  upgrade?: boolean;
}): PromptSink {
  const queue: string[] = [
    ...(answers.apiKeys ?? []),
    ...(answers.apiKey !== undefined ? [answers.apiKey] : []),
  ];
  return {
    askApiKey: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('scripted prompt: no apiKey provided');
      return next;
    },
    confirmPhrase: async (_message, requiredPhrase) => {
      if (answers.phrase === undefined) {
        throw new Error('scripted prompt: no phrase answer provided');
      }
      if (typeof answers.phrase === 'boolean') return answers.phrase;
      return answers.phrase === requiredPhrase;
    },
    confirmUpgrade: async () => {
      if (answers.upgrade === undefined) {
        throw new Error('scripted prompt: no upgrade answer provided');
      }
      return answers.upgrade;
    },
  };
}
