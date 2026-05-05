import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { LLM_PROVIDERS_RULES } from 'services/redaction/rules/llm-providers.ts';

test('redacts an Anthropic API key', () => {
  const input = 'ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzAbCd';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:anthropic-api-key]');
});

test('redacts a legacy OpenAI key', () => {
  const input = 'OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:openai-api-key]');
});

test('redacts an OpenAI project key (sk-proj-)', () => {
  const input = 'OPENAI_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:openai-api-key]');
});

test('OpenAI rule does not match Anthropic-prefixed key', () => {
  const input = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:anthropic-api-key]');
  expect(result.redacted).not.toContain('[REDACTED:openai-api-key]');
});

test('redacts a Hugging Face token', () => {
  const input = 'HF_TOKEN=hf_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:huggingface-token]');
});

test('redacts a Replicate token', () => {
  const input = 'REPLICATE_API_TOKEN=r8_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlmn';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:replicate-token]');
});

test('does not redact short prefix-only strings', () => {
  const input = 'sk-1234, sk-ant-1234, hf_x, r8_short';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.matchCount).toBe(0);
});

test('redacts a Cohere API key', () => {
  const input = 'COHERE_API_KEY=co_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:cohere-api-key]');
});

test('redacts an OpenRouter API key', () => {
  const input = 'OPENROUTER_API_KEY=sk-or-v1-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:openrouter-api-key]');
});

test('redacts a Groq API key', () => {
  const input = 'GROQ_API_KEY=gsk_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:groq-api-key]');
});

test('redacts a Voyage AI API key', () => {
  const input = 'VOYAGE_API_KEY=pa-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:voyage-api-key]');
});

test('redacts an xAI Grok API key', () => {
  const input = 'XAI_API_KEY=xai-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:xai-grok-api-key]');
});

test('redacts a Fireworks AI API key', () => {
  const input = 'FIREWORKS_API_KEY=fw_AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:fireworks-api-key]');
});

test('redacts a Perplexity API key', () => {
  const input = 'PPLX=pplx-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:perplexity-api-key]');
});

test('redacts a Mistral keyword-anchored API key', () => {
  const input = 'MISTRAL_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:mistral-api-key]');
});

test('redacts a Together AI keyword-anchored API key', () => {
  const input = 'TOGETHER_API_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:together-ai-api-key]');
});
