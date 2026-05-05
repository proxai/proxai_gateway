import { confirm, input } from '@inquirer/prompts';

export interface PromptSink {
  askApiKey(): Promise<string>;
  confirmOverwrite(message: string): Promise<boolean>;
  confirmUninstall(message: string): Promise<boolean>;
}

export function inquirerPrompts(): PromptSink {
  return {
    askApiKey: () =>
      input({
        message: 'Enter your ProxAI API key:',
        validate: (v) => (v.trim().length > 0 ? true : 'API key is required'),
      }),
    confirmOverwrite: (message) => confirm({ message, default: false }),
    confirmUninstall: (message) => confirm({ message, default: false }),
  };
}

export function scriptedPrompts(answers: {
  apiKey?: string;
  overwrite?: boolean;
  uninstall?: boolean;
}): PromptSink {
  return {
    askApiKey: async () => {
      if (answers.apiKey === undefined) throw new Error('scripted prompt: no apiKey provided');
      return answers.apiKey;
    },
    confirmOverwrite: async () => answers.overwrite ?? false,
    confirmUninstall: async () => answers.uninstall ?? false,
  };
}
