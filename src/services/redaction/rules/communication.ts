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
  {
    id: 'slack-legacy-token',
    description: 'Slack legacy XKeysib / xoxe-style refresh tokens',
    pattern: /\bxoxe(?:\.xox[abprs])?-\d{1,3}-\d{10,}-\d{10,}-[A-Za-z0-9-]{20,}\b/g,
    replacement: '[REDACTED:slack-legacy-token]',
    stage: 1,
  },
  {
    id: 'twitch-irc-oauth-token',
    description: 'Twitch IRC OAuth token (oauth:30 lowercase alphanumeric)',
    pattern: /\boauth:[a-z0-9]{30}\b/g,
    replacement: '[REDACTED:twitch-irc-oauth-token]',
    stage: 1,
  },
  {
    id: 'microsoft-teams-webhook',
    description: 'Microsoft Teams incoming webhook URL',
    pattern:
      /\bhttps?:\/\/[a-zA-Z0-9.-]+\.webhook\.office\.com\/webhookb2\/[a-f0-9-]{36}@[a-f0-9-]{36}\/IncomingWebhook\/[a-f0-9]{32}\/[a-f0-9-]{36}\b/g,
    replacement: '[REDACTED:microsoft-teams-webhook]',
    stage: 1,
  },
  {
    id: 'mattermost-personal-access-token',
    description: 'Mattermost personal access token (26 lowercase alnum after MATTERMOST keyword)',
    pattern: /(MATTERMOST[_-]?(?:TOKEN|PAT)\s*[:=]\s*)["']?[a-z0-9]{26}["']?/gi,
    replacement: '$1[REDACTED:mattermost-personal-access-token]',
    stage: 2,
  },
  {
    id: 'rocketchat-personal-token',
    description: 'Rocket.Chat personal access token (43 char base64 after ROCKETCHAT keyword)',
    pattern: /(ROCKETCHAT[_-]?(?:TOKEN|AUTH[_-]?TOKEN)\s*[:=]\s*)["']?[A-Za-z0-9_-]{43}["']?/gi,
    replacement: '$1[REDACTED:rocketchat-personal-token]',
    stage: 2,
  },
  {
    id: 'zoom-webhook-secret',
    description: 'Zoom webhook secret token (32 char alnum after ZOOM_WEBHOOK keyword)',
    pattern:
      /(ZOOM[_-]?(?:WEBHOOK|VERIFICATION)[_-]?(?:SECRET|TOKEN)\s*[:=]\s*)["']?[A-Za-z0-9]{32}["']?/gi,
    replacement: '$1[REDACTED:zoom-webhook-secret]',
    stage: 2,
  },
  {
    id: 'zulip-bot-api-key',
    description: 'Zulip bot API key (32 char after ZULIP_API keyword)',
    pattern: /(ZULIP[_-]?API[_-]?KEY\s*[:=]\s*)["']?[A-Za-z0-9]{32}["']?/gi,
    replacement: '$1[REDACTED:zulip-bot-api-key]',
    stage: 2,
  },
];
