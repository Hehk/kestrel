import * as stylex from "@stylexjs/stylex";
import { tokens } from "./tokens.stylex";

const light = stylex.createTheme(tokens, {
  text: "#1d1a16",
  textMuted: "#625a50",
  background: "#fffdf7",
  border: "#9c9388",
  rule: "#d8d1c7",
  codeBackground: "#f4efe5",
  link: "#0645ad",
  linkVisited: "#5a2a8a",
  buttonFace: "#efede7",
  buttonBorderLight: "#ffffff",
  buttonBorderDark: "#6b6258",
  statusSuccess: "#2f6f3e",
  statusFailure: "#9f352d",
  statusPending: "#7a5919",
  statusNeutral: "#625a50",
  colorScheme: "light",
});

const dark = stylex.createTheme(tokens, {
  text: "#eee7dd",
  textMuted: "#bbb0a2",
  background: "#16130f",
  border: "#7e7365",
  rule: "#403a32",
  codeBackground: "#242019",
  link: "#8ab4f8",
  linkVisited: "#c58af9",
  buttonFace: "#2b261f",
  buttonBorderLight: "#6a5f52",
  buttonBorderDark: "#080706",
  statusSuccess: "#65b979",
  statusFailure: "#df7b70",
  statusPending: "#d3ad5c",
  statusNeutral: "#bbb0a2",
  colorScheme: "dark",
});

export const lightClasses = stylex.attrs(light).class!.split(/\s+/);
export const darkClasses = stylex.attrs(dark).class!.split(/\s+/);
