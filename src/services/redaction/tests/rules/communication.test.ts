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
