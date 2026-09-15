/* tslint:disable */
/* eslint-disable */
/**
 * Supplied by the authenticated service, never inferred from a document or command.
 */
export type Actor = { kind: "human" } | { kind: "agent"; agent: string; run: string };

export interface Assessment {
  id: string;
  target: Target;
  agent: string;
  run: string;
  stream: string;
  importance: AssessmentValue;
  evidence: string[];
  supersedes: string | null;
}

export interface CommandRequest {
  command: Command;
  actor: Actor;
  /**
   * The caller must verify this target against its immutable snapshot manifest.
   */
  displayed: Target;
}

export interface Context {
  id: string;
  target: Target;
  agent: string;
  run: string;
  text: string;
}

export interface ReviewView {
  reviewed: boolean;
  collapsed: boolean;
  human_importance: Importance;
  effective_importance: AssessmentValue | null;
  assessments: Assessment[];
  context: Context[];
}

export interface Target {
  snapshot: string;
  version: string;
}

export type AssessmentValue = "important" | "unimportant";

export type Command =
  | { kind: "review"; target: Target; reviewed: boolean }
  | { kind: "reassertReview"; target: Target; reviewed: boolean }
  | { kind: "collapse"; target: Target; collapsed: boolean }
  | { kind: "setImportance"; target: Target; importance: Importance }
  | { kind: "assess"; assessment: Assessment }
  | { kind: "addContext"; context: Context };

export type Importance = "important" | "unimportant" | "inherit";

/**
 * Local review domain boundary. No network or storage side effects.
 */
export class ReviewWorkspace {
  free(): void;
  [Symbol.dispose](): void;
  command(request: CommandRequest): ReviewWorkspace;
  covers(version: Uint8Array): boolean;
  importTrusted(update: Uint8Array): ReviewWorkspace;
  constructor();
  peerId(): string;
  static restoreTrusted(snapshot: Uint8Array): ReviewWorkspace;
  snapshot(): Uint8Array;
  updatesSince(version: Uint8Array): Uint8Array;
  version(): Uint8Array;
  view(version: string, stream?: string | null): ReviewView;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_reviewworkspace_free: (a: number, b: number) => void;
  readonly reviewworkspace_command: (a: number, b: any) => [number, number, number];
  readonly reviewworkspace_covers: (a: number, b: number, c: number) => [number, number, number];
  readonly reviewworkspace_importTrusted: (
    a: number,
    b: number,
    c: number,
  ) => [number, number, number];
  readonly reviewworkspace_new: () => [number, number, number];
  readonly reviewworkspace_peerId: (a: number) => [number, number];
  readonly reviewworkspace_restoreTrusted: (a: number, b: number) => [number, number, number];
  readonly reviewworkspace_snapshot: (a: number) => [number, number, number, number];
  readonly reviewworkspace_updatesSince: (
    a: number,
    b: number,
    c: number,
  ) => [number, number, number, number];
  readonly reviewworkspace_version: (a: number) => [number, number];
  readonly reviewworkspace_view: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => [number, number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>,
): Promise<InitOutput>;
