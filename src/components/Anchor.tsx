import * as stylex from "@stylexjs/stylex";
import { splitProps } from "solid-js";
import type { ComponentProps } from "solid-js";
import { tokens } from "../styles/tokens.stylex";
import { styles as baseStyles } from "../styles/base";

const styles = stylex.create({
  link: {
    color: { default: tokens.link, ":visited": tokens.linkVisited },
    textDecoration: "underline",
    textUnderlineOffset: "0.12em",
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
  navigation: {
    color: { default: tokens.link, ":visited": tokens.link },
  },
  current: {
    color: { default: tokens.text, ":visited": tokens.text },
    fontWeight: 700,
    textDecoration: "none",
  },
});

export type AnchorProps = Omit<ComponentProps<"a">, "class" | "classList" | "style"> & {
  size?: "small" | "medium";
  variant?: "default" | "navigation" | "icon";
};

export const Anchor = (props: AnchorProps) => {
  const [local, anchorProps] = splitProps(props, ["size", "variant"]);

  return (
    <a
      {...anchorProps}
      {...stylex.attrs(
        styles.link,
        local.size === "small" && styles.small,
        local.variant === "navigation" && styles.navigation,
        local.variant === "navigation" && props["aria-current"] === "page" && styles.current,
        local.variant === "icon" && baseStyles.iconControl,
      )}
    />
  );
};
