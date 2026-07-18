import type { ComponentProps } from "solid-js";
import { splitProps } from "solid-js";
import * as Router from "./router";
import * as Model from "./model";

type LinkProps = Omit<ComponentProps<"a">, "download" | "href"> & {
  download?: boolean | string;
  to: Router.ProtectedRoute;
  replace?: boolean;
};

const shouldLetBrowserHandleClick = (
  event: MouseEvent,
  target: ComponentProps<"a">["target"],
  download: unknown,
): boolean => {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey ||
    download != null ||
    (target != null && target !== "_self")
  );
};

export const Link = (props: LinkProps) => {
  const [local, anchorProps] = splitProps(props, [
    "to",
    "replace",
    "onClick",
    "target",
    "download",
    "ref",
  ]);

  return (
    <a
      {...anchorProps}
      ref={local.ref}
      href={Router.fromRoute(local.to)}
      target={local.target}
      download={local.download === true ? "" : local.download || undefined}
      on:click={(event) => {
        if (typeof local.onClick === "function") {
          local.onClick(event);
        }

        if (shouldLetBrowserHandleClick(event, local.target, local.download)) {
          return;
        }

        event.preventDefault();

        Model.send({ kind: "RouteRequested", route: local.to, replace: local.replace ?? false });
      }}
    />
  );
};
