import { nowIsoUtc } from 'core/utils';
import type {
  EventRouterDeps,
  EventRouterHandle,
  TransitionLogEntry,
} from 'services/state-machines/event-router/event-router.types.ts';

interface XStateLikeSnapshot {
  value: unknown;
  status: 'active' | 'done' | 'error' | 'stopped';
}

function isSnapshot(s: unknown): s is XStateLikeSnapshot {
  return (
    s !== null &&
    typeof s === 'object' &&
    'value' in s &&
    'status' in s &&
    typeof (s as { status: unknown }).status === 'string'
  );
}

export function startEventRouter(deps: EventRouterDeps): EventRouterHandle {
  const log = deps.logger;
  const subs: { unsubscribe(): void }[] = [];
  const lastValueByMachine = new Map<string, string>();

  for (const routed of deps.actors) {
    const initialSnapshot = routed.actor.getSnapshot();
    if (isSnapshot(initialSnapshot)) {
      lastValueByMachine.set(routed.name, JSON.stringify(initialSnapshot.value));
    }
    const sub = routed.actor.subscribe((snapshot) => {
      if (!isSnapshot(snapshot)) return;
      const key = JSON.stringify(snapshot.value);
      if (lastValueByMachine.get(routed.name) === key) return;
      lastValueByMachine.set(routed.name, key);
      const entry: TransitionLogEntry = {
        machine: routed.name,
        value: snapshot.value,
        status: snapshot.status,
        capturedAtUtc: nowIsoUtc(),
      };
      log?.info({ event: 'state_machine.transition', ...entry }, 'state machine transition');
    });
    subs.push(sub);
  }

  return {
    stop(): void {
      for (const sub of subs) sub.unsubscribe();
    },
  };
}
