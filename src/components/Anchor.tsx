import * as stylex from "@stylexjs/stylex";
import { splitProps } from "solid-js";
import type { ComponentProps } from "solid-js";
import { tokens } from "../styles/tokens.stylex";

const styles = stylex.create({
  link: {
    color: { default: tokens.link, ":visited": tokens.linkVisited },
    textDecoration: "underline",
    textUnderlineOffset: "0.12em",
    outline: { ":focus-visible": "2px solid currentColor" },
    outlineOffset: { ":focus-visible": "3px" },
  },
  navigation: {
    color: { default: tokens.link, ":visited": tokens.link },
  },
});

export type AnchorProps = ComponentProps<"a"> & {
  xstyle?: stylex.StyleXStyles;
  variant?: "navigation";
};

export const Anchor = (props: AnchorProps) => {
  const [local, anchorProps] = splitProps(props, ["xstyle", "class", "variant"]);
  const attributes = () =>
    stylex.attrs(styles.link, local.variant === "navigation" && styles.navigation, local.xstyle);

  return (
    <a
      {...attributes()}
      {...anchorProps}
      class={[attributes().class, local.class].filter(Boolean).join(" ")}
    />
  );
};
