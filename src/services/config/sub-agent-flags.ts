import type { SourceApp } from 'services/contract';

const GLOBAL_ENV_VAR = 'PROXAI_GATEWAY_CAPTURE_SUB_AGENTS';

const PER_SOURCE_ENV_VAR: Readonly<Record<SourceApp, string>> = {
  'claude-code': 'PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_CODE',
  codex: 'PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CODEX',
  cursor: 'PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CURSOR',
  'claude-desktop': 'PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_DESKTOP',
  gemini: 'PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_GEMINI',
};

const TRUTHY_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes']);

export function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  return TRUTHY_VALUES.has(value.trim().toLowerCase());
}

export function resolveSubAgentCapture(
  sourceApp: SourceApp,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (parseBool(env[GLOBAL_ENV_VAR])) return true;
  return parseBool(env[PER_SOURCE_ENV_VAR[sourceApp]]);
}

export const SUB_AGENT_CAPTURE_BY_SOURCE: Readonly<Record<SourceApp, boolean>> = {
  'claude-code': resolveSubAgentCapture('claude-code'),
  codex: resolveSubAgentCapture('codex'),
  cursor: resolveSubAgentCapture('cursor'),
  'claude-desktop': resolveSubAgentCapture('claude-desktop'),
  gemini: resolveSubAgentCapture('gemini'),
};
