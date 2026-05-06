import { input } from '@inquirer/prompts';

export interface PromptSink {
  askApiKey(message?: string): Promise<string>;
}

export function inquirerPrompts(): PromptSink {
  return {
    askApiKey: (message) =>
      input({
        message: message ?? 'Enter your ProxAI ingestion key:',
        validate: (v) => (v.trim().length > 0 ? true : 'ingestion key is required'),
      }),
  };
}

export function scriptedPrompts(answers: { apiKey?: string; apiKeys?: string[] }): PromptSink {
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
  };
}
