import { parse as parseToml } from 'smol-toml';

import { ValidationError } from 'core/utils';
import { validateAndCoerce } from 'services/config/validate.ts';
import type { ValidateDefaults } from 'services/config/validate.ts';
import type { GatewayConfig } from 'services/config/config.types.ts';

export async function loadConfigFromFile(
  path: string,
  defaults?: ValidateDefaults,
): Promise<GatewayConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ValidationError(`config file not found at ${path}`);
  }
  const text = await file.text();
  return loadConfigFromString(text, defaults);
}

export function loadConfigFromString(text: string, defaults?: ValidateDefaults): GatewayConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new ValidationError('failed to parse TOML config', err);
  }
  return validateAndCoerce(raw, defaults);
}
