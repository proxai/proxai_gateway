import { GEMINI_USER_STEP_TYPE } from 'sources/gemini/gemini.constants.ts';
import { getPath, pNum, pStr, scanProto } from 'sources/gemini/proto-scan.ts';
import type { FieldTree } from 'sources/gemini/proto-scan.ts';
import type {
  GeminiRole,
  GeminiStepRow,
  GeminiTrajectoryMetadataBlobRow,
  GeminiTrajectoryMetaRow,
  NormalizedStep,
} from 'sources/gemini/gemini.types.ts';

const SYSTEM_STEP_TYPES: ReadonlySet<number> = new Set([90, 98, 101]);
const TOOL_STEP_TYPES: ReadonlySet<number> = new Set([
  5, 7, 8, 9, 17, 21, 25, 31, 33, 127, 132, 138,
]);
const ASSISTANT_STEP_TYPES: ReadonlySet<number> = new Set([15, 23]);

const NANOS_PER_MILLISECOND = 1_000_000;

export function decodeStep(stepType: number, payload: Uint8Array): NormalizedStep {
  const tree = scanProto(payload);
  const modelVal = pNum(tree, '5.9.1') ?? pNum(tree, '5.11');
  const promptTokens = pNum(tree, '5.9.2');
  const cachedTokens = pNum(tree, '5.9.5');
  return {
    stepType,
    role: roleForStep(stepType, tree),
    text: textForStep(stepType, tree),
    toolName: toolNameForStep(tree),
    toolArgsJson: toolArgsForStep(tree),
    isoTimestamp: isoFromTimestamp(tree),
    ids: {
      trajectoryId: pStr(tree, '5.20.1') ?? null,
      cascadeId: pStr(tree, '5.20.4') ?? null,
      idx: pNum(tree, '5.20.2'),
      turnGroup: pStr(tree, '5.12') ?? null,
      requestId: pStr(tree, '5.9.11') ?? null,
      sessionId: sessionIdForStep(tree),
    },
    model: modelVal !== null ? String(modelVal) : null,
    inputTokens: promptTokens !== null ? promptTokens + (cachedTokens ?? 0) : null,
    outputTokens: pNum(tree, '5.9.3'),
    cacheReadInputTokens: cachedTokens,
    cacheCreationInputTokens: pNum(tree, '5.9.10'),
  };
}

export function decodeStepRow(
  idx: number,
  stepType: number,
  status: number | null,
  payload: Uint8Array,
): GeminiStepRow {
  const step = decodeStep(stepType, payload);
  return {
    idx,
    step_type: stepType,
    status,
    role: step.role,
    text: step.text,
    tool_name: step.toolName,
    tool_args_json: step.toolArgsJson,
    iso_timestamp: step.isoTimestamp,
    turn_id: step.ids.turnGroup,
    conversation_id: step.ids.cascadeId,
    model: step.model,
    input_tokens: step.inputTokens,
    output_tokens: step.outputTokens,
    cache_read_input_tokens: step.cacheReadInputTokens,
    cache_creation_input_tokens: step.cacheCreationInputTokens,
  };
}

export interface TrajectoryMetaInput {
  idx: number;
  trajectoryId: string | null;
  cascadeId: string | null;
  trajectoryType: number | null;
  source: number | null;
}

export function decodeTrajectoryMetaRow(input: TrajectoryMetaInput): GeminiTrajectoryMetaRow {
  return {
    idx: input.idx,
    trajectory_id: input.trajectoryId,
    cascade_id: input.cascadeId,
    trajectory_type: input.trajectoryType,
    source: input.source,
  };
}

export function decodeTrajectoryMetadataBlobRow(
  idx: number,
  data: Uint8Array,
): GeminiTrajectoryMetadataBlobRow {
  const tree = scanProto(data);
  return {
    idx,
    workspace_path: pStr(tree, '1.1') ?? pStr(tree, '1.2') ?? pStr(tree, '7') ?? null,
    git_remote: pStr(tree, '1.3.2') ?? null,
  };
}

function roleForStep(stepType: number, tree: FieldTree): GeminiRole | null {
  if (stepType === GEMINI_USER_STEP_TYPE) return 'user';
  if (SYSTEM_STEP_TYPES.has(stepType)) return 'system';
  if (TOOL_STEP_TYPES.has(stepType)) return 'tool';
  if (ASSISTANT_STEP_TYPES.has(stepType)) return 'assistant';
  const discriminator = pNum(tree, '5.3');
  if (discriminator === 4) return 'user';
  if (discriminator === 2) return 'tool';
  if (discriminator === 5) return 'assistant';
  return null;
}

function textForStep(stepType: number, tree: FieldTree): string | null {
  switch (stepType) {
    case 14:
      return pStr(tree, '19.2') ?? null;
    case 15:
      return pStr(tree, '20.3') ?? null;
    case 23:
      return pStr(tree, '30.4') ?? null;
    case 90:
      return pStr(tree, '103.1') ?? null;
    case 98:
      return pStr(tree, '111.1') ?? null;
    case 101:
      return pStr(tree, '114.1') ?? pStr(tree, '114.2.2') ?? null;
    case 31:
      return pStr(tree, '40.2.6.3.2') ?? null;
    case 25:
      return pStr(tree, '34.11') ?? pStr(tree, '34.14') ?? null;
    case 132:
      return pStr(tree, '140.2.1') ?? null;
    default:
      return null;
  }
}

function toolNameForStep(tree: FieldTree): string | null {
  return pStr(tree, '5.4.2') ?? pStr(tree, '20.7.2') ?? pStr(tree, '5.4.9') ?? null;
}

function toolArgsForStep(tree: FieldTree): string | null {
  return pStr(tree, '5.4.3') ?? pStr(tree, '20.7.3') ?? null;
}

function isoFromTimestamp(tree: FieldTree): string | null {
  const seconds = getPath(tree, '5.1.1')?.varint;
  if (seconds === undefined) return null;
  const nanos = getPath(tree, '5.1.2')?.varint ?? 0n;
  const millis = Number(seconds) * 1000 + Math.floor(Number(nanos) / NANOS_PER_MILLISECOND);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function sessionIdForStep(tree: FieldTree): string | null {
  const kv = getPath(tree, '5.9.8')?.msg;
  if (kv === undefined) return null;
  const valueField = kv.get(2)?.[0];
  if (valueField === undefined) return null;
  if (valueField.str !== undefined && valueField.str.length > 0) return valueField.str;
  if (valueField.varint !== undefined) return valueField.varint.toString();
  return null;
}
