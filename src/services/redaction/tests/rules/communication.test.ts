import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { COMMUNICATION_RULES } from 'services/redaction/rules/communication.ts';

test('redacts a Slack bot token (xoxb-)', () => {
  const input = 'SLACK_TOKEN=xoxb-1234567890-9876543210-AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:slack-token]');
});

test('redacts a Slack incoming webhook URL', () => {
  const input = 'https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/AbCdEfGhIjKlMnOpQrStUv';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:slack-incoming-webhook]');
});

test('redacts a Discord webhook URL', () => {
  const input = 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:discord-webhook]');
});

test('redacts a Discord bot token (24.6.27 segments)', () => {
  const input = 'TOKEN=AbCdEfGhIjKlMnOpQrStUvWx.YzAbCd.EfGhIjKlMnOpQrStUvWxYzAbCdEfG';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:discord-bot-token]');
});

test('redacts a Telegram bot token', () => {
  const input = 'TELEGRAM_TOKEN=123456789:AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:telegram-bot-token]');
});

test('redacts a Slack legacy refresh token (xoxe-)', () => {
  const input = 'TOKEN=xoxe-1-1234567890-9876543210-AbCdEfGhIjKlMnOpQrStUv';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:slack-legacy-token]');
});

test('redacts a Twitch IRC OAuth token', () => {
  const input = 'PASS oauth:abcdefghijklmnopqrstuvwxyz0123';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:twitch-irc-oauth-token]');
});

test('redacts a Microsoft Teams webhook URL', () => {
  const input =
    'https://contoso.webhook.office.com/webhookb2/12345678-1234-1234-1234-123456789012@12345678-1234-1234-1234-123456789012/IncomingWebhook/0123456789abcdef0123456789abcdef/12345678-1234-1234-1234-123456789012';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:microsoft-teams-webhook]');
});

test('redacts a Mattermost personal access token (keyword-anchored)', () => {
  const input = 'MATTERMOST_TOKEN=abcdefghijklmnopqrstuvwxyz';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:mattermost-personal-access-token]');
});

test('redacts a Rocket.Chat personal access token (keyword-anchored)', () => {
  const input = 'ROCKETCHAT_AUTH_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFG';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:rocketchat-personal-token]');
});

test('redacts a Zoom webhook secret token (keyword-anchored)', () => {
  const input = 'ZOOM_WEBHOOK_SECRET=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:zoom-webhook-secret]');
});

test('redacts a Zulip bot API key (keyword-anchored)', () => {
  const input = 'ZULIP_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const result = applyRedaction(input, COMMUNICATION_RULES);
  expect(result.redacted).toContain('[REDACTED:zulip-bot-api-key]');
});
