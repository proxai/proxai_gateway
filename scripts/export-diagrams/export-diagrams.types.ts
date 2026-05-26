export interface MachineConfigLike {
  readonly id?: string;
  readonly initial?: string;
  readonly type?: string;
  readonly states?: Record<string, StateConfigLike>;
  readonly on?: Record<string, TransitionConfigLike | TransitionConfigLike[]>;
}

export interface StateConfigLike {
  readonly initial?: string;
  readonly type?: string;
  readonly states?: Record<string, StateConfigLike>;
  readonly on?: Record<string, TransitionConfigLike | TransitionConfigLike[]>;
  readonly invoke?: {
    readonly src?: string;
    readonly onDone?: TransitionConfigLike | TransitionConfigLike[];
    readonly onError?: TransitionConfigLike;
  };
  readonly always?: TransitionConfigLike | TransitionConfigLike[];
}

export interface TransitionConfigLike {
  readonly target?: string;
  readonly guard?: string | { readonly type?: string };
}

export interface DiagramMachineSpec {
  readonly name: string;
  readonly config: MachineConfigLike;
}

export interface DiagramExportOutput {
  readonly diagrams: readonly { readonly name: string; readonly mermaid: string }[];
  readonly indexMarkdown: string;
}
