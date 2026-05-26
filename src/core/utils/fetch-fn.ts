export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function asGlobalFetch(fn: FetchFn): typeof globalThis.fetch {
  const original = globalThis.fetch;
  const callable = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fn(input, init);
  return Object.assign(callable, {
    preconnect: original.preconnect.bind(original),
  });
}
