import * as stylex from "@stylexjs/stylex";
import type { JSX, ParentProps } from "solid-js";

import { media } from "../styles/media.stylex";

const mobile = media.mobile;

const styles = stylex.create({
  page: {
    width: { default: "min(720px, calc(100vw - 32px))", [mobile]: "min(100% - 24px, 720px)" },
    marginBlock: 0,
    marginInline: "auto",
    paddingTop: { default: "40px", [mobile]: "24px" },
    paddingInline: 0,
    paddingBottom: { default: "64px", [mobile]: "48px" },
  },
  content: {
    textAlign: "left",
  },
});

export const PageLayout = (props: ParentProps<{ header: JSX.Element }>) => (
  <div {...stylex.attrs(styles.page)}>
    {props.header}
    <section {...stylex.attrs(styles.content)}>{props.children}</section>
  </div>
);
