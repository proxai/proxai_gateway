import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const LLM_PROVIDERS_RULES: readonly RedactionRule[] = [
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key (sk-ant-...)',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:anthropic-api-key]',
    stage: 1,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key (sk-, sk-proj-, sk-svcacct-)',
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g,
    replacement: '[REDACTED:openai-api-key]',
    stage: 1,
  },
  {
    id: 'huggingface-token',
    description: 'Hugging Face access token',
    pattern: /\bhf_[A-Za-z0-9]{34,}\b/g,
    replacement: '[REDACTED:huggingface-token]',
    stage: 1,
  },
  {
    id: 'replicate-token',
    description: 'Replicate API token',
    pattern: /\br8_[A-Za-z0-9]{37,}\b/g,
    replacement: '[REDACTED:replicate-token]',
    stage: 1,
  },
];
