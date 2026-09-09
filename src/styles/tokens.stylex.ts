import * as stylex from "@stylexjs/stylex";
import { media } from "./media.stylex";
import { lightPalette, darkPalette } from "./palettes.stylex";

export const tokens = stylex.defineVars({
  text: { default: lightPalette.text, [media.dark]: darkPalette.text },
  textMuted: { default: lightPalette.textMuted, [media.dark]: darkPalette.textMuted },
  background: { default: lightPalette.background, [media.dark]: darkPalette.background },
  border: { default: lightPalette.border, [media.dark]: darkPalette.border },
  rule: { default: lightPalette.rule, [media.dark]: darkPalette.rule },
  codeBackground: {
    default: lightPalette.codeBackground,
    [media.dark]: darkPalette.codeBackground,
  },
  link: { default: lightPalette.link, [media.dark]: darkPalette.link },
  linkVisited: { default: lightPalette.linkVisited, [media.dark]: darkPalette.linkVisited },
  buttonFace: { default: lightPalette.buttonFace, [media.dark]: darkPalette.buttonFace },
  buttonBorderLight: {
    default: lightPalette.buttonBorderLight,
    [media.dark]: darkPalette.buttonBorderLight,
  },
  buttonBorderDark: {
    default: lightPalette.buttonBorderDark,
    [media.dark]: darkPalette.buttonBorderDark,
  },
  statusSuccess: { default: lightPalette.statusSuccess, [media.dark]: darkPalette.statusSuccess },
  statusFailure: { default: lightPalette.statusFailure, [media.dark]: darkPalette.statusFailure },
  statusPending: { default: lightPalette.statusPending, [media.dark]: darkPalette.statusPending },
  statusNeutral: { default: lightPalette.statusNeutral, [media.dark]: darkPalette.statusNeutral },
  colorScheme: { default: lightPalette.colorScheme, [media.dark]: darkPalette.colorScheme },
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: "ui-monospace, Consolas, monospace",
  fontSizeMedium: "1rem",
  fontSizeSmall: "0.875rem",
  fontSizeExtraSmall: "0.75rem",
  fontSizeMetadata: "0.78rem",
  fontSizeStatus: "0.92rem",
  borderRadius: "2px",
});
