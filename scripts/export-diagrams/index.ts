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
import type {
  DiagramExportOutput,
  DiagramMachineSpec,
  MachineConfigLike,
} from 'scripts/export-diagrams/export-diagrams.types.ts';
import { renderMermaid } from 'scripts/export-diagrams/render-mermaid.ts';

interface XStateMachineLike {
  config: MachineConfigLike;
}

const MACHINES: readonly { readonly name: string; readonly machine: XStateMachineLike }[] = [
  { name: 'daemon-root', machine: daemonRootMachine as unknown as XStateMachineLike },
  { name: 'sentinel-registry', machine: sentinelRegistryMachine as unknown as XStateMachineLike },
  { name: 'capture-loop', machine: captureLoopMachine as unknown as XStateMachineLike },
  { name: 'drain-loop', machine: drainLoopMachine as unknown as XStateMachineLike },
  { name: 'heartbeat-loop', machine: heartbeatLoopMachine as unknown as XStateMachineLike },
  { name: 'binary-freshness', machine: binaryFreshnessMachine as unknown as XStateMachineLike },
  { name: 'auto-upgrade', machine: autoUpgradeMachine as unknown as XStateMachineLike },
  { name: 'source-poll', machine: sourcePollMachine as unknown as XStateMachineLike },
  { name: 'cursor-lifecycle', machine: cursorLifecycleMachine as unknown as XStateMachineLike },
  { name: 'batch-lifecycle', machine: batchLifecycleMachine as unknown as XStateMachineLike },
  {
    name: 'quarantine-lifecycle',
    machine: quarantineLifecycleMachine as unknown as XStateMachineLike,
  },
  { name: 'pacer', machine: pacerMachine as unknown as XStateMachineLike },
  { name: 'worker', machine: workerMachine as unknown as XStateMachineLike },
  { name: 'service-manager', machine: serviceManagerMachine as unknown as XStateMachineLike },
  { name: 'setup', machine: setupMachine as unknown as XStateMachineLike },
  { name: 'uninstall', machine: uninstallMachine as unknown as XStateMachineLike },
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

async function main(): Promise<void> {
  const outDir = join(process.cwd(), 'docs', 'architecture', 'diagrams');
  await mkdir(outDir, { recursive: true });
  const specs: DiagramMachineSpec[] = MACHINES.map((m) => ({
    name: m.name,
    config: m.machine.config,
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
