import * as stylex from "@stylexjs/stylex";
import { splitProps } from "solid-js";
import type { ComponentProps } from "solid-js";
import { tokens } from "../styles/tokens.stylex";
import { styles as baseStyles } from "../styles/base";

const styles = stylex.create({
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
  small: {
    display: "inline-block",
    paddingBlock: "0.25rem",
    paddingInline: "0.55rem",
    fontFamily: tokens.mono,
    fontSize: "0.88rem",
  },
  compact: {
    minHeight: "24px",
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto",
    paddingBlock: "0.05rem",
    paddingInline: "0.4rem",
    fontFamily: tokens.mono,
    fontSize: "0.7rem",
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    cursor: { default: "pointer", ":disabled": "not-allowed", '[aria-disabled="true"]': "wait" },
    opacity: { default: 1, ":disabled": 0.55, '[aria-disabled="true"]': 0.7 },
    outlineOffset: { default: null, ":focus-visible": "-3px" },
  },
  select: {
    minWidth: "12rem",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    paddingBlock: "0.3rem",
    paddingInline: "0.55rem",
  },
  row: {
    width: "100%",
    minHeight: "1.5rem",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    paddingBlock: 0,
    paddingInline: "0.25rem",
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in srgb, ${tokens.text} 6%, transparent)`,
      "[data-popup-open]": `color-mix(in srgb, ${tokens.text} 6%, transparent)`,
    },
    borderWidth: 0,
    borderRadius: tokens.borderRadius,
    textAlign: "left",
  },
});

export type ButtonProps = Omit<ComponentProps<"button">, "class" | "classList" | "style"> & {
  size?: "compact" | "small" | "medium";
  variant?: "default" | "icon" | "select" | "row";
};

export const Button = (props: ButtonProps) => {
  const [local, buttonProps] = splitProps(props, ["size", "variant", "type"]);

  return (
    <button
      {...buttonProps}
      {...stylex.attrs(
        styles.button,
        local.size === "small" && styles.small,
        local.size === "compact" && styles.compact,
        local.variant === "icon" && baseStyles.iconControl,
        local.variant === "select" && styles.select,
        local.variant === "row" && styles.row,
      )}
      type={local.type ?? "button"}
    />
  );
};
