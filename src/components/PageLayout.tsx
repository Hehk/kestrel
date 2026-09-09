import * as stylex from "@stylexjs/stylex";
import type { JSX, ParentProps } from "solid-js";

import { media } from "../styles/media.stylex";
import { layout } from "../styles/layout.stylex";

const mobile = media.mobile;

const styles = stylex.create({
  page: {
    width: {
      default: `min(${layout.readingColumn}, calc(100vw - 2 * ${layout.pageGutter}))`,
      [mobile]: `min(100% - 2 * ${layout.pageGutter}, ${layout.readingColumn})`,
    },
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

export const PageLayout = (props: ParentProps<{ header?: JSX.Element }>) => (
  <div {...stylex.attrs(styles.page)}>
    {props.header}
    <section {...stylex.attrs(styles.content)}>{props.children}</section>
  </div>
);
