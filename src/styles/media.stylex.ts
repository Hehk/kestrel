import * as stylex from "@stylexjs/stylex";

export const media = stylex.defineConsts({
  mobile: "@media (max-width: 640px)",
  compactTypography: "@media (max-width: 1024px)",
  singleColumn: "@media (max-width: 1100px)",
  dark: "@media (prefers-color-scheme: dark)",
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
  coarsePointer: "@media (pointer: coarse)",
  forcedColors: "@media (forced-colors: active)",
});
