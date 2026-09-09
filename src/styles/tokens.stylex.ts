import * as stylex from "@stylexjs/stylex";

import { media } from "./media.stylex";

const dark = media.dark;

export const tokens = stylex.defineVars({
  text: { default: "#1d1a16", [dark]: "#eee7dd" },
  textMuted: { default: "#625a50", [dark]: "#bbb0a2" },
  background: { default: "#fffdf7", [dark]: "#16130f" },
  border: { default: "#9c9388", [dark]: "#7e7365" },
  rule: { default: "#d8d1c7", [dark]: "#403a32" },
  codeBackground: { default: "#f4efe5", [dark]: "#242019" },
  link: { default: "#0645ad", [dark]: "#8ab4f8" },
  linkVisited: { default: "#5a2a8a", [dark]: "#c58af9" },
  buttonFace: { default: "#efede7", [dark]: "#2b261f" },
  buttonBorderLight: { default: "#ffffff", [dark]: "#6a5f52" },
  buttonBorderDark: { default: "#6b6258", [dark]: "#080706" },
  statusSuccess: { default: "#2f6f3e", [dark]: "#65b979" },
  statusFailure: { default: "#9f352d", [dark]: "#df7b70" },
  statusPending: { default: "#7a5919", [dark]: "#d3ad5c" },
  statusNeutral: { default: "#625a50", [dark]: "#bbb0a2" },
  colorScheme: { default: "light", [dark]: "dark" },
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: "ui-monospace, Consolas, monospace",
  fontSizeMedium: "1rem",
  fontSizeSmall: "0.875rem",
  fontSizeExtraSmall: "0.75rem",
  borderRadius: "2px",
});
