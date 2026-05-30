import { expect, test } from 'bun:test';

import {
  asWorkerCtor,
  asMessageEvent,
  asTimerSetter,
  asTimerHandle,
} from 'core/utils/cast-bridges.ts';

test('asWorkerCtor casts a class to typeof Worker', () => {
  class DummyClass {
    value = 1;
  }
  const ctor = asWorkerCtor(DummyClass);
  expect(ctor).toBe(DummyClass as unknown as typeof Worker);
});

test('asMessageEvent casts a payload to MessageEvent', () => {
  const payload = { data: 'hello' };
  const event = asMessageEvent(payload);
  expect(event.data).toBe('hello');
});

test('asTimerSetter casts a function to typeof setTimeout', () => {
  const fn = (cb: () => void) => cb();
  const setter = asTimerSetter(fn);
  expect(setter).toBe(fn as unknown as typeof setTimeout);
});

test('asTimerHandle casts a value to ReturnType<typeof setTimeout>', () => {
  const value = 42;
  const handle = asTimerHandle(value);
  expect(handle).toBe(42 as unknown as ReturnType<typeof setTimeout>);
});
