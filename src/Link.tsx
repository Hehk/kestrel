import { forwardRef } from "react";
import * as Router from "./router";
import * as Model from "./model";

type LinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to: Router.LinkRoute;
  replace?: boolean;
};

const shouldLetBrowserHandleClick = (
  event: React.MouseEvent<HTMLAnchorElement>,
  target: React.HTMLAttributeAnchorTarget | undefined,
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

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { to, replace = false, onClick, target, download, ...props },
  ref,
) {
  const href = Router.fromRoute(to);

  return (
    <a
      {...props}
      ref={ref}
      href={href}
      target={target}
      download={download}
      onClick={(event) => {
        onClick?.(event);

        if (shouldLetBrowserHandleClick(event, target, download)) {
          return;
        }

        event.preventDefault();

        Model.send({ kind: "RouteRequested", route: to, replace });
      }}
    />
  );
});
