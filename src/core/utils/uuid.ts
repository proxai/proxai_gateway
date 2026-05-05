import { v7 as uuidv7, validate, version } from 'uuid';

export function generateUuidV7(): string {
  return uuidv7();
}

export function isUuidV7(value: string): boolean {
  return validate(value) && version(value) === 7;
}
