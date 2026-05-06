declare module 'pino-roll' {
  import type { DestinationStream } from 'pino';

  interface PinoRollLimit {
    count?: number;
    removeOtherLogFiles?: boolean;
  }

  interface PinoRollOptions {
    file: string | (() => string);
    size?: number | string;
    frequency?: number | 'daily' | 'hourly';
    extension?: string;
    symlink?: boolean;
    limit?: PinoRollLimit;
    dateFormat?: string;
    mkdir?: boolean;
    sync?: boolean;
  }

  function build(options: PinoRollOptions): Promise<DestinationStream>;

  export = build;
}
