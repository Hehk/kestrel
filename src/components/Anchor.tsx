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
        baseStyles.focusable,
        local.size === "small" && baseStyles.smallControl,
        local.variant === "navigation" && styles.navigation,
        local.variant === "navigation" && props["aria-current"] === "page" && styles.current,
        local.variant === "icon" && baseStyles.iconControl,
      )}
    />
  );
};
