import * as stylex from "@stylexjs/stylex";

export const DIFF_ROW_HEIGHT = stylex.defineConsts({
  file: 40,
  hunk: 32,
  notice: 32,
  source: 24,
});

export const metrics = stylex.defineConsts({
  fontSize: "0.85rem",
  tabSize: 4,
  gutter: "4.5rem",
  mobileGutter: "3rem",
});
