export interface TransitionConfigLike {
  readonly target?: string | undefined;
  readonly guard?: string | { readonly type?: string | undefined } | undefined;
}

export interface InvokeConfigLike {
  readonly src?: string | undefined;
  readonly onDone?: TransitionConfigLike | TransitionConfigLike[] | undefined;
  readonly onError?: TransitionConfigLike | undefined;
}

export interface StateConfigLike {
  readonly initial?: string | undefined;
  readonly type?: string | undefined;
  readonly states?: Record<string, StateConfigLike> | undefined;
  readonly on?: Record<string, TransitionConfigLike | TransitionConfigLike[]> | undefined;
  readonly invoke?: InvokeConfigLike | undefined;
  readonly always?: TransitionConfigLike | TransitionConfigLike[] | undefined;
}

export interface MachineConfigLike {
  readonly id?: string | undefined;
  readonly initial?: string | undefined;
  readonly type?: string | undefined;
  readonly states?: Record<string, StateConfigLike> | undefined;
  readonly on?: Record<string, TransitionConfigLike | TransitionConfigLike[]> | undefined;
}

export interface DiagramMachineSpec {
  readonly name: string;
  readonly config: MachineConfigLike;
}

export interface DiagramExportOutput {
  readonly diagrams: readonly { readonly name: string; readonly mermaid: string }[];
  readonly indexMarkdown: string;
}
