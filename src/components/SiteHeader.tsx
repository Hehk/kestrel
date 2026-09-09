import * as stylex from "@stylexjs/stylex";
import type { ParentProps } from "solid-js";
import { styles as baseStyles } from "../styles/base";
import { tokens } from "../styles/tokens.stylex";

const styles = stylex.create({
  header: {
    marginBottom: "2rem",
    paddingBottom: "1rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
  },
  title: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: "0.5rem",
    marginLeft: 0,
    fontSize: "1.15rem",
    fontWeight: 700,
  },
  nav: {
    display: "flex",
    flexWrap: "wrap",
    rowGap: "0.35rem",
    columnGap: "0.5rem",
    fontSize: "0.95rem",
  },
});

export const SiteHeader = (props: ParentProps) => (
  <header {...stylex.attrs(styles.header)}>
    <p {...stylex.attrs(baseStyles.paragraph, styles.title)}>Kestrel</p>
    <nav {...stylex.attrs(styles.nav)} aria-label="Primary">
      {props.children}
    </nav>
  </header>
);
