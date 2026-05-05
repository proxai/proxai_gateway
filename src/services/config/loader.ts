import { parse as parseToml } from 'smol-toml';

import { configFilePath } from 'core/io/fs';
import { ValidationError } from 'core/utils';
import { validateAndCoerce } from 'services/config/validate.ts';
import type { GatewayConfig } from 'services/config/config.types.ts';

export async function loadConfigFromFile(path?: string): Promise<GatewayConfig> {
  const filePath = path ?? configFilePath();
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new ValidationError(`config file not found at ${filePath}`);
  }
  const text = await file.text();
  return loadConfigFromString(text);
}

export function loadConfigFromString(text: string): GatewayConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new ValidationError('failed to parse TOML config', err);
  }
  return validateAndCoerce(raw);
}
