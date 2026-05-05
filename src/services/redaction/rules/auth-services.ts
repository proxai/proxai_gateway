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
  {
    id: 'okta-api-token',
    description: 'Okta API token using SSWS scheme',
    pattern: /\bSSWS\s+[A-Za-z0-9_-]{40,}\b/g,
    replacement: '[REDACTED:okta-api-token]',
    stage: 1,
  },
  {
    id: 'auth0-api-token',
    description: 'Auth0 API token (Bearer in *.auth0.com Management API context)',
    pattern:
      /(AUTH0[_-]?(?:MGMT[_-]?)?(?:API[_-]?)?TOKEN\s*[:=]\s*)["']?[A-Za-z0-9._-]{60,}["']?/gi,
    replacement: '$1[REDACTED:auth0-api-token]',
    stage: 2,
  },
  {
    id: 'authy-api-key',
    description: 'Authy API key (32-char alnum after AUTHY keyword)',
    pattern: /(AUTHY[_-]?API[_-]?KEY\s*[:=]\s*)["']?[A-Za-z0-9]{32}["']?/gi,
    replacement: '$1[REDACTED:authy-api-key]',
    stage: 2,
  },
  {
    id: 'mailjet-api-key',
    description: 'Mailjet API key value following MJ_APIKEY keyword',
    pattern: /(MJ[_-]?APIKEY[_-]?(?:PUBLIC|PRIVATE)\s*[:=]\s*)["']?[a-f0-9]{32}["']?/gi,
    replacement: '$1[REDACTED:mailjet-api-key]',
    stage: 2,
  },
  {
    id: 'sendinblue-brevo-api-key',
    description: 'Sendinblue / Brevo API key (xkeysib-)',
    pattern: /\bxkeysib-[a-f0-9]{64}-[A-Za-z0-9]{16}\b/g,
    replacement: '[REDACTED:sendinblue-brevo-api-key]',
    stage: 1,
  },
  {
    id: 'sendinblue-smtp-key',
    description: 'Sendinblue SMTP key (xsmtpsib-)',
    pattern: /\bxsmtpsib-[a-f0-9]{64}-[A-Za-z0-9]{16}\b/g,
    replacement: '[REDACTED:sendinblue-smtp-key]',
    stage: 1,
  },
  {
    id: 'frontegg-api-token',
    description: 'Frontegg API token (UUID after FRONTEGG keyword)',
    pattern:
      /(FRONTEGG[_-]?(?:CLIENT[_-]?)?(?:ID|SECRET|TOKEN)\s*[:=]\s*)["']?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}["']?/gi,
    replacement: '$1[REDACTED:frontegg-api-token]',
    stage: 2,
  },
  {
    id: 'mailersend-api-token',
    description: 'MailerSend API token (mlsn.)',
    pattern: /\bmlsn\.[a-f0-9]{64}\b/g,
    replacement: '[REDACTED:mailersend-api-token]',
    stage: 1,
  },
];
