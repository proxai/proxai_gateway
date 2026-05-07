import { confirm, input } from '@inquirer/prompts';

export interface PromptSink {
  askApiKey(message?: string): Promise<string>;
  confirmReset(message: string): Promise<boolean>;
  confirmUpgrade(message: string): Promise<boolean>;
}

export function inquirerPrompts(): PromptSink {
  return {
    askApiKey: (message) =>
      input({
        message: message ?? 'Enter your ProxAI ingestion key:',
        validate: (v) => (v.trim().length > 0 ? true : 'ingestion key is required'),
      }),
    confirmReset: (message) => confirm({ message, default: false }),
    confirmUpgrade: (message) => confirm({ message, default: true }),
  };
}

export function scriptedPrompts(answers: {
  apiKey?: string;
  apiKeys?: string[];
  reset?: boolean;
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
    confirmReset: async () => {
      if (answers.reset === undefined) {
        throw new Error('scripted prompt: no reset answer provided');
      }
      return answers.reset;
    },
    confirmUpgrade: async () => {
      if (answers.upgrade === undefined) {
        throw new Error('scripted prompt: no upgrade answer provided');
      }
      return answers.upgrade;
    },
  };
}
