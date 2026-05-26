import type {
  MachineConfigLike,
  StateConfigLike,
  TransitionConfigLike,
} from 'scripts/export-diagrams/export-diagrams.types.ts';

export function renderMermaid(machineName: string, config: MachineConfigLike): string {
  const lines: string[] = ['stateDiagram-v2'];
  const initial = config.initial;
  if (initial !== undefined) {
    lines.push(`  [*] --> ${initial}`);
  }
  const states = config.states ?? {};
  for (const [stateName, stateConfig] of Object.entries(states)) {
    appendStateLines(lines, stateName, stateConfig);
  }
  if (config.on !== undefined) {
    for (const [eventName, transitions] of Object.entries(config.on)) {
      const list = Array.isArray(transitions) ? transitions : [transitions];
      for (const t of list) {
        if (t.target !== undefined) {
          lines.push(`  [*] --> ${t.target}: ${eventName}`);
        }
      }
    }
  }
  return [`%% ${machineName}`, ...lines].join('\n');
}

function appendStateLines(lines: string[], stateName: string, state: StateConfigLike): void {
  if (state.type === 'final') {
    lines.push(`  ${stateName} --> [*]`);
  }
  emitTransitions(lines, stateName, state.on);
  if (state.always !== undefined) {
    const list = Array.isArray(state.always) ? state.always : [state.always];
    for (const t of list) {
      if (t.target !== undefined) {
        lines.push(`  ${stateName} --> ${t.target}: always${guardLabel(t)}`);
      }
    }
  }
  if (state.invoke?.onDone !== undefined) {
    const list = Array.isArray(state.invoke.onDone) ? state.invoke.onDone : [state.invoke.onDone];
    for (const t of list) {
      if (t.target !== undefined) {
        lines.push(`  ${stateName} --> ${t.target}: onDone${guardLabel(t)}`);
      }
    }
  }
  if (state.invoke?.onError !== undefined) {
    const t = state.invoke.onError;
    if (t.target !== undefined) {
      lines.push(`  ${stateName} --> ${t.target}: onError`);
    }
  }
  const childStates = state.states ?? {};
  if (Object.keys(childStates).length > 0) {
    lines.push(`  state ${stateName} {`);
    if (state.initial !== undefined) {
      lines.push(`    [*] --> ${state.initial}`);
    }
    for (const [childName, childConfig] of Object.entries(childStates)) {
      appendChildStateLines(lines, childName, childConfig);
    }
    lines.push('  }');
  }
}

function appendChildStateLines(lines: string[], stateName: string, state: StateConfigLike): void {
  if (state.type === 'final') {
    lines.push(`    ${stateName} --> [*]`);
  }
  emitTransitions(lines, stateName, state.on, '    ');
  if (state.always !== undefined) {
    const list = Array.isArray(state.always) ? state.always : [state.always];
    for (const t of list) {
      if (t.target !== undefined) {
        lines.push(`    ${stateName} --> ${t.target}: always${guardLabel(t)}`);
      }
    }
  }
}

function emitTransitions(
  lines: string[],
  stateName: string,
  on: Record<string, TransitionConfigLike | TransitionConfigLike[]> | undefined,
  indent = '  ',
): void {
  if (on === undefined) return;
  for (const [eventName, transitions] of Object.entries(on)) {
    const list = Array.isArray(transitions) ? transitions : [transitions];
    for (const t of list) {
      if (t.target !== undefined) {
        lines.push(`${indent}${stateName} --> ${t.target}: ${eventName}${guardLabel(t)}`);
      }
    }
  }
}

function guardLabel(t: TransitionConfigLike): string {
  if (t.guard === undefined) return '';
  if (typeof t.guard === 'string') return ` [${t.guard}]`;
  if (t.guard.type !== undefined) return ` [${t.guard.type}]`;
  return ' [guarded]';
}
