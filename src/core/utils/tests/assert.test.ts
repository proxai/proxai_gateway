import { expect, test } from 'bun:test';
import {
  errnoCode,
  isErrnoException,
  isRecord,
  requireDefined,
  requireNumber,
  requireRecord,
  requireString,
} from 'core/utils/assert.ts';

test('requireDefined returns the value when defined', () => {
  expect(requireDefined(42)).toBe(42);
  expect(requireDefined('hello')).toBe('hello');
  expect(requireDefined(false)).toBe(false);
  expect(requireDefined(0)).toBe(0);
  expect(requireDefined('')).toBe('');
});

test('requireDefined throws on null with the given context label', () => {
  expect(() => requireDefined(null, 'name')).toThrow(/name was null/);
});

test('requireDefined throws on undefined with the given context label', () => {
  expect(() => requireDefined(undefined, 'id')).toThrow(/id was undefined/);
});

test('requireDefined defaults the context to "value"', () => {
  expect(() => requireDefined(null)).toThrow(/value was null/);
});

test('requireString returns the value when it is a string', () => {
  expect(requireString('x')).toBe('x');
});

test('requireString throws when value is not a string', () => {
  expect(() => requireString(42, 'name')).toThrow(/name was not a string/);
  expect(() => requireString(null, 'name')).toThrow(/null/);
  expect(() => requireString([], 'arr')).toThrow(/array/);
});

test('requireNumber returns the value when it is a finite number', () => {
  expect(requireNumber(42)).toBe(42);
  expect(requireNumber(0)).toBe(0);
  expect(requireNumber(-3.14)).toBe(-3.14);
});

test('requireNumber throws on non-numbers and non-finite numbers', () => {
  expect(() => requireNumber('1', 'n')).toThrow(/n was not a finite number/);
  expect(() => requireNumber(Number.NaN, 'n')).toThrow(/finite/);
  expect(() => requireNumber(Number.POSITIVE_INFINITY, 'n')).toThrow(/finite/);
});

test('requireRecord returns the value when it is a plain object', () => {
  expect(requireRecord({ a: 1 })).toEqual({ a: 1 });
});

test('requireRecord throws on null, arrays, and non-object values', () => {
  expect(() => requireRecord(null, 'cfg')).toThrow(/cfg was not a plain object/);
  expect(() => requireRecord([1, 2], 'cfg')).toThrow(/array/);
  expect(() => requireRecord('s', 'cfg')).toThrow(/string/);
});

test('isErrnoException returns true for Error with a string code', () => {
  const err = Object.assign(new Error('boom'), { code: 'ENOENT' });
  expect(isErrnoException(err)).toBe(true);
});

test('isErrnoException returns false for plain Error and non-Error values', () => {
  expect(isErrnoException(new Error('plain'))).toBe(false);
  expect(isErrnoException({ code: 'EACCES' })).toBe(false);
  expect(isErrnoException(null)).toBe(false);
  expect(isErrnoException(undefined)).toBe(false);
});

test('errnoCode extracts the code from an errno exception or returns null', () => {
  const err = Object.assign(new Error('boom'), { code: 'EACCES' });
  expect(errnoCode(err)).toBe('EACCES');
  expect(errnoCode(new Error('plain'))).toBeNull();
  expect(errnoCode('not-an-error')).toBeNull();
});

test('isRecord recognises plain objects only', () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord({ a: 1 })).toBe(true);
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
  expect(isRecord('s')).toBe(false);
  expect(isRecord(undefined)).toBe(false);
});
