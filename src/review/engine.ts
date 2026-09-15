import type { CommandRequest, ReviewView } from "./generated/review_wasm";

export interface Document {
  free(): void;
  command(request: CommandRequest): Document;
  importTrusted(snapshot: Uint8Array): Document;
  view(version: string): ReviewView;
  snapshot(): Uint8Array;
  version(): Uint8Array;
}
export type Engine = { create(): Document; restore(snapshot: Uint8Array): Document };
let loading: Promise<Engine> | undefined;

export const loadReviewEngine = (): Promise<Engine> =>
  (loading ??= import("./generated/review_wasm")
    .then(async ({ default: init, ReviewWorkspace }) => {
      await init();
      return { create: () => new ReviewWorkspace(), restore: ReviewWorkspace.restoreTrusted };
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));
