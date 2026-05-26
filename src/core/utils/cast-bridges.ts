export function asWorkerCtor<T>(MockClass: new (...args: never[]) => T): typeof Worker {
  const ctor: unknown = MockClass;
  return ctor as typeof Worker;
}

export function asMessageEvent<T>(payload: { data: T }): MessageEvent<T> {
  const event: unknown = payload;
  return event as MessageEvent<T>;
}

export function asTimerSetter(fn: (cb: () => void, ms?: number) => unknown): typeof setTimeout {
  const f: unknown = fn;
  return f as typeof setTimeout;
}

export function asTimerHandle(value: unknown): ReturnType<typeof setTimeout> {
  return value as ReturnType<typeof setTimeout>;
}
