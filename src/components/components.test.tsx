import * as stylex from "@stylexjs/stylex";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Anchor } from "./Anchor";
import { Button } from "./Button";
import { PageLayout } from "./PageLayout";
import { SiteHeader } from "./SiteHeader";
import { tokens } from "../styles/tokens.stylex";

const styles = stylex.create({
  buttonColor: { color: tokens.text },
  linkColor: { color: { default: tokens.link, ":visited": tokens.linkVisited } },
  override: { color: { default: "red", ":visited": "red" } },
  spacing: (padding: number) => ({ paddingLeft: padding }),
});

afterEach(cleanup);

describe("Button", () => {
  it("defaults to a non-submitting button and supports explicit submit buttons", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onAction = vi.fn();
    render(() => (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Button onClick={onAction}>Action</Button>
        <Button type="submit" name="action" value="save">
          Save
        </Button>
      </form>
    ));

    const action = screen.getByRole("button", { name: "Action" });
    expect(action).toHaveAttribute("type", "button");
    await user.click(action);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("name", "action");
    expect(save).toHaveAttribute("value", "save");
    await user.click(save);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("forwards refs, bound handlers, and reactive native props", async () => {
    const user = userEvent.setup();
    const [busy, setBusy] = createSignal(false);
    const onClick = vi.fn();
    let ref: HTMLButtonElement | undefined;
    render(() => (
      <Button
        ref={(element) => {
          ref = element;
        }}
        aria-busy={busy()}
        data-state={busy() ? "busy" : "idle"}
        disabled={busy()}
        onClick={[onClick, "sync"]}
      >
        {busy() ? "Syncing" : "Sync"}
      </Button>
    ));

    const button = screen.getByRole("button", { name: "Sync" });
    expect(ref).toBe(button);
    await user.click(button);
    expect(onClick).toHaveBeenCalledWith("sync", expect.any(MouseEvent));

    setBusy(true);
    expect(button).toHaveTextContent("Syncing");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-state", "busy");
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("Anchor", () => {
  it("preserves native link attributes, refs, and click behavior", async () => {
    const user = userEvent.setup();
    const [href, setHref] = createSignal("/first");
    const onClick = vi.fn();
    let ref: HTMLAnchorElement | undefined;
    render(() => (
      <Anchor
        href={href()}
        ref={(element) => {
          ref = element;
        }}
        target="_blank"
        rel="noreferrer"
        download="patch.diff"
        onClick={(event) => {
          event.preventDefault();
          onClick(event.currentTarget);
        }}
      >
        Download
      </Anchor>
    ));

    const anchor = screen.getByRole("link", { name: "Download" });
    expect(ref).toBe(anchor);
    expect(anchor).toHaveAttribute("href", "/first");
    expect(anchor).toHaveAttribute("target", "_blank");
    expect(anchor).toHaveAttribute("rel", "noreferrer");
    expect(anchor).toHaveAttribute("download", "patch.diff");
    setHref("/second");
    expect(anchor).toHaveAttribute("href", "/second");
    await user.click(anchor);
    expect(onClick).toHaveBeenCalledWith(anchor);
  });
});

describe("shared presentation", () => {
  it("composes reactive StyleX overrides instead of retaining conflicting base classes", () => {
    const [override, setOverride] = createSignal(false);
    render(() => (
      <>
        <Button class="integration" xstyle={override() && styles.override}>
          Button
        </Button>
        <Anchor class="integration" href="/" xstyle={override() && styles.override}>
          Anchor
        </Anchor>
      </>
    ));
    const button = screen.getByRole("button");
    const anchor = screen.getByRole("link");
    const buttonClass = button.className;
    const anchorClass = anchor.className;

    setOverride(true);
    for (const element of [button, anchor]) {
      expect(element).toHaveClass("integration");
      expect(element).toHaveClass(stylex.attrs(styles.override).class!);
      expect(element).not.toHaveAttribute("xstyle");
    }
    expect(button).not.toHaveClass(stylex.attrs(styles.buttonColor).class!);
    for (const className of stylex.attrs(styles.linkColor).class!.split(" ")) {
      expect(anchor).not.toHaveClass(className);
    }

    setOverride(false);
    expect(button.className).toBe(buttonClass);
    expect(anchor.className).toBe(anchorClass);
  });

  it("forwards dynamic StyleX variables and style arrays", () => {
    const [padding, setPadding] = createSignal(4);
    render(() => (
      <>
        <Button xstyle={[styles.override, styles.spacing(padding())]}>Button</Button>
        <Anchor href="/" xstyle={[styles.override, styles.spacing(padding())]}>
          Anchor
        </Anchor>
      </>
    ));
    for (const value of [4, 12]) {
      setPadding(value);
      for (const element of [screen.getByRole("button"), screen.getByRole("link")]) {
        expect(element).toHaveStyle(stylex.attrs(styles.spacing(value)).style!);
      }
    }
  });

  it("renders the shared page and header without adding nested main landmarks", () => {
    render(() => (
      <main>
        <PageLayout
          header={
            <SiteHeader>
              <Anchor variant="navigation" href="/">
                Home
              </Anchor>
            </SiteHeader>
          }
        >
          <h1>Repositories</h1>
        </PageLayout>
      </main>
    ));

    expect(screen.getAllByRole("main")).toHaveLength(1);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("heading", { name: "Repositories" })).toBeInTheDocument();
    expect(screen.getByText("Kestrel")).toBeInTheDocument();
  });
});
