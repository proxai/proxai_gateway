import type { Logger } from 'core/log';
import type { MachineName } from 'services/state-machines/state-machines.types.ts';

export interface RoutedActor {
  readonly name: MachineName | string;
  readonly actor: {
    subscribe(observer: (snapshot: unknown) => void): { unsubscribe(): void };
    getSnapshot(): unknown;
  };
}

export interface EventRouterDeps {
  readonly actors: readonly RoutedActor[];
  readonly logger?: Logger;
}

export interface EventRouterHandle {
  stop(): void;
}

export interface TransitionLogEntry {
  readonly machine: string;
  readonly value: unknown;
  readonly status: 'active' | 'done' | 'error' | 'stopped';
  readonly capturedAtUtc: string;
}
