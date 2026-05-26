export interface KeyHandlerHandle {
  stop(): void;
}

export interface ReadableInputStream {
  isTTY: boolean;
  setRawMode?(value: boolean): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
  resume?(): void;
  pause?(): void;
}

export interface KeyHandlerDeps {
  readonly stdin: ReadableInputStream;
  readonly onQuit: () => void;
}
