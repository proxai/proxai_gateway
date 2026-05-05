import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const COMMUNICATION_RULES: readonly RedactionRule[] = [
  {
    id: 'slack-token',
    description: 'Slack bot / user / refresh token (xox[abprs]-)',
    pattern: /\bxox[abprs]-\d{10,}-\d{10,}-[A-Za-z0-9-]{20,}\b/g,
    replacement: '[REDACTED:slack-token]',
    stage: 1,
  },
  {
    id: 'slack-app-token',
    description: 'Slack app-level token (xapp-)',
    pattern: /\bxapp-\d-[A-Z0-9]{10,}-\d{10,}-[a-f0-9]{60,}\b/g,
    replacement: '[REDACTED:slack-app-token]',
    stage: 1,
  },
  {
    id: 'slack-incoming-webhook',
    description: 'Slack incoming webhook URL',
    pattern:
      /\bhttps?:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED:slack-incoming-webhook]',
    stage: 1,
  },
  {
    id: 'discord-webhook',
    description: 'Discord webhook URL',
    pattern:
      /\bhttps?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:discord-webhook]',
    stage: 1,
  },
  {
    id: 'discord-bot-token',
    description: 'Discord bot token (24.6.27+ alphanumeric segments)',
    pattern: /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
    replacement: '[REDACTED:discord-bot-token]',
    stage: 1,
  },
  {
    id: 'telegram-bot-token',
    description: 'Telegram bot token (digits:35chars)',
    pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35,}\b/g,
    replacement: '[REDACTED:telegram-bot-token]',
    stage: 1,
  },
];
