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
