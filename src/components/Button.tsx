import * as stylex from "@stylexjs/stylex";
import { splitProps } from "solid-js";
import type { ComponentProps } from "solid-js";
import { tokens } from "../styles/tokens.stylex";

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
});

export type ButtonProps = ComponentProps<"button"> & { xstyle?: stylex.StyleXStyles };

export const Button = (props: ButtonProps) => {
  const [local, buttonProps] = splitProps(props, ["xstyle", "class", "type"]);
  const attributes = () => stylex.attrs(styles.button, local.xstyle);

  return (
    <button
      {...attributes()}
      {...buttonProps}
      class={[attributes().class, local.class].filter(Boolean).join(" ")}
      type={local.type ?? "button"}
    />
  );
};
