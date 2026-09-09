import * as stylex from "@stylexjs/stylex";
import { media } from "./media.stylex";

export const layout = stylex.defineVars({
  readingColumn: "720px",
  widePage: "1280px",
  pageGutter: { default: "16px", [media.mobile]: "12px" },
  proseWidth: "66ch",
});
