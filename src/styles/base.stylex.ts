import * as stylex from "@stylexjs/stylex";
import { tokens } from "./tokens.stylex";

export const styles = stylex.create({
  document: {
    color: tokens.text,
    backgroundColor: tokens.background,
    colorScheme: tokens.colorScheme,
    fontFamily: tokens.serif,
    fontSize: { default: "18px", "@media (max-width: 1024px)": "16px" },
    lineHeight: 1.55,
    fontSynthesis: "none",
    textRendering: "optimizeLegibility",
  },
  mount: {
    width: "100%",
    maxWidth: "100%",
    minHeight: "100svh",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    margin: "0 auto",
  },
  heading: {
    color: tokens.text,
    fontFamily: tokens.serif,
    fontWeight: 700,
  },
  heading1: {
    margin: "1.25rem 0 0.75rem",
    fontSize: { default: "2rem", "@media (max-width: 1024px)": "1.75rem" },
    lineHeight: 1.15,
  },
  heading2: {
    margin: "1.5rem 0 0.5rem",
    fontSize: "1.35rem",
    lineHeight: 1.2,
  },
  paragraph: {
    maxWidth: "66ch",
    margin: "0 0 1rem",
  },
  list: {
    margin: "0 0 1rem",
  },
  link: {
    color: { default: tokens.link, ":visited": tokens.linkVisited },
    textDecoration: "underline",
    textUnderlineOffset: "0.12em",
    outline: { ":focus-visible": "2px solid currentColor" },
    outlineOffset: { ":focus-visible": "3px" },
  },
  focusable: {
    outline: { ":focus-visible": "2px solid currentColor" },
    outlineOffset: { ":focus-visible": "3px" },
  },
  codeFont: {
    fontFamily: tokens.mono,
  },
  code: {
    padding: "0.1em 0.3em",
    backgroundColor: tokens.codeBackground,
    fontFamily: tokens.mono,
    fontSize: "0.9em",
  },
  button: {
    color: tokens.text,
    backgroundColor: tokens.buttonFace,
    borderTopColor: { default: tokens.buttonBorderLight, ":active": tokens.buttonBorderDark },
    borderRightColor: { default: tokens.buttonBorderDark, ":active": tokens.buttonBorderLight },
    borderBottomColor: { default: tokens.buttonBorderDark, ":active": tokens.buttonBorderLight },
    borderLeftColor: { default: tokens.buttonBorderLight, ":active": tokens.buttonBorderDark },
    borderStyle: "solid",
    borderWidth: "2px",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
    lineHeight: "inherit",
    outline: { ":focus-visible": "2px solid currentColor" },
    outlineOffset: { ":focus-visible": "3px" },
  },
  input: {
    outline: { ":focus-visible": "2px solid currentColor" },
    outlineOffset: { ":focus-visible": "3px" },
  },
});

export const documentClass = stylex.attrs(styles.document).class!;
export const mountClass = stylex.attrs(styles.mount).class!;
