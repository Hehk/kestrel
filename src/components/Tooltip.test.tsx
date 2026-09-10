import * as stylex from "@stylexjs/stylex";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Tooltip } from "./Tooltip";
import type { TooltipProps } from "./Tooltip";

const styles = stylex.create({
  content: { padding: "12px", backgroundColor: "red" },
});

const Example = (props: TooltipProps & { name?: string }) => (
  <Tooltip {...props}>
    <Tooltip.Trigger>{props.name ?? "Help"}</Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content>{props.name ?? "Helpful information"}</Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip>
);

const enter = (element = screen.getByRole("button")) => fireEvent.pointerEnter(element);
const leave = (element = screen.getByRole("button")) => fireEvent.pointerLeave(element);
const keyboardFocus = (element = screen.getByRole("button")) => {
  fireEvent.keyDown(document, { key: "Tab" });
  element.focus();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Tooltip", () => {
  it("opens on hover, describes the trigger, and closes after the delay", () => {
    render(() => <Example />);
    const trigger = screen.getByRole("button");
    expect(trigger).toHaveAttribute("type", "button");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    enter();
    const content = screen.getByRole("tooltip");
    expect(content).toHaveTextContent("Helpful information");
    expect(content).toHaveAttribute("popover", "manual");
    expect(trigger).toHaveAttribute("aria-describedby", content.id);
    expect(trigger).toHaveAttribute("data-popup-open");
    expect(content.style.getPropertyValue("position-anchor")).toBe(
      trigger.style.getPropertyValue("anchor-name"),
    );

    leave();
    vi.advanceTimersByTime(149);
    expect(content).toBeInTheDocument();
    vi.advanceTimersByTime(1);
    expect(content).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute("aria-describedby");
    expect(trigger).not.toHaveAttribute("data-popup-open");
  });

  it("keeps the tooltip open while crossing the gap and hovering content", () => {
    render(() => <Example />);
    enter();
    const content = screen.getByRole("tooltip");
    leave();
    vi.advanceTimersByTime(100);
    enter(content);
    vi.advanceTimersByTime(200);
    expect(content).toBeInTheDocument();
    leave(content);
    vi.advanceTimersByTime(150);
    expect(content).not.toBeInTheDocument();
  });

  it("opens on focus and Escape dismisses without moving focus", () => {
    render(() => <Example />);
    const trigger = screen.getByRole("button");
    keyboardFocus(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    enter();
    vi.runAllTimers();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    leave();
    trigger.blur();
    trigger.focus();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    trigger.blur();
    vi.advanceTimersByTime(150);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens immediately on keyboard focus even with a hover delay", () => {
    render(() => <Example openDelay={600} />);
    keyboardFocus();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("cancels pending opens on pointer-down without reopening on pointer focus", () => {
    render(() => <Example openDelay={600} />);
    enter();
    vi.advanceTimersByTime(100);
    const trigger = screen.getByRole("button");
    fireEvent.pointerDown(trigger);
    trigger.focus();
    vi.runAllTimers();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    leave();
    enter();
    vi.advanceTimersByTime(600);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("can reopen on hover after clicking a focused trigger closed", () => {
    render(() => <Example />);
    const trigger = screen.getByRole("button");
    keyboardFocus(trigger);
    enter();
    fireEvent.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    leave();
    enter();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("dismisses on outside press but permits clicking tooltip text", () => {
    render(() => <Example />);
    enter();
    const content = screen.getByRole("tooltip");
    fireEvent.pointerDown(content);
    fireEvent.click(content);
    expect(content).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(content).not.toBeInTheDocument();
  });

  it("does not close on pointer leave while the trigger still has focus", () => {
    render(() => <Example />);
    keyboardFocus();
    enter();
    leave();
    vi.runAllTimers();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("cancels pending opens on leave and Escape, including cleanup", () => {
    const onOpenChange = vi.fn();
    const view = render(() => <Example openDelay={300} onOpenChange={onOpenChange} />);
    enter();
    vi.advanceTimersByTime(299);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    leave();
    vi.runAllTimers();
    expect(onOpenChange).not.toHaveBeenCalled();
    enter();
    fireEvent.keyDown(document, { key: "Escape" });
    vi.runAllTimers();
    expect(onOpenChange).not.toHaveBeenCalled();
    leave();
    enter();
    vi.advanceTimersByTime(300);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    leave();
    view.unmount();
    vi.runAllTimers();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("closes and cancels pending opens when its trigger unmounts", () => {
    const [mounted, setMounted] = createSignal(true);
    render(() => (
      <Tooltip openDelay={300}>
        <Show when={mounted()}>
          <Tooltip.Trigger>Help</Tooltip.Trigger>
        </Show>
        <Tooltip.Content>Details</Tooltip.Content>
      </Tooltip>
    ));
    enter();
    setMounted(false);
    vi.runAllTimers();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    setMounted(true);
    enter();
    vi.advanceTimersByTime(300);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    setMounted(false);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("ignores Escape while inactive", () => {
    render(() => <Example />);
    fireEvent.keyDown(document, { key: "Escape" });
    enter();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("supports custom triggers, refs, descriptions, and activation handlers", () => {
    const onClick = vi.fn();
    let ref: HTMLButtonElement | undefined;
    render(() => (
      <Tooltip.Root>
        <Tooltip.Trigger
          as={Button}
          ref={(node) => {
            ref = node;
          }}
          variant="icon"
          onClick={onClick}
          aria-describedby="existing"
        >
          Help
        </Tooltip.Trigger>
        <Tooltip.Content
          {...stylex.attrs(styles.content)}
          classList={{ custom: true }}
          style={{ color: "red" }}
        >
          Details
        </Tooltip.Content>
      </Tooltip.Root>
    ));
    const trigger = screen.getByRole("button");
    expect(ref).toBe(trigger);
    enter();
    const content = screen.getByRole("tooltip");
    expect(content).toHaveClass("custom");
    expect(content).toHaveClass(...(stylex.attrs(styles.content).class ?? "").split(" "));
    expect(content).toHaveStyle({ color: "rgb(255, 0, 0)" });
    expect(trigger).toHaveAttribute("aria-describedby", `existing ${content.id}`);
    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-describedby", "existing");
  });

  it("supports controlled state and reactive placement", () => {
    const [open, setOpen] = createSignal(false);
    const [placement, setPlacement] = createSignal<"top" | "right">("right");
    render(() => (
      <Example open={open()} onOpenChange={setOpen} placement={placement()} gutter={12} />
    ));
    enter();
    expect(open()).toBe(true);
    const content = screen.getByRole("tooltip");
    expect(content).toHaveAttribute("data-placement", "right");
    expect(content.style.getPropertyValue("--tooltip-gutter")).toBe("12px");
    setPlacement("top");
    expect(content).toHaveAttribute("data-placement", "top");
    setOpen(false);
    expect(content).not.toBeInTheDocument();
  });

  it("requests controlled changes without overriding the owner", () => {
    const onOpenChange = vi.fn();
    render(() => <Example open={false} onOpenChange={onOpenChange} />);
    enter();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not open disabled tooltips or disabled buttons", () => {
    const [disabled, setDisabled] = createSignal(true);
    render(() => <Example disabled={disabled()} />);
    enter();
    vi.runAllTimers();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    leave();
    setDisabled(false);
    enter();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    setDisabled(true);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    cleanup();
    render(() => (
      <Tooltip>
        <Tooltip.Trigger disabled>Disabled</Tooltip.Trigger>
        <Tooltip.Content>Details</Tooltip.Content>
      </Tooltip>
    ));
    enter();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("notifies a controlled owner when disabled and does not reopen on re-enabling", () => {
    const [open, setOpen] = createSignal(true);
    const [disabled, setDisabled] = createSignal(false);
    const onOpenChange = vi.fn(setOpen);
    render(() => <Example open={open()} onOpenChange={onOpenChange} disabled={disabled()} />);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    setDisabled(true);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(open()).toBe(false);
    setDisabled(false);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps anchor styles when caller styles change", () => {
    const [color, setColor] = createSignal("red");
    const [gutter, setGutter] = createSignal(8);
    render(() => (
      <Tooltip defaultOpen gutter={gutter()}>
        <Tooltip.Trigger style={`color:${color()}`}>Help</Tooltip.Trigger>
        <Tooltip.Content style={{ color: color() }}>Details</Tooltip.Content>
      </Tooltip>
    ));
    const trigger = screen.getByRole("button");
    const content = screen.getByRole("tooltip");
    const anchor = trigger.style.getPropertyValue("anchor-name");
    setColor("blue");
    setGutter(16);
    expect(trigger).toHaveStyle({ color: "rgb(0, 0, 255)" });
    expect(content).toHaveStyle({ color: "rgb(0, 0, 255)" });
    expect(trigger.style.getPropertyValue("anchor-name")).toBe(anchor);
    expect(content.style.getPropertyValue("position-anchor")).toBe(anchor);
    expect(content.style.getPropertyValue("--tooltip-gutter")).toBe("16px");
  });

  it("ignores touch hover", () => {
    render(() => <Example />);
    const event = new Event("pointerenter");
    Object.defineProperty(event, "pointerType", { value: "touch" });
    fireEvent(screen.getByRole("button"), event);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("uses unique anchors and IDs for each instance", () => {
    render(() => (
      <>
        <Example name="First" />
        <Example name="Second" />
      </>
    ));
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    enter(first);
    const firstId = screen.getByRole("tooltip").id;
    leave(first);
    enter(second);
    expect(screen.getByRole("tooltip").id).not.toBe(firstId);
    expect(first.style.getPropertyValue("anchor-name")).not.toBe(
      second.style.getPropertyValue("anchor-name"),
    );
  });

  it("immediately replaces tooltips during rapid hovering and cancels stale close timers", () => {
    const onOpenChange = vi.fn();
    render(() => (
      <>
        <Example name="First" onOpenChange={onOpenChange} />
        <Example name="Second" />
        <Example name="Third" />
      </>
    ));
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    const third = screen.getByRole("button", { name: "Third" });
    enter(first);
    leave(first);
    vi.advanceTimersByTime(10);
    enter(second);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second");
    expect(first).not.toHaveAttribute("aria-describedby");
    expect(first).not.toHaveAttribute("data-popup-open");
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    leave(second);
    enter(third);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Third");
    vi.runAllTimers();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Third");
    leave(third);
    enter(first);
    expect(screen.getByRole("tooltip")).toHaveTextContent("First");
  });

  it("replaces focus-opened tooltips on focus or hover without moving focus", () => {
    render(() => (
      <>
        <Example name="First" />
        <Example name="Second" />
      </>
    ));
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    keyboardFocus(first);
    keyboardFocus(second);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second");
    enter(first);
    expect(screen.getByRole("tooltip")).toHaveTextContent("First");
    expect(second).toHaveFocus();
    vi.runAllTimers();
    expect(screen.getByRole("tooltip")).toHaveTextContent("First");
  });

  it("replaces the current tooltip when a delayed tooltip opens", () => {
    render(() => (
      <>
        <Example name="First" closeDelay={1000} />
        <Example name="Second" openDelay={300} />
      </>
    ));
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    enter(first);
    leave(first);
    enter(second);
    vi.advanceTimersByTime(299);
    expect(screen.getByRole("tooltip")).toHaveTextContent("First");
    vi.advanceTimersByTime(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second");
    vi.runAllTimers();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second");
  });

  it("allows only one initially open tooltip", () => {
    const onOpenChange = vi.fn();
    render(() => (
      <>
        <Example name="First" defaultOpen onOpenChange={onOpenChange} />
        <Example name="Second" defaultOpen />
      </>
    ));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second");
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("suppresses a superseded controlled tooltip even if its owner ignores the close request", () => {
    const onOpenChange = vi.fn();
    const [open, setOpen] = createSignal(false);
    render(() => (
      <>
        <Example name="First" open onOpenChange={onOpenChange} />
        <Example name="Second" open={open()} />
      </>
    ));
    expect(screen.getByRole("tooltip")).toHaveTextContent("First");
    setOpen(true);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second");
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    setOpen(false);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("releases ownership on unmount without clearing another tooltip's ownership", () => {
    const onOpenChange = vi.fn();
    const first = render(() => <Example name="First" defaultOpen onOpenChange={onOpenChange} />);
    first.unmount();
    const second = render(() => <Example name="Second" defaultOpen />);
    expect(onOpenChange).not.toHaveBeenCalled();
    const third = render(() => <Example name="Third" defaultOpen />);
    second.unmount();
    render(() => <Example name="Fourth" defaultOpen />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Fourth");
    third.unmount();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Fourth");
  });

  it("opens the native popover after mounting in the portal", () => {
    const showPopover = vi
      .spyOn(HTMLElement.prototype, "showPopover")
      .mockImplementation(function (this: HTMLElement) {
        expect(this.isConnected).toBe(true);
        expect(this).toHaveAttribute("popover", "manual");
        this.style.display = "block";
      });
    const { container } = render(() => <Example defaultOpen />);
    expect(showPopover).toHaveBeenCalledOnce();
    expect(container).not.toContainElement(screen.getByRole("tooltip"));
  });
});
