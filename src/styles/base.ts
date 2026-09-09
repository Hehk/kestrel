import * as stylex from "@stylexjs/stylex";
import { tokens } from "./tokens.stylex";
import { media } from "./media.stylex";
import { layout } from "./layout.stylex";

export const styles = stylex.create({
  document: {
    color: tokens.text,
    backgroundColor: tokens.background,
    colorScheme: tokens.colorScheme,
    fontFamily: tokens.serif,
    fontSize: { default: "18px", [media.compactTypography]: "16px" },
    lineHeight: 1.55,
    fontSynthesis: "none",
    textRendering: "optimizeLegibility",
  },
  body: {
    margin: 0,
  },
  mount: {
    width: "100%",
    maxWidth: "100%",
    minHeight: "100svh",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    marginBlock: "0",
    marginInline: "auto",
  },
  heading: {
    color: tokens.text,
    fontFamily: tokens.serif,
    fontWeight: 700,
  },
  heading1: {
    marginTop: "1.25rem",
    marginRight: "0",
    marginBottom: "0.75rem",
    marginLeft: "0",
    fontSize: { default: "2rem", [media.compactTypography]: "1.75rem" },
    lineHeight: 1.15,
  },
  heading2: {
    marginTop: "1.5rem",
    marginRight: "0",
    marginBottom: "0.5rem",
    marginLeft: "0",
    fontSize: "1.35rem",
    lineHeight: 1.2,
  },
  paragraph: {
    maxWidth: layout.proseWidth,
    marginTop: "0",
    marginRight: "0",
    marginBottom: "1rem",
    marginLeft: "0",
  },
  list: {
    marginTop: "0",
    marginRight: "0",
    marginBottom: "1rem",
    marginLeft: "0",
  },
  focusable: {
    outline: { ":focus-visible": "2px solid currentColor" },
    outlineOffset: { ":focus-visible": "3px" },
  },
  focusInset: {
    outlineOffset: { ":focus-visible": "-3px" },
  },
  smallControl: {
    display: "inline-block",
    paddingBlock: "0.25rem",
    paddingInline: "0.55rem",
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeSmall,
  },
  eyebrow: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: "0.35rem",
    marginLeft: 0,
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeMetadata,
  },
  mutedMetadata: {
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeMetadata,
  },
  statusText: {
    maxWidth: layout.proseWidth,
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    color: tokens.textMuted,
    fontSize: tokens.fontSizeStatus,
  },
  codeFont: {
    fontFamily: tokens.mono,
  },
  code: {
    paddingBlock: "0.1em",
    paddingInline: "0.3em",
    backgroundColor: tokens.codeBackground,
    fontFamily: tokens.mono,
    fontSize: "0.9em",
  },
  iconControl: {
    width: "2rem",
    height: "2rem",
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "2rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    padding: 0,
    color: { default: tokens.text, ":visited": tokens.text },
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in srgb, ${tokens.text} 6%, transparent)`,
    },
    borderWidth: 0,
    borderRadius: tokens.borderRadius,
    textDecoration: "none",
    cursor: { default: "pointer", ":disabled": "wait" },
    opacity: { default: 1, ":disabled": 0.65 },
  },
});

export const documentClass = stylex.attrs(styles.document).class!;
export const bodyClass = stylex.attrs(styles.body).class!;
export const mountClass = stylex.attrs(styles.mount).class!;
