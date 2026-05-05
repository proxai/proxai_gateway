import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const AUTH_SERVICES_RULES: readonly RedactionRule[] = [
  {
    id: 'twilio-account-sid',
    description: 'Twilio Account SID (AC + 32 hex)',
    pattern: /\bAC[a-f0-9]{32}\b/g,
    replacement: '[REDACTED:twilio-account-sid]',
    stage: 1,
  },
  {
    id: 'twilio-api-key',
    description: 'Twilio API key (SK + 32 hex)',
    pattern: /\bSK[a-f0-9]{32}\b/g,
    replacement: '[REDACTED:twilio-api-key]',
    stage: 1,
  },
  {
    id: 'sendgrid-api-key',
    description: 'SendGrid API key (SG.X.Y)',
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED:sendgrid-api-key]',
    stage: 1,
  },
  {
    id: 'mailgun-api-key',
    description: 'Mailgun API key (key-)',
    pattern: /\bkey-[a-f0-9]{32}\b/g,
    replacement: '[REDACTED:mailgun-api-key]',
    stage: 1,
  },
  {
    id: 'mailchimp-api-key',
    description: 'Mailchimp API key (32 hex - usN)',
    pattern: /\b[a-f0-9]{32}-us\d{1,2}\b/g,
    replacement: '[REDACTED:mailchimp-api-key]',
    stage: 1,
  },
  {
    id: 'postmark-server-token',
    description: 'Postmark server token (UUID-shaped near "postmark")',
    pattern:
      /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b(?=.{0,40}postmark)/gi,
    replacement: '[REDACTED:postmark-server-token]',
    stage: 1,
  },
];
