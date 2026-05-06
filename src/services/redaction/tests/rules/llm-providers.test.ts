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

test('redacts a Cohere API key with co_ prefix', () => {
  const input = 'COHERE_API_KEY=co_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:cohere-api-key]');
});

test('redacts a prefixless Cohere API key via keyword anchor', () => {
  const input = 'COHERE_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:cohere-api-key]');
});

test('redacts an OpenAI admin API key (sk-admin-)', () => {
  const input = 'OPENAI_ADMIN_KEY=sk-admin-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:openai-api-key]');
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

test('redacts a Cerebras Cloud API key (csk-)', () => {
  const input = 'CEREBRAS_API_KEY=csk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:cerebras-api-key]');
});

test('redacts an Anyscale Endpoints API key (esecret_)', () => {
  const input = 'ANYSCALE_API_KEY=esecret_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:anyscale-api-key]');
});

test('redacts a RunPod API key (rpa_)', () => {
  const input = 'RUNPOD_API_KEY=rpa_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:runpod-api-key]');
});

test('redacts an NVIDIA NIM/NGC API key (nvapi-)', () => {
  const input = 'NVIDIA_API_KEY=nvapi-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQr';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:nvidia-nim-api-key]');
});

test('redacts a DeepSeek API key (keyword-anchored)', () => {
  const input = 'DEEPSEEK_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCd';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:deepseek-api-key]');
});

test('redacts an Azure OpenAI API key (keyword-anchored)', () => {
  const input = 'AZURE_OPENAI_API_KEY=0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:azure-openai-api-key]');
});

test('redacts a Google Gemini API key (keyword-anchored)', () => {
  const input = 'GEMINI_API_KEY=AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:gemini-api-key]');
});

test('redacts an AI21 Labs API key (keyword-anchored)', () => {
  const input = 'AI21_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:ai21-api-key]');
});

test('redacts an Aleph Alpha API key (keyword-anchored)', () => {
  const input = 'ALEPH_ALPHA_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYzAbCd';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:aleph-alpha-api-key]');
});

test('redacts a DeepInfra API key (keyword-anchored)', () => {
  const input = 'DEEPINFRA_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:deepinfra-api-key]');
});

test('redacts a Modal Labs API token (keyword-anchored)', () => {
  const input = 'MODAL_TOKEN_SECRET=ak-AbCdEfGhIjKlMnOpQrStUv';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:modal-api-key]');
});

test('redacts a Lambda Labs API key (keyword-anchored)', () => {
  const input = 'LAMBDA_LABS_API_KEY=secret_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:lambda-labs-api-key]');
});

test('redacts a Baseten API key (keyword-anchored)', () => {
  const input = 'BASETEN_API_KEY=Aabbccd.AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:baseten-api-key]');
});

test('redacts a SambaNova API key (keyword-anchored)', () => {
  const input = 'SAMBANOVA_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYzAbCd';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:sambanova-api-key]');
});

test('redacts a Lepton AI API token (keyword-anchored)', () => {
  const input = 'LEPTON_API_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:lepton-api-key]');
});

test('redacts an Inflection AI API key (keyword-anchored)', () => {
  const input = 'INFLECTION_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYzAbCd';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:inflection-api-key]');
});

test('redacts a Novita AI API key (keyword-anchored)', () => {
  const input = 'NOVITA_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:novita-api-key]');
});

test('redacts a Hyperbolic AI API key (keyword-anchored)', () => {
  const input = 'HYPERBOLIC_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';
  const result = applyRedaction(input, LLM_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:hyperbolic-api-key]');
});
