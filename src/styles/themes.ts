import * as stylex from "@stylexjs/stylex";
import { tokens } from "./tokens.stylex";
import { lightPalette, darkPalette } from "./palettes.stylex";

const light = stylex.createTheme(tokens, {
  text: lightPalette.text,
  textMuted: lightPalette.textMuted,
  background: lightPalette.background,
  border: lightPalette.border,
  rule: lightPalette.rule,
  codeBackground: lightPalette.codeBackground,
  link: lightPalette.link,
  linkVisited: lightPalette.linkVisited,
  buttonFace: lightPalette.buttonFace,
  buttonBorderLight: lightPalette.buttonBorderLight,
  buttonBorderDark: lightPalette.buttonBorderDark,
  statusSuccess: lightPalette.statusSuccess,
  statusFailure: lightPalette.statusFailure,
  statusPending: lightPalette.statusPending,
  statusNeutral: lightPalette.statusNeutral,
  colorScheme: lightPalette.colorScheme,
});

const dark = stylex.createTheme(tokens, {
  text: darkPalette.text,
  textMuted: darkPalette.textMuted,
  background: darkPalette.background,
  border: darkPalette.border,
  rule: darkPalette.rule,
  codeBackground: darkPalette.codeBackground,
  link: darkPalette.link,
  linkVisited: darkPalette.linkVisited,
  buttonFace: darkPalette.buttonFace,
  buttonBorderLight: darkPalette.buttonBorderLight,
  buttonBorderDark: darkPalette.buttonBorderDark,
  statusSuccess: darkPalette.statusSuccess,
  statusFailure: darkPalette.statusFailure,
  statusPending: darkPalette.statusPending,
  statusNeutral: darkPalette.statusNeutral,
  colorScheme: darkPalette.colorScheme,
});

export const lightClasses = stylex.attrs(light).class!.split(/\s+/);
export const darkClasses = stylex.attrs(dark).class!.split(/\s+/);
