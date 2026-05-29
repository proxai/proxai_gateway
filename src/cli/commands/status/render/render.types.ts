import type { StatusSnapshot } from 'cli/commands/status/status.types.ts';
import type { UnifiedStatusSummary } from 'cli/commands/status/unified-summary.types.ts';

export interface RenderInputs {
  readonly summary: UnifiedStatusSummary;
  readonly snapshot: StatusSnapshot | null;
  readonly notConfigured: boolean;
  readonly isDevMode: boolean;
  readonly isLocalBuild: boolean;
  readonly binaryPath: string | null;
  readonly nowLocal: Date;
  readonly version: string | null;
  readonly compact?: boolean;
  readonly secondProfile?: RenderInputs;
}
