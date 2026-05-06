import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const LLM_PROVIDERS_RULES: readonly RedactionRule[] = [
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key (sk-ant-...)',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:anthropic-api-key]',
  },
  {
    id: 'openrouter-api-key',
    description: 'OpenRouter API key (sk-or-v1-...)',
    pattern: /\bsk-or-v1-[A-Za-z0-9]{40,}\b/g,
    replacement: '[REDACTED:openrouter-api-key]',
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key (sk-, sk-proj-, sk-svcacct-)',
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g,
    replacement: '[REDACTED:openai-api-key]',
  },
  {
    id: 'huggingface-token',
    description: 'Hugging Face access token',
    pattern: /\bhf_[A-Za-z0-9]{34,}\b/g,
    replacement: '[REDACTED:huggingface-token]',
  },
  {
    id: 'replicate-token',
    description: 'Replicate API token',
    pattern: /\br8_[A-Za-z0-9]{37,}\b/g,
    replacement: '[REDACTED:replicate-token]',
  },
  {
    id: 'cohere-api-key',
    description: 'Cohere API key (co_...)',
    pattern: /\bco_[A-Za-z0-9]{40,}\b/g,
    replacement: '[REDACTED:cohere-api-key]',
  },
  {
    id: 'groq-api-key',
    description: 'Groq API key (gsk_...)',
    pattern: /\bgsk_[A-Za-z0-9]{40,}\b/g,
    replacement: '[REDACTED:groq-api-key]',
  },
  {
    id: 'xai-grok-api-key',
    description: 'xAI Grok API key (xai-...)',
    pattern: /\bxai-[A-Za-z0-9]{60,}\b/g,
    replacement: '[REDACTED:xai-grok-api-key]',
  },
  {
    id: 'fireworks-api-key',
    description: 'Fireworks AI API key (fw_...)',
    pattern: /\bfw_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED:fireworks-api-key]',
  },
  {
    id: 'perplexity-api-key',
    description: 'Perplexity AI API key (pplx-...)',
    pattern: /\bpplx-[A-Za-z0-9]{40,}\b/g,
    replacement: '[REDACTED:perplexity-api-key]',
  },
  {
    id: 'voyage-api-key',
    description: 'Voyage AI API key (pa-...)',
    pattern: /\bpa-[A-Za-z0-9_-]{40,}\b/g,
    replacement: '[REDACTED:voyage-api-key]',
  },
  {
    id: 'mistral-api-key',
    description: 'Mistral API key (32-char alphanumeric after MISTRAL keyword)',
    pattern: /(MISTRAL[_A-Z]*KEY\s*[:=]\s*)["']?[A-Za-z0-9]{32}["']?/g,
    replacement: '$1[REDACTED:mistral-api-key]',
  },
  {
    id: 'together-ai-api-key',
    description: 'Together AI API key (64 hex after TOGETHER keyword)',
    pattern: /(TOGETHER[_A-Z]*KEY\s*[:=]\s*)["']?[a-f0-9]{64}["']?/g,
    replacement: '$1[REDACTED:together-ai-api-key]',
  },
];
