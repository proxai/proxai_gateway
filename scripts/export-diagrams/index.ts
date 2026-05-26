import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { autoUpgradeMachine } from 'services/state-machines/auto-upgrade';
import { batchLifecycleMachine } from 'services/state-machines/batch-lifecycle';
import { binaryFreshnessMachine } from 'services/state-machines/binary-freshness';
import { captureLoopMachine } from 'services/state-machines/capture-loop';
import { cursorLifecycleMachine } from 'services/state-machines/cursor-lifecycle';
import { daemonRootMachine } from 'services/state-machines/daemon-root';
import { drainLoopMachine } from 'services/state-machines/drain-loop';
import { heartbeatLoopMachine } from 'services/state-machines/heartbeat-loop';
import { pacerMachine } from 'services/state-machines/pacer';
import { quarantineLifecycleMachine } from 'services/state-machines/quarantine-lifecycle';
import { sentinelRegistryMachine } from 'services/state-machines/sentinel-registry';
import { serviceManagerMachine } from 'services/state-machines/service-manager';
import { setupMachine } from 'services/state-machines/setup';
import { sourcePollMachine } from 'services/state-machines/source-poll';
import { uninstallMachine } from 'services/state-machines/uninstall';
import { workerMachine } from 'services/state-machines/worker';
import type { AnyStateMachine } from 'xstate';
import type {
  DiagramExportOutput,
  DiagramMachineSpec,
  MachineConfigLike,
} from 'scripts/export-diagrams/export-diagrams.types.ts';
import { renderMermaid } from 'scripts/export-diagrams/render-mermaid.ts';

interface NamedMachine {
  readonly name: string;
  readonly machine: AnyStateMachine;
}

const MACHINES: readonly NamedMachine[] = [
  { name: 'daemon-root', machine: daemonRootMachine },
  { name: 'sentinel-registry', machine: sentinelRegistryMachine },
  { name: 'capture-loop', machine: captureLoopMachine },
  { name: 'drain-loop', machine: drainLoopMachine },
  { name: 'heartbeat-loop', machine: heartbeatLoopMachine },
  { name: 'binary-freshness', machine: binaryFreshnessMachine },
  { name: 'auto-upgrade', machine: autoUpgradeMachine },
  { name: 'source-poll', machine: sourcePollMachine },
  { name: 'cursor-lifecycle', machine: cursorLifecycleMachine },
  { name: 'batch-lifecycle', machine: batchLifecycleMachine },
  { name: 'quarantine-lifecycle', machine: quarantineLifecycleMachine },
  { name: 'pacer', machine: pacerMachine },
  { name: 'worker', machine: workerMachine },
  { name: 'service-manager', machine: serviceManagerMachine },
  { name: 'setup', machine: setupMachine },
  { name: 'uninstall', machine: uninstallMachine },
];

export function buildDiagramExport(specs: readonly DiagramMachineSpec[]): DiagramExportOutput {
  const diagrams = specs.map((s) => ({ name: s.name, mermaid: renderMermaid(s.name, s.config) }));
  const indexMarkdown = buildIndex(diagrams.map((d) => d.name));
  return { diagrams, indexMarkdown };
}

function buildIndex(names: readonly string[]): string {
  const lines: string[] = ['# State machines', ''];
  for (const name of names) {
    lines.push(`- [${name}](./${name}.md)`);
  }
  return lines.join('\n') + '\n';
}

function configOf(machine: AnyStateMachine): MachineConfigLike {
  const value: unknown = machine.config;
  return value as MachineConfigLike;
}

async function main(): Promise<void> {
  const outDir = join(process.cwd(), 'docs', 'architecture', 'diagrams');
  await mkdir(outDir, { recursive: true });
  const specs: DiagramMachineSpec[] = MACHINES.map((m) => ({
    name: m.name,
    config: configOf(m.machine),
  }));
  const out = buildDiagramExport(specs);
  await Promise.all(
    out.diagrams.map((d) =>
      writeFile(
        join(outDir, `${d.name}.md`),
        `# ${d.name}\n\n\`\`\`mermaid\n${d.mermaid}\n\`\`\`\n`,
      ),
    ),
  );
  await writeFile(join(outDir, 'README.md'), out.indexMarkdown);
  console.log(`Wrote ${out.diagrams.length.toString()} diagrams to ${outDir}`);
}

if (import.meta.main) {
  await main();
}
