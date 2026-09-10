import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  useContext,
} from "solid-js";
import type { ComponentProps, JSX, ParentProps, ValidComponent } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";

// TODO: This was a vibe coded copy of other tooltip implementations
// This should be rebuilt to work better with the tea style used in the rest of the app

const styles = stylex.create({
  content: {
    position: "fixed",
    inset: "auto",
    margin: 0,
    boxSizing: "border-box",
    width: "max-content",
    maxWidth: "calc(100vw - 24px)",
    maxHeight: "calc(100vh - 24px)",
    overflow: "auto",
    /* oxlint-disable stylex/valid-styles -- The validator does not yet support these CSS anchor-positioning properties. */
    positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
    positionVisibility: "anchors-visible",
  },
  top: {
    positionArea: "top",
    marginBottom: "var(--tooltip-gutter)",
  },
  right: {
    positionArea: "right",
    marginLeft: "var(--tooltip-gutter)",
  },
  bottom: {
    positionArea: "bottom",
    marginTop: "var(--tooltip-gutter)",
  },
  left: {
    positionArea: "left",
    marginRight: "var(--tooltip-gutter)",
  },
  /* oxlint-enable stylex/valid-styles */
});

export type TooltipProps = ParentProps<{
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  openDelay?: number;
  closeDelay?: number;
  placement?: "top" | "right" | "bottom" | "left";
  gutter?: number;
}>;

let dismissActiveTooltip: (() => void) | undefined;

const createTooltip = (props: TooltipProps) => {
  const id = `tooltip-${createUniqueId()}`;
  const [internalOpen, setInternalOpen] = createSignal(props.defaultOpen ?? false);
  const [trigger, setTrigger] = createSignal<HTMLElement>();
  const [content, setContent] = createSignal<HTMLElement>();
  const [active, setActive] = createSignal(false);
  const requestedOpen = () => props.open ?? internalOpen();
  const eligible = () => !props.disabled && trigger() !== undefined && requestedOpen();
  const open = () => eligible() && active();
  const hovered = new Set<HTMLElement>();
  let focused = false;
  let dismissed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const change = (value: boolean) => {
    cancel();
    if (value && eligible()) activate();
    if (value === requestedOpen()) return;
    setInternalOpen(value);
    props.onOpenChange?.(value);
  };
  const dismiss = () => {
    dismissed = true;
    change(false);
  };
  const supersede = () => {
    setActive(false);
    dismiss();
    focused = false;
    dismissed = hovered.size > 0;
  };
  const activate = () => {
    if (dismissActiveTooltip === supersede) return;
    const previous = dismissActiveTooltip;
    dismissActiveTooltip = supersede;
    previous?.();
    setActive(true);
  };
  const release = () => {
    if (dismissActiveTooltip === supersede) dismissActiveTooltip = undefined;
    setActive(false);
  };

  createEffect(on(eligible, (value) => (value ? activate() : release())));

  const update = (immediate = false) => {
    cancel();
    const active = hovered.size > 0 || focused;
    if (!active) dismissed = false;
    if (props.disabled || (active && dismissed) || active === open()) return;
    const delay = immediate ? 0 : active ? (props.openDelay ?? 0) : (props.closeDelay ?? 150);
    if (delay <= 0) change(active);
    else timer = setTimeout(() => change(active), delay);
  };
  const contains = (target: EventTarget | null) =>
    target instanceof Node && (trigger()?.contains(target) || content()?.contains(target));

  const listen = (element: HTMLElement, isTrigger = false) => {
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch" || element.matches(":disabled")) return;
      hovered.add(element);
      update();
    };
    const leave = () => {
      hovered.delete(element);
      if (dismissed) {
        dismissed = false;
        focused = false;
      }
      update();
    };
    const focus = () => {
      if (dismissed || !element.matches(":focus-visible")) return;
      focused = true;
      update(true);
    };
    const blur = (event: FocusEvent) => {
      focused = !!contains(event.relatedTarget);
      update();
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    if (isTrigger) {
      element.addEventListener("pointerdown", dismiss);
      element.addEventListener("click", dismiss);
    }
    onCleanup(() => {
      hovered.delete(element);
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", blur);
      if (isTrigger) {
        element.removeEventListener("pointerdown", dismiss);
        element.removeEventListener("click", dismiss);
      }
    });
  };

  createEffect<HTMLElement | undefined>((previous) => {
    const element = trigger();
    if (previous && !element) {
      focused = false;
      cancel();
      timer = setTimeout(() => change(false), 0);
    }
    if (element) listen(element, true);
    return element;
  });
  createEffect(() => {
    const element = content();
    if (element) listen(element);
  });
  createEffect(() => {
    if (props.disabled) change(false);
  });
  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || (!open() && timer === undefined))
        return;
      if (open()) event.preventDefault();
      dismiss();
    };
    const pointerdown = (event: PointerEvent) => {
      if ((open() || timer !== undefined) && !contains(event.target)) dismiss();
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", pointerdown);
    onCleanup(() => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", pointerdown);
    });
  });
  onCleanup(() => {
    cancel();
    release();
  });

  return {
    id,
    anchor: `--${id}`,
    open,
    setTrigger,
    setContent,
    placement: () => props.placement ?? "bottom",
    gutter: () => props.gutter ?? 8,
  };
};

const TooltipContext = createContext<ReturnType<typeof createTooltip>>();
const useTooltip = () => {
  const context = useContext(TooltipContext);
  if (!context) throw new Error("Tooltip components must be inside Tooltip.Root");
  return context;
};

const Root = (props: TooltipProps) => (
  <TooltipContext.Provider value={createTooltip(props)}>{props.children}</TooltipContext.Provider>
);

type PolymorphicProps<T extends ValidComponent> = { as?: T } & ComponentProps<T>;

const Trigger = <T extends ValidComponent = "button">(props: PolymorphicProps<T>) => {
  const tooltip = useTooltip();
  const [local, rest] = splitProps(props, ["as", "ref", "style", "aria-describedby"]);
  onCleanup(() => tooltip.setTrigger(undefined));

  return (
    <Dynamic
      component={local.as ?? "button"}
      type={local.as ? undefined : "button"}
      {...rest}
      ref={(node: HTMLElement) => {
        tooltip.setTrigger(node);
        if (typeof local.ref === "function") local.ref(node);
      }}
      style={
        typeof local.style === "string"
          ? `${local.style};anchor-name:${tooltip.anchor};`
          : { ...local.style, "anchor-name": tooltip.anchor }
      }
      aria-describedby={
        [local["aria-describedby"], tooltip.open() ? tooltip.id : undefined]
          .filter(Boolean)
          .join(" ") || undefined
      }
      data-popup-open={tooltip.open() ? "" : undefined}
    />
  );
};

const TooltipPortal = (props: ComponentProps<typeof Portal>) => <Portal {...props} />;

const Content = (props: JSX.HTMLAttributes<HTMLDivElement>) => {
  const tooltip = useTooltip();
  const [local, rest] = splitProps(props, ["ref", "class", "classList", "style"]);
  const attributes = () =>
    stylex.attrs(
      styles.content,
      tooltip.placement() === "top" && styles.top,
      tooltip.placement() === "right" && styles.right,
      tooltip.placement() === "bottom" && styles.bottom,
      tooltip.placement() === "left" && styles.left,
    );

  const Surface = () => {
    let element!: HTMLDivElement;
    onMount(() => {
      tooltip.setContent(element);
      element.showPopover();
    });
    onCleanup(() => tooltip.setContent(undefined));

    return (
      <div
        {...rest}
        ref={(node) => {
          element = node;
          if (typeof local.ref === "function") local.ref(node);
        }}
        id={tooltip.id}
        role="tooltip"
        popover="manual"
        class={[
          attributes().class,
          local.class,
          ...Object.entries(local.classList ?? {})
            .filter(([, enabled]) => enabled)
            .map(([name]) => name),
        ]
          .filter(Boolean)
          .join(" ")}
        style={
          typeof local.style === "string"
            ? `${local.style};position-anchor:${tooltip.anchor};--tooltip-gutter:${tooltip.gutter()}px;`
            : {
              ...local.style,
              "position-anchor": tooltip.anchor,
              "--tooltip-gutter": `${tooltip.gutter()}px`,
            }
        }
        data-placement={tooltip.placement()}
      />
    );
  };

  return (
    <Show when={tooltip.open()}>
      <Surface />
    </Show>
  );
};

export const Tooltip = Object.assign(Root, { Root, Trigger, Portal: TooltipPortal, Content });
